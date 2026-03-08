const https = require('https');
const fs = require('fs');
const path = require('path');

// Download file from URL
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function sendTelegram(token, chatId, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const ONEDRIVE_URL = process.env.ONEDRIVE_URL;
  const TEST_MODE = process.env.TEST_MODE === 'true';

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !ONEDRIVE_URL) {
    console.error('❌ Missing required environment variables');
    process.exit(1);
  }

  // Convert SharePoint share URL to direct download URL
  const base64 = Buffer.from(ONEDRIVE_URL).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const downloadUrl = `https://api.onedrive.com/v1.0/shares/u!${base64}/root/content`;

  console.log('📥 Downloading Excel file...');
  const xlsxPath = '/tmp/rsvp-deadlines.xlsx';
  await download(downloadUrl, xlsxPath);
  console.log('✅ Downloaded');

  // Parse Excel
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(xlsxPath);

  // Log available sheets
  console.log('📋 Sheets found:', workbook.SheetNames);

  // Read deadlines sheet (try Sheet1 and first sheet)
  const deadlinesSheetName = workbook.SheetNames.find(n => n.toLowerCase().includes('sheet1') || n.toLowerCase().includes('deadline')) || workbook.SheetNames[0];
  const deadlinesSheet = workbook.Sheets[deadlinesSheetName];
  const deadlines = XLSX.utils.sheet_to_json(deadlinesSheet);
  console.log(`📊 Deadlines sheet: "${deadlinesSheetName}" — ${deadlines.length} rows`);
  if (deadlines.length > 0) console.log('📊 First row keys:', Object.keys(deadlines[0]));

  // Read responses sheet
  const responsesSheetName = workbook.SheetNames.find(n => n.toLowerCase().includes('response')) || workbook.SheetNames[1];
  const responsesSheet = workbook.Sheets[responsesSheetName];
  const responses = responsesSheet ? XLSX.utils.sheet_to_json(responsesSheet) : [];
  console.log(`📊 Responses sheet: "${responsesSheetName}" — ${responses.length} rows`);

  const today = new Date().toISOString().split('T')[0];
  console.log(`📅 Today: ${today} | TEST_MODE: ${TEST_MODE}`);

  let summariesSent = 0;

  for (const row of deadlines) {
    const zone = row['zone'];
    const deadline = row['deadline'];
    const eventName = row['eventName'] || 'Para Satsang Sabha';

    if (!zone || !deadline) continue;

    // Normalize deadline to YYYY-MM-DD
    let deadlineStr = deadline;
    if (typeof deadline === 'number') {
      // Excel serial date
      const date = XLSX.SSF.parse_date_code(deadline);
      deadlineStr = `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
    }

    const matches = TEST_MODE || deadlineStr === today;
    if (!matches) {
      console.log(`⏭ Skipping ${zone} (deadline: ${deadlineStr})`);
      continue;
    }

    console.log(`📊 Building summary for ${zone}...`);

    // Filter responses for this zone
    const zoneResponses = responses.filter(r => r['zone'] === zone);

    if (zoneResponses.length === 0) {
      const message = `🏛 <b>${zone.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Zone — ${eventName}</b>\n\n📭 No RSVPs received.`;
      await sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);
      summariesSent++;
      continue;
    }

    let totalGuests = 0;
    let lines = '';
    for (const r of zoneResponses) {
      const guests = parseInt(r['guests']) || 0;
      totalGuests += guests;
      lines += `${r['name']} — ${guests}\n`;
    }

    const zoneName = zone.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const message = `🏛 <b>${zoneName} Zone — ${eventName}</b>\n\nTotal Responses: ${zoneResponses.length} | Total Guests: ${totalGuests}\n\n${lines.trim()}`;

    console.log(`📤 Sending summary for ${zone}...`);
    const result = await sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);
    if (result.ok) {
      console.log(`✅ Summary sent for ${zone}`);
      summariesSent++;
    } else {
      console.error(`❌ Failed for ${zone}:`, result);
    }
  }

  if (summariesSent === 0) {
    console.log('ℹ️ No deadlines matched today — no summaries sent');
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
