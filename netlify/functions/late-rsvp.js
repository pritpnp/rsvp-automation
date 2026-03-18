const { google } = require('googleapis');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  const { name, guests, zone, eventName } = body;
  if (!name || !guests || !zone) return { statusCode: 400, body: 'Missing required fields' };

  const results = await Promise.allSettled([
    writeToSheet(name, guests, zone),
    sendTelegram(name, guests, zone, eventName)
  ]);

  const sheetOk = results[0].status === 'fulfilled';
  const telegramOk = results[1].status === 'fulfilled';

  if (!sheetOk) console.error('Sheet write failed:', results[0].reason);
  if (!telegramOk) console.error('Telegram failed:', results[1].reason);

  return sheetOk || telegramOk
    ? { statusCode: 200, body: 'ok' }
    : { statusCode: 500, body: 'Failed' };
};

async function writeToSheet(name, guests, zone) {
  const creds = JSON.parse(process.env.GOOG_SA_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const submitted = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const powerappsId = 'late-' + Date.now();

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'responses!A:E',
    valueInputOption: 'RAW',
    requestBody: { values: [[zone, name, guests, submitted, powerappsId]] }
  });
}

async function sendTelegram(name, guests, zone, eventName) {
  const text = `⚠️ Late RSVP Request\n🏛 ${zone} — ${eventName || 'Para Satsang Sabha'}\n👤 ${name}\n👥 Guests: ${guests}`;
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text })
  });
  if (!res.ok) throw new Error('Telegram failed');
}