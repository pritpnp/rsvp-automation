const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const crypto = require('crypto');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'responses';

// Best-effort append to the same Google Sheet the Power Automate flow
// targets today, so the existing get-rsvps admin view keeps working
// without any migration. Columns match the existing schema:
//   A: zone, B: name, C: guests, D: submitted, E: sheet_row_id
async function appendToSheet(row) {
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
    requestBody: { values: [row] }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const zone      = String(body.zone || '').trim();
  const name      = String(body.name || '').trim();
  const eventName = String(body.eventName || '').trim();
  const phoneRaw  = String(body.phone || '').trim();
  const guests    = Math.max(1, parseInt(body.guests, 10) || 1);

  if (!zone || !name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name is required.' }) };
  }
  if (guests > 100) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Guest count is too high — please contact the organizer directly.' }) };
  }

  // Phone is optional. If provided, validate it normalizes to 10 digits so we
  // don't store garbage that won't dedup. Reject if user typed something but
  // it isn't a real phone number — don't silently drop it.
  let phone = '';
  if (phoneRaw) {
    const digits = phoneRaw.replace(/\D+/g, '');
    const normalized = (digits.length === 11 && digits.startsWith('1')) ? digits.slice(1) : digits;
    if (normalized.length !== 10) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Phone number looks invalid. Leave blank if you prefer not to share.' }) };
    }
    phone = phoneRaw;  // store as the user typed it; dedup logic normalizes
  }

  // IP from Netlify's edge headers. Falls through to x-forwarded-for for
  // local dev / curl tests. 'unknown' as a last resort so the column is
  // never null (queries get simpler).
  const ip = event.headers['x-nf-client-connection-ip']
          || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || event.headers['client-ip']
          || 'unknown';

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Honor the admin's RSVP on/off toggle. Same logic the rendered page
  // uses, but enforced server-side so a stale tab can't slip submissions
  // through after RSVPs are closed.
  const { data: settings } = await supabase
    .from('rsvp_settings')
    .select('zone, enabled')
    .in('zone', ['global', zone]);

  const globalEnabled = settings?.find(s => s.zone === 'global')?.enabled !== false;
  const zoneEnabled   = settings?.find(s => s.zone === zone)?.enabled    !== false;
  if (!globalEnabled || !zoneEnabled) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'RSVPs are currently closed for this event.' }) };
  }

  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();

  // Supabase write is the source of truth. If this fails, the RSVP is
  // genuinely lost — return an error so the user can retry.
  const { error: dbError } = await supabase
    .from('rsvps')
    .insert([{
      id,
      zone,
      name,
      guests,
      event_name: eventName,
      submitted_at: submittedAt,
      sheet_row_id: id,
      phone,
      ip
    }]);

  if (dbError) {
    console.error('Supabase RSVP insert failed:', dbError);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save your RSVP. Please try again.' }) };
  }

  // Best-effort: keep the legacy Google Sheet in sync so the existing
  // admin view (get-rsvps.js) shows new RSVPs alongside historical ones
  // until Phase 3 cuts admin reads over to Supabase. We don't fail the
  // user if Sheets is unreachable — they'd just see the RSVP missing
  // from the admin Sheet view, while Supabase still has it.
  const sheetTimestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  try {
    await appendToSheet([zone, name, String(guests), sheetTimestamp, id]);
  } catch (e) {
    console.error('Sheet append failed (Supabase write succeeded):', e.message);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id }) };
};
