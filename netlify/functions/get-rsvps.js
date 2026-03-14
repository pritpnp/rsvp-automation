const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'responses';

async function authenticate() {
  const creds = JSON.parse(process.env.GOOG_SA_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return auth;
}

async function authCheck(event) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const adminPassword = event.headers['x-admin-password'];
  const managerToken = event.headers['x-manager-token'];
  if (adminPassword === process.env.ADMIN_PASSWORD) return true;
  if (managerToken) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('expires_at')
      .eq('token', managerToken)
      .single();
    if (session && new Date(session.expires_at) > new Date()) return true;
  }
  return false;
}

async function getRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:E`
  });
  return res.data.values || [];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const authed = await authCheck(event);
  if (!authed) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const auth = await authenticate();
  const sheets = google.sheets({ version: 'v4', auth });

  // GET — fetch all RSVPs
  if (event.httpMethod === 'GET') {
    const rows = await getRows(sheets);
    const dataRows = rows[0]?.[0]?.toLowerCase() === 'zone' ? rows.slice(1) : rows;
    const rsvps = dataRows
      .filter(r => r.length >= 3)
      .map(r => ({
        zone: r[0] || '',
        name: r[1] || '',
        guests: r[2] || '1',
        submitted: r[3] || '',
        powerapps_id: r[4] || ''
      }));
    return { statusCode: 200, headers, body: JSON.stringify(rsvps) };
  }

  // PATCH — update guests count for a row
  if (event.httpMethod === 'PATCH') {
    const { powerapps_id, guests } = JSON.parse(event.body);
    if (!powerapps_id || guests === undefined) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    const rows = await getRows(sheets);
    const rowIndex = rows.findIndex(r => r[4] === powerapps_id);
    if (rowIndex === -1) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Row not found' }) };

    // Update guests column (column C = index 2, 1-based row = rowIndex + 1)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!C${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[String(guests)]] }
    });
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // DELETE — remove a row
  if (event.httpMethod === 'DELETE') {
    const { powerapps_id } = JSON.parse(event.body);
    if (!powerapps_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const rows = await getRows(sheets);
    const rowIndex = rows.findIndex(r => r[4] === powerapps_id);
    if (rowIndex === -1) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Row not found' }) };

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
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
