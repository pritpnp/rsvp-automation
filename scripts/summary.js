const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TARGET_ZONE = process.env.TARGET_ZONE || 'all';
const TRIGGER_CHAT_ID = process.env.TRIGGER_CHAT_ID || '';
const TEST_MODE = process.env.TEST_MODE === 'true';
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Zone → Telegram group chat ID mapping
const ZONE_CHAT_IDS = {
  'scranton':     process.env.TELEGRAM_CHAT_ID_SCRANTON,
  'mountain-top': process.env.TELEGRAM_CHAT_ID_MOUNTAIN_TOP,
  'moosic':       process.env.TELEGRAM_CHAT_ID_MOOSIC,
  'bloomsburg':   process.env.TELEGRAM_CHAT_ID_BLOOMSBURG,
  'satsang-sabha': process.env.TELEGRAM_CHAT_ID_MANDIR,
  'mandir-1':     process.env.TELEGRAM_CHAT_ID_MANDIR,
  'mandir-2':     process.env.TELEGRAM_CHAT_ID_MANDIR,
  'mandir-3':     process.env.TELEGRAM_CHAT_ID_MANDIR,
  'mandir-4':     process.env.TELEGRAM_CHAT_ID_MANDIR,
  'mandir-5':     process.env.TELEGRAM_CHAT_ID_MANDIR,
};

// Zone display names
const ZONE_NAMES = {
  'scranton':      'Scranton',
  'mountain-top':  'Mountain Top',
  'moosic':        'Moosic',
  'bloomsburg':    'Bloomsburg',
  'satsang-sabha': 'Satsang Sabha',
  'mandir-1':      'Mandir 1',
  'mandir-2':      'Mandir 2',
  'mandir-3':      'Mandir 3',
  'mandir-4':      'Mandir 4',
  'mandir-5':      'Mandir 5',
};

function sendTelegram(chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function downloadCSV(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadCSV(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.replace(/"/g, '').trim());
    const row = {};
    headers.forEach((h, i) => row[h] = values[i] || '');
    return row;
  }).filter(row => row.zone);
}

function buildMessage(zone, rows, deadlines) {
  const info = deadlines[zone];
  if (!info) return null;
  const zoneName = ZONE_NAMES[zone] || zone;
  const totalGuests = rows.reduce((sum, r) => sum + (parseInt(r.guests) || 1), 0);
  let msg = `<b>${zoneName} — ${info.eventName}</b>\n`;
  msg += `📅 ${info.date} at ${info.time}\n`;
  msg += `⭐ Total Responses: ${rows.length} | Total Guests: ${totalGuests} ⭐\n\n`;
  if (rows.length === 0) {
    msg += 'No RSVPs yet.';
  } else {
    rows.forEach(r => {
      msg += `${r.name} — ${r.guests || 1} guest(s)\n`;
    });
  }
  return msg;
}

async function main() {
  const deadlines = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'deadlines.json'), 'utf8')
  );

  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
  const csv = await downloadCSV(csvUrl);
  const rows = parseCSV(csv);

  const today = new Date().toISOString().split('T')[0];

  // Determine which zones to process
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
      return info && info.deadline && info.deadline >= today;
    });
  }

  if (zonesToProcess.length === 0) {
    const noZoneMsg = 'No active zones found for the requested summary.';
    if (TRIGGER_CHAT_ID) await sendTelegram(TRIGGER_CHAT_ID, noZoneMsg);
    console.log('No active zones to summarize.');
    return;
  }

  // Group rows by zone
  const rowsByZone = {};
  rows.forEach(row => {
    if (!rowsByZone[row.zone]) rowsByZone[row.zone] = [];
    rowsByZone[row.zone].push(row);
  });

  const isScheduled = !TRIGGER_CHAT_ID;
  const triggeredFromAdmin = TRIGGER_CHAT_ID === ADMIN_CHAT_ID;
  const triggeredFromZone = TRIGGER_CHAT_ID && TRIGGER_CHAT_ID !== ADMIN_CHAT_ID;

  for (const zone of zonesToProcess) {
    const zoneRows = rowsByZone[zone] || [];
    const msg = buildMessage(zone, zoneRows, deadlines);
    if (!msg) continue;

    const zoneChatId = ZONE_CHAT_IDS[zone];

    if (isScheduled) {
      // Scheduled run: send to each zone's group only
      if (zoneChatId) {
        await sendTelegram(zoneChatId, msg);
        console.log(`Sent summary for ${zone} to zone group.`);
      }
    } else if (triggeredFromAdmin) {
      // Admin triggered: send to admin chat only
      await sendTelegram(ADMIN_CHAT_ID, msg);
      console.log(`Sent summary for ${zone} to admin.`);
    } else if (triggeredFromZone) {
      // Zone group triggered: send to zone group + admin
      if (zoneChatId) await sendTelegram(zoneChatId, msg);
      await sendTelegram(ADMIN_CHAT_ID, msg);
      console.log(`Sent summary for ${zone} to zone group + admin.`);
    }
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
