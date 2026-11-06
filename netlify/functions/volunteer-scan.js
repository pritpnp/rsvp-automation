const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { logAudit, getClientIp } = require('./_audit');

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
//   POST /checkin  { id, force? }          -> records the FIRST arrival and
//                                             posts it to the admin Telegram group
//
// Volunteers are added by the superadmin (superadmin-volunteers.js). Their
// tokens live in volunteer_sessions — never manager_sessions, where a null
// manager_id means superadmin.
//
// A pass's QR code is its own link (https://screvents.com/vip/<id>); the scan
// page pulls the id out and sends only that.
//
// Status codes the scan page relies on: 401 ONLY when the sign-in itself is
// missing / expired / revoked (the page then asks to sign in again). A
// database or network problem is 500/503, so a blip on event day never signs
// every volunteer out.

const SESSION_HOURS = 24;
const REFRESH_BELOW_HOURS = 12;      // a session in use is extended back to 24 h
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TZ = 'America/New_York';
const TELEGRAM_LIMIT = 4096;
const LOGIN_FAIL_LIMIT = 10;         // failed sign-ins for one volunteer from one IP ...
const LOGIN_FAIL_IP_LIMIT = 40;      // ... or for anyone from one IP (venue Wi-Fi is shared) ...
const LOGIN_FAIL_WINDOW_MIN = 15;    // ... per this many minutes
const MAX_PASSWORD = 200;            // superadmin-volunteers.js refuses longer ones too

const NOT_SET_UP = 'Volunteer check-in is not set up in the database yet — ask the admin to run the volunteers SQL in Supabase.';
const UNAVAILABLE = 'Could not reach the server. Please try again.';

const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

// The volunteers tables or the vip_passes check-in columns do not exist yet.
function isNotSetUp(error) {
  const m = (error && error.message) || '';
  return !!error && (error.code === '42P01' || error.code === '42703' || error.code === 'PGRST204' || error.code === 'PGRST205' ||
                     (/(volunteer|checked_in)/.test(m) && /(does not exist|schema cache)/i.test(m)));
}
// Any other database error is a temporary failure, never "not found".
const dbFail = (error) => isNotSetUp(error) ? reply(503, { error: NOT_SET_UP }) : reply(503, { error: UNAVAILABLE });

function parseBody(event) {
  try { return JSON.parse(event.body || '{}') || {}; } catch { return {}; }
}

function tokenOf(event) {
  return String(event.headers['x-volunteer-token'] || '').trim();
}

// -> { vol } when signed in; { res } with the reply to send otherwise.
async function getVolunteer(supabase, token) {
  if (!token) return { res: reply(401, { error: 'Please sign in again' }) };
  const { data: s, error } = await supabase
    .from('volunteer_sessions')
    .select('volunteer_id, expires_at, volunteers(username)')
    .eq('token', token)
    .maybeSingle();
  if (error) { console.error('Volunteer session lookup error:', error.message); return { res: dbFail(error) }; }
  if (!s || !(new Date(s.expires_at) > new Date())) return { res: reply(401, { error: 'Please sign in again' }) };
  const username = s.volunteers && s.volunteers.username;
  if (!username) return { res: reply(401, { error: 'Please sign in again' }) };   // volunteer removed
  // Keep a session that is being used alive, so a volunteer who signed in the
  // evening before is not signed out halfway through the event.
  if (new Date(s.expires_at) - Date.now() < REFRESH_BELOW_HOURS * 3600e3) {
    const expires_at = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    const { error: upErr } = await supabase.from('volunteer_sessions').update({ expires_at }).eq('token', token);
    if (upErr) console.error('Volunteer session refresh error:', upErr.message);
  }
  return { vol: { id: s.volunteer_id, username } };
}

// Event dates (not-today check): shared with the bot's /vips command.
const { notToday, todayYmd } = require('../lib/vip-dates');

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The VIP group message, e.g.
//   ⭐ Kevin Brown has arrived at 10:42 AM             (bold, name underlined)
//   - Core Mark                                         (the pass's note, if any)
//
//   VIPs that have arrived (3 of 12):                   (bold)
//   Anil Shah
//   Kevin Brown
//   - Core Mark
// arrived = null when the list could not be read: the arrival line alone is
// sent rather than a wrong list or count.
const noteLine = (note) => (String(note || '').trim() ? `\n- ${esc(String(note).trim())}` : '');
function arrivalMessage(guestName, note, arrivedAt, arrived, total) {
  const line = `⭐ <b><u>${esc(guestName)}</u> has arrived at ${esc(formatTime(arrivedAt))}</b>${noteLine(note)}`;
  if (!arrived) return line;
  const head = `${line}\n\n<b>VIPs that have arrived (${arrived.length}${total ? ' of ' + total : ''}):</b>\n`;
  const names = arrived.map((a) => esc(a.guest_name) + noteLine(a.note));
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
  // The "SCREvents VIP" group. Until TELEGRAM_CHAT_ID_VIP is set in Netlify,
  // arrivals go to the admin group rather than nowhere. The bot must be a
  // member of whichever group this is.
  const chatId = process.env.TELEGRAM_CHAT_ID_VIP || process.env.TELEGRAM_CHAT_ID;
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

// The pass's event, read live: dates for the not-today check, free-text
// start / end time for display. Optional — a deleted event just means no
// time and no date check.
async function loadEvent(supabase, eventId) {
  if (!eventId) return null;
  const { data, error } = await supabase.from('events')
    .select('start_date, end_date, start_time, end_time')
    .eq('id', eventId)
    .maybeSingle();
  return error ? null : data;
}

// Whole rows, so a column added later (note) can't break scanning before its
// SQL is run. Only what passView picks out ever leaves the server.
const PASS_FIELDS = '*';

function passView(p, evt) {
  return {
    id: p.id,
    guest_name: p.guest_name,
    note: String(p.note || '').trim(),   // e.g. "Core Mark": tells apart guests with the same name
    event_name: p.event_name,
    event_date: p.event_date,
    event_time: { start: String((evt && evt.start_time) || '').trim(), end: String((evt && evt.end_time) || '').trim() },
    checked_in_at: p.checked_in_at || null,
    checked_in_by: p.checked_in_by || null
  };
}

let dummyHash = null;   // equalises sign-in timing for unknown usernames

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
    const failed = () => {
      logAudit(supabase, event, { actorName: username.slice(0, 64) + ' (volunteer)', action: 'volunteer.login', success: false });
      return reply(401, { error: 'Wrong username or password' });
    };
    if (username.length > 64 || password.length > MAX_PASSWORD) return failed();

    // Slow down password guessing, counted from the audit log: 10 failures
    // for this volunteer from this IP, or 40 for anyone from this IP, in 15
    // minutes. Per volunteer first, so one person mistyping on the venue
    // Wi-Fi can't lock everyone else out. If the count can't be read, sign-in
    // is not blocked. (A burst of simultaneous guesses can slip past a count
    // like this; bcrypt keeps each guess slow, and a volunteer account can
    // only check in passes it already has the link to.)
    const ip = getClientIp(event);
    if (ip && ip !== 'unknown') {
      const since = new Date(Date.now() - LOGIN_FAIL_WINDOW_MIN * 60e3).toISOString();
      const failures = (extra) => {
        let q = supabase.from('audit_log').select('*', { count: 'exact', head: true })
          .eq('action', 'volunteer.login').eq('success', false).eq('ip', ip).gte('created_at', since);
        return (extra ? q.eq('actor_name', extra) : q);
      };
      const [mine, all] = await Promise.all([failures(username.slice(0, 64) + ' (volunteer)'), failures(null)]);
      if ((!mine.error && (mine.count || 0) >= LOGIN_FAIL_LIMIT) || (!all.error && (all.count || 0) >= LOGIN_FAIL_IP_LIMIT)) {
        return reply(429, { error: `Too many wrong tries. Please wait ${LOGIN_FAIL_WINDOW_MIN} minutes and try again.` });
      }
    }

    const { data: vol, error } = await supabase
      .from('volunteers')
      .select('id, username, password_hash')
      .eq('username', username)
      .maybeSingle();
    if (error) { console.error('Volunteer lookup error:', error.message); return dbFail(error); }
    if (!vol) {
      dummyHash = dummyHash || await bcrypt.hash('not-a-real-password', 10);
      await bcrypt.compare(password, dummyHash);
      return failed();
    }
    if (!(await bcrypt.compare(password, vol.password_hash))) return failed();

    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    const { error: insErr } = await supabase.from('volunteer_sessions').insert([{ token, volunteer_id: vol.id, expires_at }]);
    if (insErr) { console.error('Volunteer session insert error:', insErr.message); return dbFail(insErr); }
    // If the superadmin changed this password (or removed the volunteer) while
    // the old one was being checked, that change already signed everyone out —
    // don't let this sign-in slip in after it.
    const { data: current, error: reErr } = await supabase.from('volunteers').select('password_hash').eq('id', vol.id).maybeSingle();
    if (reErr || !current || current.password_hash !== vol.password_hash) {
      await supabase.from('volunteer_sessions').delete().eq('token', token);
      if (reErr) return dbFail(reErr);
      return failed();
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
  const auth = await getVolunteer(supabase, tokenOf(event));
  if (!auth.vol) return auth.res;
  const vol = auth.vol;

  // ── GET /verify ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && path === '/verify') {
    return reply(200, { valid: true, username: vol.username });
  }

  // ── GET /pass?id= ────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && path === '/pass') {
    const id = String(event.queryStringParameters?.id || '').trim();
    if (!UUID_RE.test(id)) return reply(400, { error: 'That QR code is not a VIP pass' });
    const { data: p, error } = await supabase.from('vip_passes').select(PASS_FIELDS).eq('id', id).maybeSingle();
    if (error) return dbFail(error);
    if (!p) return reply(404, { error: 'Pass not found. It may have been removed.' });
    return reply(200, passView(p, await loadEvent(supabase, p.event_id)));
  }

  // ── POST /checkin { id, force? } ─────────────────────────────────────────
  if (event.httpMethod === 'POST' && path === '/checkin') {
    const body = parseBody(event);
    const id = String(body.id || '').trim();
    if (!UUID_RE.test(id)) return reply(400, { error: 'That QR code is not a VIP pass' });

    const { data: pass, error: readErr } = await supabase.from('vip_passes').select(PASS_FIELDS).eq('id', id).maybeSingle();
    if (readErr) { console.error('Check-in read error:', readErr.message); return dbFail(readErr); }
    if (!pass) return reply(404, { error: 'Pass not found. It may have been removed.' });
    const evt = await loadEvent(supabase, pass.event_id);

    // A pass for another day's event (an old link kept in someone's messages,
    // or next month's) must not be announced as today's arrival. The volunteer
    // sees the event and its date, and can still check them in deliberately.
    const otherDay = notToday(evt);
    const checkedInToday = !!pass.checked_in_at &&
      new Date(pass.checked_in_at).toLocaleDateString('en-CA', { timeZone: TZ }) === todayYmd();
    if (!body.force && otherDay && !checkedInToday) {
      return reply(409, { error: 'not_today', pass: passView(pass, evt) });
    }

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
    if (error) { console.error('Check-in update error:', error.message); return dbFail(error); }

    if (!claimed || !claimed.length) {
      // Already checked in (a second car is fine) — possibly just now by
      // someone else — or the pass was deleted a moment ago.
      const { data: p, error: e2 } = await supabase.from('vip_passes').select(PASS_FIELDS).eq('id', id).maybeSingle();
      if (e2) return dbFail(e2);
      if (!p) return reply(404, { error: 'Pass not found. It may have been removed.' });
      return reply(200, { first: false, notified: false, pass: passView(p, evt) });
    }

    const p = claimed[0];
    logAudit(supabase, event, { actorId: vol.id, actorName: vol.username + ' (volunteer)', action: 'pass.checkin', target: p.id, details: { guest_name: p.guest_name, event_name: p.event_name, forced: !!body.force } });

    // A pass for another day's event, checked in anyway: say which event it
    // was for, and don't post that other event's arrivals list as today's.
    if (otherDay) {
      const when = [p.event_name, p.event_date].map((s) => String(s || '').trim()).filter(Boolean).join(', ');
      const text = arrivalMessage(p.guest_name, p.note, p.checked_in_at || now, null, 0) +
        (when ? `\n<i>Checked in anyway with a pass for ${esc(when)}.</i>` : '');
      const notifiedOther = await sendTelegram(text);
      return reply(200, { first: true, notified: notifiedOther, pass: passView(p, evt) });
    }

    // Everyone checked in for this event so far, in arrival order.
    let arrived = [{ guest_name: p.guest_name }];
    let total = 0;
    if (p.event_id) {
      const [list, counted] = await Promise.all([
        supabase.from('vip_passes').select('*')
          .eq('event_id', p.event_id).not('checked_in_at', 'is', null)
          .order('checked_in_at', { ascending: true }),
        supabase.from('vip_passes').select('*', { count: 'exact', head: true }).eq('event_id', p.event_id)
      ]);
      if (list.error) { console.error('Arrivals list error:', list.error.message); arrived = null; }
      else if (list.data && list.data.length) arrived = list.data;
      total = counted.error ? 0 : (counted.count || 0);
    }
    const notified = await sendTelegram(arrivalMessage(p.guest_name, p.note, p.checked_in_at || now, arrived, total));

    return reply(200, { first: true, notified, pass: passView(p, evt) });
  }

  return reply(404, { error: 'Not found' });
};
