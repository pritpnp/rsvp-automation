const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { logAudit } = require('./_audit');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// Everything behind the volunteer scan page (/scan):
//
//   POST /login    { username, password }  -> { token, username }
//   POST /logout   (x-volunteer-token)
//   GET  /verify   (x-volunteer-token)     -> { valid, username }
//   GET  /pass?id=<pass uuid>              -> the pass + its arrival status
//   POST /checkin  { id }                  -> records the FIRST arrival and
//                                             posts it to the admin Telegram group
//
// Volunteers are added by the superadmin (superadmin-volunteers.js). Their
// tokens live in volunteer_sessions — never manager_sessions, where a null
// manager_id means superadmin.
//
// A pass's QR code is its own link (https://screvents.com/vip/<id>); the scan
// page pulls the id out and sends only that.

const SESSION_HOURS = 24;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TZ = 'America/New_York';
const TELEGRAM_LIMIT = 4096;

const NOT_SET_UP = 'Volunteer check-in is not set up in the database yet — ask the admin to run the volunteers SQL in Supabase.';

const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

// The volunteers tables or the vip_passes check-in columns do not exist yet.
function isNotSetUp(error) {
  const m = (error && error.message) || '';
  return !!error && (error.code === '42P01' || error.code === '42703' || error.code === 'PGRST204' || error.code === 'PGRST205' ||
                     (/(volunteer|checked_in)/.test(m) && /(does not exist|schema cache)/i.test(m)));
}

function parseBody(event) {
  try { return JSON.parse(event.body || '{}') || {}; } catch { return {}; }
}

function tokenOf(event) {
  return String(event.headers['x-volunteer-token'] || '').trim();
}

async function getVolunteer(supabase, token) {
  if (!token) return null;
  const { data: s, error } = await supabase
    .from('volunteer_sessions')
    .select('volunteer_id, expires_at, volunteers(username)')
    .eq('token', token)
    .single();
  if (error || !s) return null;
  if (!(new Date(s.expires_at) > new Date())) return null;
  const username = s.volunteers && s.volunteers.username;
  if (!username) return null;          // volunteer removed
  return { id: s.volunteer_id, username };
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The admin group message, e.g.
//   ⭐ VIP Ravi Patel has arrived at 10:42 AM          (bold)
//
//   VIPs that have arrived (3 of 12):                  (bold)
//   Anil Shah
//   Ravi Patel
function arrivalMessage(guestName, arrivedAt, arrived, total) {
  const head = `⭐ <b>VIP ${esc(guestName)} has arrived at ${esc(formatTime(arrivedAt))}</b>\n\n` +
               `<b>VIPs that have arrived (${arrived.length}${total ? ' of ' + total : ''}):</b>\n`;
  const names = arrived.map((a) => esc(a.guest_name));
  // Telegram rejects a message over 4096 characters; keep the newest arrivals
  // visible by trimming from the top of the list.
  let body = names.join('\n');
  let dropped = 0;
  while (head.length + body.length > TELEGRAM_LIMIT - 40 && names.length > 1) {
    names.shift(); dropped++;
    body = `…and ${dropped} earlier\n` + names.join('\n');
  }
  return head + body;
}

async function sendTelegram(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;           // the admin group
  if (!botToken || !chatId) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: ctrl.signal
    });
    if (!res.ok) console.error('Telegram arrival message failed:', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (e) {
    console.error('Telegram arrival message failed:', e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Start / end time are read live from the event (free text from the admin
// portal). Optional: a missing event just means no time.
async function eventTime(supabase, eventId) {
  if (!eventId) return { start: '', end: '' };
  const { data, error } = await supabase.from('events').select('start_time, end_time').eq('id', eventId).single();
  if (error || !data) return { start: '', end: '' };
  return { start: String(data.start_time || '').trim(), end: String(data.end_time || '').trim() };
}

const PASS_FIELDS = 'id, guest_name, event_id, event_name, event_date, checked_in_at, checked_in_by';

async function passView(supabase, p) {
  return {
    id: p.id,
    guest_name: p.guest_name,
    event_name: p.event_name,
    event_date: p.event_date,
    event_time: await eventTime(supabase, p.event_id),
    checked_in_at: p.checked_in_at || null,
    checked_in_by: p.checked_in_by || null
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const path = (event.path || '').replace(/^.*\/volunteer-scan/, '') || '/';

  // ── POST /login ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && path === '/login') {
    const body = parseBody(event);
    const username = String(body.username || '').toLowerCase().trim();
    const password = String(body.password || '');
    if (!username || !password) return reply(400, { error: 'Please enter your username and password' });

    const { data: vol, error } = await supabase
      .from('volunteers')
      .select('id, username, password_hash')
      .eq('username', username)
      .single();
    if (error && isNotSetUp(error)) return reply(503, { error: NOT_SET_UP });

    const ok = !!vol && await bcrypt.compare(password, vol.password_hash);
    if (!ok) {
      logAudit(supabase, event, { actorName: username + ' (volunteer)', action: 'volunteer.login', success: false });
      return reply(401, { error: 'Wrong username or password' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
    const { error: insErr } = await supabase.from('volunteer_sessions').insert([{ token, volunteer_id: vol.id, expires_at }]);
    if (insErr) {
      console.error('Volunteer session insert error:', insErr.message);
      return reply(isNotSetUp(insErr) ? 503 : 500, { error: isNotSetUp(insErr) ? NOT_SET_UP : 'Could not sign in. Please try again.' });
    }
    logAudit(supabase, event, { actorName: vol.username + ' (volunteer)', action: 'volunteer.login' });
    return reply(200, { token, username: vol.username });
  }

  // ── POST /logout ─────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && path === '/logout') {
    const token = tokenOf(event);
    if (token) await supabase.from('volunteer_sessions').delete().eq('token', token);
    return reply(200, { success: true });
  }

  // Everything below needs a signed-in volunteer.
  const vol = await getVolunteer(supabase, tokenOf(event));
  if (!vol) return reply(401, { error: 'Please sign in again' });

  // ── GET /verify ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && path === '/verify') {
    return reply(200, { valid: true, username: vol.username });
  }

  // ── GET /pass?id= ────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && path === '/pass') {
    const id = String(event.queryStringParameters?.id || '').trim();
    if (!UUID_RE.test(id)) return reply(400, { error: 'That QR code is not a VIP pass' });
    const { data: p, error } = await supabase.from('vip_passes').select(PASS_FIELDS).eq('id', id).single();
    if (error && isNotSetUp(error)) return reply(503, { error: NOT_SET_UP });
    if (!p) return reply(404, { error: 'Pass not found. It may have been removed.' });
    return reply(200, await passView(supabase, p));
  }

  // ── POST /checkin { id } ─────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && path === '/checkin') {
    const id = String(parseBody(event).id || '').trim();
    if (!UUID_RE.test(id)) return reply(400, { error: 'That QR code is not a VIP pass' });

    // Only the FIRST arrival is recorded: the `checked_in_at is null` filter
    // makes this a single atomic claim, so two volunteers scanning the same
    // pass at once cannot both send the Telegram message.
    const now = new Date().toISOString();
    const { data: claimed, error } = await supabase
      .from('vip_passes')
      .update({ checked_in_at: now, checked_in_by: vol.username })
      .eq('id', id)
      .is('checked_in_at', null)
      .select(PASS_FIELDS);
    if (error) {
      console.error('Check-in update error:', error.message);
      return reply(isNotSetUp(error) ? 503 : 500, { error: isNotSetUp(error) ? NOT_SET_UP : 'Could not check in. Please try again.' });
    }

    if (!claimed || !claimed.length) {
      // Already checked in (a second car is fine), or no such pass.
      const { data: p } = await supabase.from('vip_passes').select(PASS_FIELDS).eq('id', id).single();
      if (!p) return reply(404, { error: 'Pass not found. It may have been removed.' });
      return reply(200, { first: false, notified: false, pass: await passView(supabase, p) });
    }

    const p = claimed[0];
    logAudit(supabase, event, { actorId: vol.id, actorName: vol.username + ' (volunteer)', action: 'pass.checkin', target: p.id, details: { guest_name: p.guest_name, event_name: p.event_name } });

    // Everyone checked in for this event so far, in arrival order.
    let arrived = [{ guest_name: p.guest_name }];
    let total = 0;
    if (p.event_id) {
      const [{ data: rows }, { count }] = await Promise.all([
        supabase.from('vip_passes').select('guest_name, checked_in_at')
          .eq('event_id', p.event_id).not('checked_in_at', 'is', null)
          .order('checked_in_at', { ascending: true }),
        supabase.from('vip_passes').select('*', { count: 'exact', head: true }).eq('event_id', p.event_id)
      ]);
      if (rows && rows.length) arrived = rows;
      total = count || 0;
    }
    const notified = await sendTelegram(arrivalMessage(p.guest_name, p.checked_in_at || now, arrived, total));

    return reply(200, { first: true, notified, pass: await passView(supabase, p) });
  }

  return reply(404, { error: 'Not found' });
};
