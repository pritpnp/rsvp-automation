// Restore archived RSVPs back into the live rsvps table and re-append to
// the Google Sheet. Built specifically to undo the early-archive bug —
// cleanup-past-rsvps.js used to wipe RSVPs at midnight on event day
// instead of after the event. If that bug ever recurs, or if you need to
// pull a past event's RSVPs back temporarily for a re-check, hit this.
//
// POST /.netlify/functions/restore-rsvps with header x-admin-password and
// optional JSON body { zone: "bloomsburg", event_date: "2026-06-12" }.
// Defaults to all archived rows if no filter given.
//
// Idempotent within reason: we upsert into rsvps by id, so re-running the
// same restore won't duplicate. The archive row IS deleted after a
// successful restore (the point is to move it back to live).

const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'responses';

async function appendBatchToSheet(rows) {
  const credsRaw = process.env.GOOG_SA_JSON;
  if (!credsRaw || !SHEET_ID) {
    throw new Error('Google Sheets env vars missing (GOOG_SA_JSON / GOOGLE_SHEET_ID)');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credsRaw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:E`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
}

async function fetchExistingSheetRowIds() {
  const credsRaw = process.env.GOOG_SA_JSON;
  if (!credsRaw || !SHEET_ID) {
    throw new Error('Google Sheets env vars missing (GOOG_SA_JSON / GOOGLE_SHEET_ID)');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credsRaw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!E:E`
  });
  const rows = res.data.values || [];
  return new Set(rows.map(r => (r[0] || '').toString().trim()).filter(Boolean));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (event.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const zoneFilter = String(body.zone || '').trim();
  const dateFilter = String(body.event_date || '').trim();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let query = supabase
    .from('rsvps_archive')
    .select('id, zone, name, guests, event_name, submitted_at, sheet_row_id, event_date');
  if (zoneFilter) query = query.eq('zone', zoneFilter);
  if (dateFilter) query = query.eq('event_date', dateFilter);

  const { data: archived, error: readErr } = await query;
  if (readErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Read failed: ' + readErr.message }) };
  }
  if (!archived || archived.length === 0) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, restored: 0, note: 'Nothing in archive matched the filter.' }) };
  }

  // Step 1: Insert back into rsvps (upsert by id so re-runs don't duplicate).
  const restoreRows = archived.map(r => ({
    id:           r.id,
    zone:         r.zone,
    name:         r.name,
    guests:       r.guests,
    event_name:   r.event_name,
    submitted_at: r.submitted_at,
    sheet_row_id: r.sheet_row_id
  }));
  const { error: insertErr } = await supabase
    .from('rsvps')
    .upsert(restoreRows, { onConflict: 'id' });
  if (insertErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Restore insert failed: ' + insertErr.message }) };
  }

  // Step 2: Re-append to Sheet so the get-rsvps Sheet merge + summary
  // scripts still see them. Best-effort: a Sheet failure here doesn't
  // mean we lose data (it's in rsvps), it just means the sync-check
  // will flag drift until manually reconciled.
  let sheetRestored = 0;
  try {
    // Dedup against column E so re-runs (or rows that were never removed
    // from the Sheet during archive) don't create duplicate Sheet rows.
    // Mirrors the pattern in backfill-rsvps.js.
    const existingSheetIds = await fetchExistingSheetRowIds();
    const sheetRows = archived
      .filter(r => !existingSheetIds.has(String(r.sheet_row_id || r.id)))
      .map(r => [
        r.zone,
        r.name,
        String(r.guests),
        r.submitted_at
          ? new Date(r.submitted_at).toLocaleString('en-US', { timeZone: 'America/New_York' })
          : new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
        r.sheet_row_id || r.id
      ]);
    if (sheetRows.length > 0) {
      await appendBatchToSheet(sheetRows);
    }
    sheetRestored = sheetRows.length;
  } catch (e) {
    console.warn('Sheet re-append failed:', e.message);
  }

  // Step 3: Remove the rows from rsvps_archive — they're back in active
  // rsvps now, and we don't want the next legitimate cleanup to find
  // duplicates between the two tables.
  const ids = archived.map(r => r.id);
  const { error: delErr } = await supabase
    .from('rsvps_archive')
    .delete()
    .in('id', ids);
  if (delErr) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Restored to rsvps but failed to clear archive: ' + delErr.message,
        restored: archived.length,
        sheet_restored: sheetRestored,
        archive_cleanup: 'manual_needed'
      })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      restored: archived.length,
      sheet_restored: sheetRestored,
      zones: [...new Set(archived.map(r => r.zone))],
      event_dates: [...new Set(archived.map(r => r.event_date))]
    })
  };
};
