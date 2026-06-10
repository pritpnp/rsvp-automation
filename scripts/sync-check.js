// Periodic Sheet ↔ Supabase parity check.
//
// Run on a 10-min cron from .github/workflows/sync-check.yml. Pulls every row
// from both stores, diffs them on sheet_row_id, and posts a single Telegram
// message to the admin chat if any drift is found. Silent on parity so the
// chat doesn't get spammed every 10 min when everything's healthy.
//
// What "drift" means here:
//   - sheet_only:    Sheet has the row but Supabase doesn't. Caused by a
//                    surviving Power Automate flow, a manual Sheet add, or a
//                    failed submit-rsvp Supabase write.
//   - supabase_only: Supabase has the row but Sheet doesn't. Caused by a
//                    failed Sheet append from submit-rsvp, or someone editing
//                    Supabase directly.
//   - mismatch:      Same sheet_row_id present in both but with different
//                    guest count, name, or zone. Caused by a PATCH that only
//                    succeeded on one side.
//
// Healing is intentionally manual — the right action depends on the cause
// and we don't want to undo a legit manual deletion by auto-reinserting.

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'responses';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function pullSheet() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOG_SA_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:E`
  });
  const rows = res.data.values || [];
  const dataRows = rows[0]?.[0]?.toLowerCase() === 'zone' ? rows.slice(1) : rows;
  // Keyed by sheet_row_id. Rows without an id are unsyncable — they pre-date
  // Power Automate's ID column or were added by hand; count separately.
  const keyed = new Map();
  let unkeyed = 0;
  for (const r of dataRows) {
    const id = (r[4] || '').toString().trim();
    if (!id) { unkeyed++; continue; }
    keyed.set(id, {
      zone:   (r[0] || '').toString().trim(),
      name:   (r[1] || '').toString().trim(),
      guests: parseInt((r[2] || '').toString().trim(), 10) || 1
    });
  }
  return { keyed, unkeyed };
}

async function pullSupabase() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('rsvps')
    .select('zone, name, guests, sheet_row_id');
  if (error) throw new Error('Supabase pull failed: ' + error.message);
  const keyed = new Map();
  let unkeyed = 0;
  for (const r of (data || [])) {
    if (!r.sheet_row_id) { unkeyed++; continue; }
    keyed.set(r.sheet_row_id, {
      zone:   r.zone || '',
      name:   r.name || '',
      guests: parseInt(r.guests, 10) || 1
    });
  }
  return { keyed, unkeyed };
}

function diff(sheet, supa) {
  const sheetOnly = [];
  const supabaseOnly = [];
  const mismatch = [];

  for (const [id, s] of sheet.keyed.entries()) {
    const u = supa.keyed.get(id);
    if (!u) { sheetOnly.push({ id, ...s }); continue; }
    if (u.guests !== s.guests || u.name !== s.name || u.zone !== s.zone) {
      mismatch.push({ id, sheet: s, supabase: u });
    }
  }
  for (const [id, u] of supa.keyed.entries()) {
    if (!sheet.keyed.has(id)) supabaseOnly.push({ id, ...u });
  }
  return { sheetOnly, supabaseOnly, mismatch };
}

function fmtRow(r) {
  return `${r.name} (${r.zone}, ${r.guests}g)`;
}

function fmtMismatch(m) {
  const changes = [];
  if (m.sheet.guests !== m.supabase.guests) changes.push(`guests Sheet:${m.sheet.guests} Supa:${m.supabase.guests}`);
  if (m.sheet.name   !== m.supabase.name)   changes.push(`name Sheet:"${m.sheet.name}" Supa:"${m.supabase.name}"`);
  if (m.sheet.zone   !== m.supabase.zone)   changes.push(`zone Sheet:${m.sheet.zone} Supa:${m.supabase.zone}`);
  return `${m.sheet.name || m.supabase.name} — ${changes.join('; ')}`;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('Telegram env vars missing — skipping send. Would have sent:\n' + text);
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
  console.log('🔍 Pulling Sheet and Supabase…');
  const [sheet, supa] = await Promise.all([pullSheet(), pullSupabase()]);
  console.log(`📊 Sheet: ${sheet.keyed.size} keyed + ${sheet.unkeyed} unkeyed; Supabase: ${supa.keyed.size} keyed + ${supa.unkeyed} unkeyed`);

  const { sheetOnly, supabaseOnly, mismatch } = diff(sheet, supa);
  const driftCount = sheetOnly.length + supabaseOnly.length + mismatch.length;

  if (driftCount === 0) {
    console.log('✅ In sync — no drift detected. Skipping Telegram.');
    return;
  }

  // Cap each list at 10 entries in the message so it stays readable.
  const lines = [`⚠️ <b>RSVP sync drift detected</b>`, ''];
  if (sheetOnly.length) {
    lines.push(`<b>${sheetOnly.length} in Sheet only</b> (Supabase missing):`);
    sheetOnly.slice(0, 10).forEach(r => lines.push(`• ${fmtRow(r)}`));
    if (sheetOnly.length > 10) lines.push(`  …and ${sheetOnly.length - 10} more`);
    lines.push('');
  }
  if (supabaseOnly.length) {
    lines.push(`<b>${supabaseOnly.length} in Supabase only</b> (Sheet missing):`);
    supabaseOnly.slice(0, 10).forEach(r => lines.push(`• ${fmtRow(r)}`));
    if (supabaseOnly.length > 10) lines.push(`  …and ${supabaseOnly.length - 10} more`);
    lines.push('');
  }
  if (mismatch.length) {
    lines.push(`<b>${mismatch.length} mismatched</b>:`);
    mismatch.slice(0, 10).forEach(m => lines.push(`• ${fmtMismatch(m)}`));
    if (mismatch.length > 10) lines.push(`  …and ${mismatch.length - 10} more`);
  }

  console.log(lines.join('\n'));
  await sendTelegram(lines.join('\n'));
  console.log('📲 Telegram alert sent.');
}

main().catch(err => {
  console.error('❌ Sync check failed:', err.message);
  // Don't notify Telegram on infra errors — that would spam during outages.
  // The workflow run will be red in GitHub, which is enough signal.
  process.exit(1);
});
