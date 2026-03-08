const https = require('https');
const fs = require('fs');
const path = require('path');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const handleResponse = (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        fs.truncate(dest, 0, () => {});
        const redirectUrl = res.headers.location;
        const lib = redirectUrl.startsWith('https') ? https : require('http');
        lib.get(redirectUrl, handleResponse).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      const newFile = fs.createWriteStream(dest);
      res.pipe(newFile);
      newFile.on('finish', () => newFile.close(resolve));
    };
    https.get(url, handleResponse).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function sendTelegram(token, chatId, message) {
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
    req.setTimeout(10000, () => { req.destroy(new Error('Telegram request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const TEST_MODE = process.env.TEST_MODE === 'true';

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing required environment variables');
    process.exit(1);
  }

  // Read deadlines.json from repo
  const deadlinesPath = path.join(__dirname, '..', 'deadlines.json');
  if (!fs.existsSync(deadlinesPath)) {
    console.log('No deadlines.json found — nothing to do');
    process.exit(0);
  }
  const deadlines = JSON.parse(fs.readFileSync(deadlinesPath, 'utf8'));
  console.log('Deadlines loaded:', JSON.stringify(deadlines, null, 2));

  // Download responses from Google Sheet as CSV (no auth needed)
  const SHEET_ID = '1OaLLmNaBQJ8lLSw3Y6qReao6tbHsjC7ADX7fCTDyXCc';
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
  console.log('Downloading responses from Google Sheets...');
  const csvPath = '/tmp/responses.csv';
  await download(csvUrl, csvPath);
  console.log('Downloaded successfully');

  const csvText = fs.readFileSync(csvPath, 'utf8');
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const responses = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] || '');
    return row;
  });
  console.log(`${responses.length} responses found`);
  if (responses.length > 0) console.log('Sample row:', JSON.stringify(responses[0]));

  const today = new Date().toISOString().split('T')[0];
  console.log(`Today: ${today} | TEST_MODE: ${TEST_MODE}`);

  let summariesSent = 0;

  for (const [zone, info] of Object.entries(deadlines)) {
    const { deadline, eventName } = info;
    if (!deadline) continue;

    // Send if TEST_MODE, or if today is between when the flyer was posted and the deadline
    const pastDeadline = deadline && today > deadline;
    if (!TEST_MODE && pastDeadline) {
      console.log(`Skipping ${zone} — deadline ${deadline} has passed`);
      continue;
    }
    if (!TEST_MODE && !deadline) {
      console.log(`Skipping ${zone} — no deadline set`);
      continue;
    }

    console.log(`Building summary for ${zone}...`);
    const zoneResponses = responses.filter(r => String(r['zone']).trim() === zone);
    const zoneName = zone.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    if (zoneResponses.length === 0) {
      console.log(`No RSVPs for ${zone} — skipping`);
      continue;
    }

    let totalGuests = 0;
    let lines = '';
    for (const r of zoneResponses) {
      const guests = parseInt(r['guests']) || 0;
      totalGuests += guests;
      lines += `${r['name']} - ${guests}\n`;
    }

    const message = `<b>${zoneName} Zone - ${eventName}</b>\n\n⭐ <b><u>Total Responses: ${zoneResponses.length} | Total Guests: ${totalGuests}</u></b> ⭐\n\n${lines.trim()}`;
    console.log(`Sending summary for ${zone}...`);
    const result = await sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);
    if (result.ok) {
      console.log(`Summary sent for ${zone}`);
      summariesSent++;
    } else {
      console.error(`Failed for ${zone}:`, JSON.stringify(result));
    }
  }

  if (summariesSent === 0) {
    console.log('No deadlines matched today - no summaries sent');
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
