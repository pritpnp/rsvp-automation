const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Proven download function (handles Google Sheets redirect chain) ───────────
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

// ─── Telegram sender ───────────────────────────────────────────────────────────
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

// ─── Zone → group chat ID mapping ─────────────────────────────────────────────
function getZoneChatIds() {
  return {
    'scranton':      process.env.TELEGRAM_CHAT_ID_SCRANTON,
    'mountain-top':  process.env.TELEGRAM_CHAT_ID_MOUNTAIN_TOP,
    'moosic':        process.env.TELEGRAM_CHAT_ID_MOOSIC,
    'bloomsburg':    process.env.TELEGRAM_CHAT_ID_BLOOMSBURG,
    'satsang-sabha': process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-1':      process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-2':      process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-3':      process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-4':      process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-5':      process.env.TELEGRAM_CHAT_ID_MANDIR,
  };
}

async function main() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const ADMIN_CHAT_ID      = process.env.TELEGRAM_CHAT_ID;
  const TARGET_ZONE        = process.env.TARGET_ZONE || 'all';
  const TRIGGER_CHAT_ID    = process.env.TRIGGER_CHAT_ID || '';
  const TEST_MODE          = process.env.TEST_MODE === 'true';
  const SHEET_ID           = process.env.GOOGLE_SHEET_ID;

  if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.error('Missing required environment variables');
    process.exit(1);
  }

  // Load deadlines.json
  const deadlinesPath = path.join(__dirname, '..', 'deadlines.json');
  if (!fs.existsSync(deadlinesPath)) {
    console.log('No deadlines.json found — nothing to do');
    process.exit(0);
  }
  const deadlines = JSON.parse(fs.readFileSync(deadlinesPath, 'utf8'));
  console.log('Deadlines loaded:', JSON.stringify(deadlines, null, 2));

  // Download CSV from Google Sheets
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
  console.log(`${responses.length} responses loaded`);
  if (responses.length > 0) console.log('Sample row:', JSON.stringify(responses[0]));

  const today = new Date().toISOString().split('T')[0];
  console.log(`Today: ${today} | TARGET_ZONE: ${TARGET_ZONE} | TRIGGER_CHAT_ID: ${TRIGGER_CHAT_ID} | TEST_MODE: ${TEST_MODE}`);

  // Determine which zones to summarise
  let zonesToProcess;
  if (TARGET_ZONE === 'all') {
    zonesToProcess = Object.keys(deadlines);
  } else if (TARGET_ZONE === 'mandir') {
    zonesToProcess = ['satsang-sabha', 'mandir-1', 'mandir-2', 'mandir-3', 'mandir-4', 'mandir-5'];
  } else {
    zonesToProcess = [TARGET_ZONE];
  }

  // Filter to zones with future deadlines (unless TEST_MODE)
  if (!TEST_MODE) {
    zonesToProcess = zonesToProcess.filter(zone => {
      const info = deadlines[zone];
      return info && info.deadline && today <= info.deadline;
    });
  }

  console.log('Zones to process:', zonesToProcess);

  if (zonesToProcess.length === 0) {
    console.log('No active zones — nothing to send');
    if (TRIGGER_CHAT_ID) {
      await sendTelegram(TELEGRAM_BOT_TOKEN, TRIGGER_CHAT_ID, 'No active zones found for the requested summary.');
    }
    return;
  }

  const ZONE_CHAT_IDS = getZoneChatIds();
  const isScheduled        = !TRIGGER_CHAT_ID;
  const triggeredFromAdmin = TRIGGER_CHAT_ID === ADMIN_CHAT_ID;

  let summariesSent = 0;

  for (const zone of zonesToProcess) {
    const info = deadlines[zone];
    if (!info) continue;

    const { eventName, date, time } = info;
    const zoneResponses = responses.filter(r => String(r['zone']).trim() === zone);
    const zoneName = zone.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    console.log(`Zone ${zone}: ${zoneResponses.length} responses`);

    if (zoneResponses.length === 0) {
      console.log(`No RSVPs for ${zone} — skipping`);
      continue;
    }

    let totalGuests = 0;
    let listLines = '';
    for (const r of zoneResponses) {
      const guests = parseInt(r['guests']) || 0;
      totalGuests += guests;
      listLines += `${r['name']} - ${guests}\n`;
    }

    const message = `<b>${zoneName} — ${eventName}</b>\n📅 ${date} at ${time}\n\n⭐ <b><u>Total Responses: ${zoneResponses.length} | Total Guests: ${totalGuests}</u></b> ⭐\n\n${listLines.trim()}`;
    const zoneChatId = ZONE_CHAT_IDS[zone];

    if (isScheduled) {
      // Scheduled: send to zone group only
      if (zoneChatId) {
        const result = await sendTelegram(TELEGRAM_BOT_TOKEN, zoneChatId, message);
        console.log(`Scheduled send for ${zone} to zone group: ${result.ok ? 'OK' : JSON.stringify(result)}`);
        if (result.ok) summariesSent++;
      }
    } else if (triggeredFromAdmin) {
      // Admin triggered: send to admin only
      const result = await sendTelegram(TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, message);
      console.log(`Admin send for ${zone}: ${result.ok ? 'OK' : JSON.stringify(result)}`);
      if (result.ok) summariesSent++;
    } else {
      // Zone group triggered: send to zone group + admin
      const chatIds = new Set([ADMIN_CHAT_ID]);
      if (zoneChatId) chatIds.add(zoneChatId);
      for (const chatId of chatIds) {
        const result = await sendTelegram(TELEGRAM_BOT_TOKEN, chatId, message);
        console.log(`Zone-triggered send for ${zone} to ${chatId}: ${result.ok ? 'OK' : JSON.stringify(result)}`);
        if (result.ok) summariesSent++;
      }
    }
  }

  if (summariesSent === 0) {
    console.log('No summaries sent');
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
