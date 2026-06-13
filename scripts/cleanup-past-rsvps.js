// Event-night RSVP cleanup — archive variant.
//
// Runs from .github/workflows/cleanup-past-rsvps.yml on a dual UTC cron
// (3 AM / 4 AM) so 11 PM America/New_York is covered year-round. For
// every zone whose eventDate is on or before today (in NY time), the
// script copies the active RSVP rows into rsvps_archive (preserving id,
// adding archived_at + event_date), then deletes them from rsvps and the
// Google Sheet. The admin view stays focused on upcoming events; the
// historical data lives in rsvps_archive for later lookup.
//
// Order matters: archive insert MUST succeed before delete runs. If the
// insert fails the rows are kept in rsvps and Telegram surfaces an alert
// so we don't quietly lose data.
//
// Re-runs are idempotent — archive uses upsert on the row id, and delete
// from an already-empty zone is a no-op.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'responses';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

function todayInNY() {
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
    // Strictly less-than: archive only AFTER the event day has passed.
    // The previous <= caused tonight's RSVPs to be wiped at midnight on
    // event day, before the event had even happened.
    if (info.eventDate < today) zonesToClean.push({ zone, eventDate: info.eventDate, eventName: info.eventName });
  }

  if (!zonesToClean.length) {
    console.log('✅ No zones with past or current event date — nothing to archive.');
    return;
  }

  console.log(`🎯 Candidate zones: ${zonesToClean.map(z => `${z.zone}(${z.eventDate})`).join(', ')}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const zoneList = zonesToClean.map(z => z.zone);
  const eventDateByZone = Object.fromEntries(zonesToClean.map(z => [z.zone, z.eventDate]));

  // Pull every row we're about to archive — we need the full record so we
  // can preserve id, name, etc. in the archive table.
  const { data: liveRows, error: readErr } = await supabase
    .from('rsvps')
    .select('id, zone, name, guests, event_name, submitted_at, sheet_row_id')
    .in('zone', zoneList);
  if (readErr) throw new Error('Supabase pre-read failed: ' + readErr.message);

  if (!liveRows || liveRows.length === 0) {
    console.log('✅ Past-event zones are already clean in Supabase — no Telegram needed.');
    return;
  }

  // Group counts by zone for the Telegram summary.
  const counts = new Map();
  for (const r of liveRows) {
    if (!counts.has(r.zone)) counts.set(r.zone, { rsvps: 0, guests: 0 });
    const c = counts.get(r.zone);
    c.rsvps++;
    c.guests += parseInt(r.guests, 10) || 0;
  }

  // ── Step 1: Archive ────────────────────────────────────────────────────
  // Upsert by id so a re-run after a partial failure doesn't double-write.
  const archivedAt = new Date().toISOString();
  const archiveRows = liveRows.map(r => ({
    id:           r.id,
    zone:         r.zone,
    name:         r.name,
    guests:       r.guests,
    event_name:   r.event_name,
    submitted_at: r.submitted_at,
    sheet_row_id: r.sheet_row_id,
    event_date:   eventDateByZone[r.zone] || '',
    archived_at:  archivedAt
  }));
  const { error: archiveErr } = await supabase
    .from('rsvps_archive')
    .upsert(archiveRows, { onConflict: 'id' });
  if (archiveErr) {
    // Don't proceed to delete — we'd lose data. Telegram so the failure
    // is visible immediately instead of getting buried in workflow logs.
    await sendTelegram(`⚠️ <b>RSVP cleanup aborted</b>\n\nArchive insert failed: <code>${archiveErr.message}</code>\n\n${liveRows.length} row(s) remain in rsvps untouched. Investigate before next run.`);
    throw new Error('Supabase archive insert failed: ' + archiveErr.message);
  }
  console.log(`📦 Archive: upserted ${archiveRows.length} row(s) into rsvps_archive.`);

  // ── Step 2: Delete from active rsvps ──────────────────────────────────
  const { error: delErr } = await supabase
    .from('rsvps')
    .delete()
    .in('zone', zoneList);
  if (delErr) {
    await sendTelegram(`⚠️ <b>RSVP archive partial</b>\n\nRows are safely in rsvps_archive but delete from rsvps failed: <code>${delErr.message}</code>\n\nSync-check will now show drift between Supabase and Sheet until this is resolved.`);
    throw new Error('Supabase delete failed: ' + delErr.message);
  }
  console.log(`🗑️  Deleted ${liveRows.length} row(s) from rsvps.`);

  // ── Step 3: Sheet best-effort ─────────────────────────────────────────
  let sheetDeleted = -1;
  try {
    const sheets = await sheetsClient();
    sheetDeleted = await deleteSheetRowsForZones(sheets, new Set(zoneList));
    console.log(`🗑️  Sheet: deleted ${sheetDeleted} rows.`);
  } catch (e) {
    console.warn(`⚠️  Sheet delete failed: ${e.message}`);
  }

  // ── Step 4: Telegram summary ──────────────────────────────────────────
  const lines = ['📦 <b>Event RSVP archive</b>', ''];
  for (const { zone, eventName, eventDate } of zonesToClean) {
    const c = counts.get(zone);
    if (!c) continue;
    const label = eventName ? `${zone} (${eventName})` : zone;
    lines.push(`• ${label} — ${c.rsvps} RSVPs / ${c.guests} guests · event was ${eventDate}`);
  }
  lines.push('', 'Moved to <code>rsvps_archive</code> — admin RSVP view now shows upcoming events only.');
  if (sheetDeleted >= 0) {
    lines.push(`Sheet rows removed: ${sheetDeleted}`);
  } else {
    lines.push('⚠️ Sheet cleanup failed — see workflow logs. Sync check will flag the drift.');
  }
  await sendTelegram(lines.join('\n'));
  console.log('📲 Telegram summary sent.');
}

main().catch(err => {
  console.error('❌ Archive cleanup failed:', err.message);
  process.exit(1);
});
