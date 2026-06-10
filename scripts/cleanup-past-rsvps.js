// Event-night RSVP cleanup. Mirrors the Google Apps Script that already
// runs at 11 PM on event day for the Sheet, so Supabase doesn't drift out
// of sync after the event ends. Runs from .github/workflows/cleanup-past-rsvps.yml
// on a dual UTC cron (3 AM / 4 AM) — one of which is 11 PM America/New_York
// depending on whether DST is active. The script computes today's date in
// NY time, finds zones whose eventDate is in the past (inclusive of today),
// and deletes their RSVPs from both stores.
//
// Semantics:
//   - "the night of the event" means same-day cleanup, so an event on
//     Sat 14 has its RSVPs cleaned by 11 PM Sat / midnight Sun.
//   - Late-running firings (eventDate < today) clean up any zone that was
//     missed by an outage on its actual event day.
//   - Re-runs are idempotent — deleting from an already-empty zone is a
//     no-op and stays silent on Telegram.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'responses';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

function todayInNY() {
  // en-CA locale returns YYYY-MM-DD, matching the format eventDate uses.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function loadDeadlines() {
  const p = path.join(__dirname, '..', 'deadlines.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function sheetsClient() {
  const credsRaw = process.env.GOOG_SA_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credsRaw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function deleteSheetRowsForZones(sheets, zoneSet) {
  // Pull rows, find indexes for matching zones, deleteDimension bottom-up
  // so each delete doesn't shift the indexes of pending ones.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:E`
  });
  const rows = res.data.values || [];
  const hasHeader = rows[0]?.[0]?.toLowerCase() === 'zone';
  const offset = hasHeader ? 1 : 0;
  const toDelete = [];
  for (let i = offset; i < rows.length; i++) {
    const zone = (rows[i][0] || '').toString().trim();
    if (zoneSet.has(zone)) toDelete.push(i);
  }
  if (!toDelete.length) return 0;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_TAB);
  const sheetId = sheet.properties.sheetId;

  // Delete from the bottom up so earlier indexes stay valid.
  const requests = toDelete
    .sort((a, b) => b - a)
    .map(rowIndex => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 }
      }
    }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests }
  });
  return toDelete.length;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('Telegram env vars missing — would have sent:\n' + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram send failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

async function main() {
  const today = todayInNY();
  console.log(`🕚 Cleanup check — today in America/New_York: ${today}`);

  const deadlines = loadDeadlines();
  const zonesToClean = [];
  for (const [zone, info] of Object.entries(deadlines)) {
    if (!info?.eventDate) continue;
    if (info.eventDate <= today) zonesToClean.push({ zone, eventDate: info.eventDate, eventName: info.eventName });
  }

  if (!zonesToClean.length) {
    console.log('✅ No zones with past or current event date — nothing to clean.');
    return;
  }

  console.log(`🎯 Candidate zones: ${zonesToClean.map(z => `${z.zone}(${z.eventDate})`).join(', ')}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Count what's in each zone before deleting, so the Telegram summary is
  // informative — and so we know whether to send a message at all.
  const zoneList = zonesToClean.map(z => z.zone);
  const { data: existingRows, error: countErr } = await supabase
    .from('rsvps')
    .select('zone, guests')
    .in('zone', zoneList);
  if (countErr) throw new Error('Supabase pre-count failed: ' + countErr.message);

  const counts = new Map(); // zone → { rsvps, guests }
  for (const r of (existingRows || [])) {
    if (!counts.has(r.zone)) counts.set(r.zone, { rsvps: 0, guests: 0 });
    const c = counts.get(r.zone);
    c.rsvps++;
    c.guests += parseInt(r.guests, 10) || 0;
  }

  if (counts.size === 0) {
    console.log('✅ Past-event zones are already clean in Supabase — no Telegram needed.');
    return;
  }

  // Supabase delete in a single query — Postgres handles all matches at once.
  const { error: delErr } = await supabase
    .from('rsvps')
    .delete()
    .in('zone', zoneList);
  if (delErr) throw new Error('Supabase delete failed: ' + delErr.message);
  console.log(`🗑️  Supabase: deleted ${[...counts.values()].reduce((a, c) => a + c.rsvps, 0)} rows.`);

  // Sheet best-effort — if it fails, sync-check will surface the drift in
  // its next 10-min window. Don't crash the cleanup over a Sheets blip.
  let sheetDeleted = -1;
  try {
    const sheets = await sheetsClient();
    sheetDeleted = await deleteSheetRowsForZones(sheets, new Set(zoneList));
    console.log(`🗑️  Sheet: deleted ${sheetDeleted} rows.`);
  } catch (e) {
    console.warn(`⚠️  Sheet delete failed: ${e.message}`);
  }

  // Telegram summary — one message, lists what we cleaned.
  const lines = ['🧹 <b>Event RSVP cleanup</b>', ''];
  for (const { zone, eventName, eventDate } of zonesToClean) {
    const c = counts.get(zone);
    if (!c) continue; // skipped — already empty
    const label = eventName ? `${zone} (${eventName})` : zone;
    lines.push(`• ${label} — ${c.rsvps} RSVPs / ${c.guests} guests · event was ${eventDate}`);
  }
  if (sheetDeleted >= 0) {
    lines.push('', `Sheet rows removed: ${sheetDeleted}`);
  } else {
    lines.push('', '⚠️ Sheet cleanup failed — see workflow logs. Sync check will flag the drift.');
  }
  await sendTelegram(lines.join('\n'));
  console.log('📲 Telegram summary sent.');
}

main().catch(err => {
  console.error('❌ Cleanup failed:', err.message);
  // Don't ping Telegram on infra errors — the workflow run is red in
  // GitHub which is enough signal, and we don't want to spam during
  // a Supabase/Sheets outage.
  process.exit(1);
});
