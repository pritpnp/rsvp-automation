const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'responses';

// One-shot Phase 3 migration: copies historical Google Sheet RSVPs into the
// Supabase rsvps table. Idempotent — safe to re-run; rows already present
// (identified by the original Power Apps ID stored in sheet_row_id) are
// skipped. After this runs and reports 0 inserted, the Sheet is no longer
// a meaningful read source — every row has a Supabase counterpart.
//
// Requires the admin password (x-admin-password header). Not exposed to
// managers — this is a one-time superadmin operation.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed. POST only.' }) };
  }

  if (event.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Superadmin password required' }) };
  }

  if (!process.env.GOOG_SA_JSON || !SHEET_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Google Sheets env vars missing' }) };
  }

  // Pull every row from the Sheet.
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOG_SA_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:E`
  });
  const rows = sheetRes.data.values || [];
  const dataRows = rows[0]?.[0]?.toLowerCase() === 'zone' ? rows.slice(1) : rows;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Get every sheet_row_id already in Supabase so we can dedup in one pass.
  const { data: existing, error: existingErr } = await supabase
    .from('rsvps')
    .select('sheet_row_id');
  if (existingErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load existing rsvps: ' + existingErr.message }) };
  }
  const alreadyHave = new Set((existing || []).map(r => r.sheet_row_id).filter(Boolean));

  let inserted = 0;
  let skippedAlready = 0;
  let skippedNoId = 0;
  let skippedBadData = 0;
  let failed = 0;
  const errors = [];

  for (const r of dataRows) {
    const zone         = (r[0] || '').toString().trim();
    const name         = (r[1] || '').toString().trim();
    const guestsRaw    = (r[2] || '').toString().trim();
    const submittedRaw = (r[3] || '').toString().trim();
    const sheetId      = (r[4] || '').toString().trim();

    if (!sheetId) { skippedNoId++; continue; }
    if (alreadyHave.has(sheetId)) { skippedAlready++; continue; }
    if (!zone || !name) { skippedBadData++; continue; }

    const guests = Math.max(1, parseInt(guestsRaw, 10) || 1);

    // Try to parse the timestamp. Power Automate wrote something like
    // "6/12/2026 8:32:15 PM" — JS Date handles that on most runtimes.
    // Fall back to now() if it's unparseable so we don't lose the row.
    let submittedAt;
    const parsed = submittedRaw ? new Date(submittedRaw) : null;
    if (parsed && !isNaN(parsed.getTime())) {
      submittedAt = parsed.toISOString();
    } else {
      submittedAt = new Date().toISOString();
    }

    const id = crypto.randomUUID();
    const { error: insertErr } = await supabase
      .from('rsvps')
      .insert([{
        id,
        zone,
        name,
        guests,
        submitted_at: submittedAt,
        sheet_row_id: sheetId  // preserve original PA ID for cross-store lookup
      }]);
    if (insertErr) {
      failed++;
      if (errors.length < 10) errors.push({ sheet_row_id: sheetId, error: insertErr.message });
    } else {
      inserted++;
      alreadyHave.add(sheetId);
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      total_sheet_rows: dataRows.length,
      inserted,
      skipped_already_in_supabase: skippedAlready,
      skipped_missing_sheet_id: skippedNoId,
      skipped_bad_data: skippedBadData,
      failed,
      sample_errors: errors
    })
  };
};
