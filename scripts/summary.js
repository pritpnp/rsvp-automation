const https = require('https');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const handleResponse = (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        https.get(res.headers.location, handleResponse).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
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

  // Download responses Excel from OneDrive
  // SharePoint share URLs need to be converted to direct download
  // Replace the ?e=xxx with download=1
  let downloadUrl = ONEDRIVE_URL;
  if (downloadUrl.includes('sharepoint.com') || downloadUrl.includes('1drv.ms')) {
    // Convert SharePoint share URL to download URL
    downloadUrl = downloadUrl.replace('/:x:/g/', '/:x:/r/').split('?')[0] + '?download=1';
  }
  console.log('Download URL:', downloadUrl);

  console.log('Downloading Excel responses...');
  const xlsxPath = '/tmp/rsvp-deadlines.xlsx';
  await download(downloadUrl, xlsxPath);
  console.log('Downloaded successfully');

  const workbook = XLSX.readFile(xlsxPath);
  console.log('Sheets found:', workbook.SheetNames);

  const responsesSheetName = workbook.SheetNames.find(n => n.toLowerCase().includes('response'));
  const responses = responsesSheetName
    ? XLSX.utils.sheet_to_json(workbook.Sheets[responsesSheetName], { defval: '' })
    : [];
  console.log(`${responses.length} responses found`);
  if (responses.length > 0) console.log('Sample row:', JSON.stringify(responses[0]));

  const today = new Date().toISOString().split('T')[0];
  console.log(`Today: ${today} | TEST_MODE: ${TEST_MODE}`);

  let summariesSent = 0;

  for (const [zone, info] of Object.entries(deadlines)) {
    const { deadline, eventName } = info;
    if (!deadline) continue;

    const matches = TEST_MODE || deadline === today;
    if (!matches) {
      console.log(`Skipping ${zone} (deadline: ${deadline})`);
      continue;
    }

    console.log(`Building summary for ${zone}...`);
    const zoneResponses = responses.filter(r => String(r['zone']).trim() === zone);
    const zoneName = zone.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    if (zoneResponses.length === 0) {
      const message = `<b>${zoneName} Zone - ${eventName}</b>\n\nNo RSVPs received.`;
      await sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);
      summariesSent++;
      continue;
    }

    let totalGuests = 0;
    let lines = '';
    for (const r of zoneResponses) {
      const guests = parseInt(r['guests']) || 0;
      totalGuests += guests;
      lines += `${r['name']} - ${guests}\n`;
    }

    const message = `<b>${zoneName} Zone - ${eventName}</b>\n\nTotal Responses: ${zoneResponses.length} | Total Guests: ${totalGuests}\n\n${lines.trim()}`;
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

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
