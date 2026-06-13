const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'responses';

// Sheets is the legacy backing store. Supabase rsvps is the new source of
// truth. During the transition (Phase 3) we:
//   - read from Supabase first, then merge in any Sheet rows that aren't in
//     Supabase (historical rows not yet backfilled);
//   - dual-write on PATCH/DELETE so the legacy view stays accurate even if
//     someone bypasses this layer to read the Sheet directly;
//   - identify the same row across both stores by its sheet_row_id.

async function authenticateSheets() {
  const credsRaw = process.env.GOOG_SA_JSON;
  if (!credsRaw) throw new Error('GOOG_SA_JSON not set');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credsRaw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return auth;
}

async function authCheck(event) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
  const adminPassword = event.headers['x-admin-password'];
  const managerToken = event.headers['x-manager-token'];
  if (adminPassword === process.env.ADMIN_PASSWORD) {
    return { ok: true, permissions: { view_rsvps: true, edit_rsvps: true, delete_rsvps: true } };
  }
  if (managerToken) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', managerToken)
      .single();
    if (session && new Date(session.expires_at) > new Date()) {
      if (!session.manager_id) {
        return { ok: true, permissions: { view_rsvps: true, edit_rsvps: true, delete_rsvps: true } };
      }
      const { data: manager } = await supabase
        .from('managers')
        .select('permissions')
        .eq('id', session.manager_id)
        .single();
      return { ok: true, permissions: manager?.permissions || {} };
    }
  }
  return { ok: false };
}

async function getSheetRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:E`
  });
  return res.data.values || [];
}

function sheetRowToRsvp(r) {
  return {
    zone:         r[0] || '',
    name:         r[1] || '',
    guests:       r[2] || '1',
    submitted:    r[3] || '',
    powerapps_id: r[4] || ''
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const authResult = await authCheck(event);
  if (!authResult.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  const perms = authResult.permissions;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);

  // GET — Supabase primary, merge Sheet-only rows for historical visibility
  if (event.httpMethod === 'GET') {
    if (!perms.view_rsvps) return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to view RSVPs' }) };

    const { data: supabaseRows, error: dbErr } = await supabase
      .from('rsvps')
      .select('zone, name, guests, submitted_at, sheet_row_id')
      .order('submitted_at', { ascending: false });

    if (dbErr) {
      console.error('Supabase read failed:', dbErr);
      // Don't fall through silently — surface the error rather than show
      // partial data that could mislead a manager. (Sheet-only fallback
      // would be confusing.)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load RSVPs from Supabase: ' + dbErr.message }) };
    }

    const supabaseSeen = new Set((supabaseRows || []).map(r => r.sheet_row_id).filter(Boolean));
    const fromSupabase = (supabaseRows || []).map(r => ({
      zone:         r.zone,
      name:         r.name,
      guests:       String(r.guests),
      submitted:    r.submitted_at || '',
      powerapps_id: r.sheet_row_id || ''
    }));

    // Best-effort merge with Sheet — pulls in historical rows that haven't
    // been backfilled yet. If Sheets is unreachable we still return the
    // Supabase set rather than 500.
    let fromSheetOnly = [];
    try {
      const auth = await authenticateSheets();
      const sheets = google.sheets({ version: 'v4', auth });
      const rows = await getSheetRows(sheets);
      const dataRows = rows[0]?.[0]?.toLowerCase() === 'zone' ? rows.slice(1) : rows;
      fromSheetOnly = dataRows
        .filter(r => r.length >= 3 && r[4] && !supabaseSeen.has(r[4]))
        .map(sheetRowToRsvp);
    } catch (e) {
      console.warn('Sheet merge skipped:', e.message);
    }

    // Concat: Supabase rows (already newest-first) + Sheet-only legacy rows.
    return { statusCode: 200, headers, body: JSON.stringify(fromSupabase.concat(fromSheetOnly)) };
  }

  // PATCH — update guest count. Dual-write Supabase + Sheet.
  if (event.httpMethod === 'PATCH') {
    if (!perms.edit_rsvps) return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to edit RSVPs' }) };
    const { powerapps_id, guests } = JSON.parse(event.body);
    if (!powerapps_id || guests === undefined) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    const newGuests = parseInt(guests, 10);
    if (!Number.isFinite(newGuests) || newGuests < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Guest count must be at least 1' }) };
    }

    // Supabase first — by sheet_row_id (the cross-store key)
    const { error: dbErr } = await supabase
      .from('rsvps')
      .update({ guests: newGuests })
      .eq('sheet_row_id', powerapps_id);
    if (dbErr) console.warn('Supabase PATCH failed (continuing to Sheet):', dbErr.message);

    // Sheet best-effort
    try {
      const auth = await authenticateSheets();
      const sheets = google.sheets({ version: 'v4', auth });
      const rows = await getSheetRows(sheets);
      const rowIndex = rows.findIndex(r => r[4] === powerapps_id);
      if (rowIndex !== -1) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${SHEET_TAB}!C${rowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[String(newGuests)]] }
        });
      }
    } catch (e) {
      console.warn('Sheet PATCH skipped:', e.message);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // DELETE — remove row from Supabase + Sheet
  if (event.httpMethod === 'DELETE') {
    if (!perms.delete_rsvps) return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to delete RSVPs' }) };
    const { powerapps_id } = JSON.parse(event.body);
    if (!powerapps_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

    const { error: dbErr } = await supabase
      .from('rsvps')
      .delete()
      .eq('sheet_row_id', powerapps_id);
    if (dbErr) console.warn('Supabase DELETE failed (continuing to Sheet):', dbErr.message);

    try {
      const auth = await authenticateSheets();
      const sheets = google.sheets({ version: 'v4', auth });
      const rows = await getSheetRows(sheets);
      const rowIndex = rows.findIndex(r => r[4] === powerapps_id);
      if (rowIndex !== -1) {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
        const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_TAB);
        const sheetId = sheet.properties.sheetId;
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 }
              }
            }]
          }
        });
      }
    } catch (e) {
      console.warn('Sheet DELETE skipped:', e.message);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
