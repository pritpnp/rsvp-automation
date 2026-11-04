const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const RATE_LIMIT_WINDOW_MIN = 60;
const RATE_LIMIT_MAX_FAILS  = 5;

function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

// ── Name matching ─────────────────────────────────────────────────────────
// The phone number must match EXACTLY (see the query below); that is what
// actually identifies the guest. The name is a sanity check, and it tolerates
// misspellings: a guest whose pass says "Rajesh" gets in typing "Ragesh" or
// "Rajish", as long as the name is at least NAME_MATCH_MIN similar.
const NAME_MATCH_MIN = 0.6;

// Words that say nothing about WHO someone is. Dropped before comparing, so a
// pass stored as "Mr. & Mrs. Patel" or "Patel Family" still matches "Rajesh
// Patel" on the surname.
const NAME_STOPWORDS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'shree', 'sri', 'smt', 'and', 'family']);

function normalizeName(n) {
  // Letters only (any script): "&", ".", "," and digits become spaces.
  return String(n || '').toLowerCase().replace(/[^\p{L}\p{M}\s]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}
function nameTokens(n) {
  return normalizeName(n).split(' ').filter((t) => t.length >= 2 && !NAME_STOPWORDS.has(t));
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// How alike two single words are, 0..1. One word starting with the other
// counts as a full match — "Rajesh" for "Rajeshbhai", "Smita" for "Smitaben" —
// once the shorter is 3+ letters. Otherwise 1 minus the share of letters that
// had to change: "ragesh" vs "rajesh" = 1 - 1/6 = 0.83.
function wordSimilarity(a, b) {
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.startsWith(s)) return 1;
  return 1 - levenshtein(a, b) / l.length;
}

// For each word of `from`, its best match among the words of `to`, averaged.
function directionalScore(from, to) {
  if (!from.length || !to.length) return 0;
  return from.reduce((sum, w) => sum + Math.max(...to.map((t) => wordSimilarity(w, t))), 0) / from.length;
}

// 0..1. Taken in whichever direction scores higher, so typing LESS than the
// pass holds ("Rajesh" for "Rajesh Patel") or MORE ("Rajesh Patel" for a pass
// stored as just "Rajesh") are both full matches, while a different surname
// ("Rajesh Kumar" for "Rajesh Patel") scores 0.5 and is refused.
function nameScore(entered, stored) {
  const a = nameTokens(entered), b = nameTokens(stored);
  if (a.length && b.length) return Math.max(directionalScore(a, b), directionalScore(b, a));
  // Nothing left after dropping stopwords: compare the whole strings.
  const x = normalizeName(entered).replace(/ /g, ''), y = normalizeName(stored).replace(/ /g, '');
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function namesMatch(entered, stored) {
  return nameScore(entered, stored) >= NAME_MATCH_MIN;
}

function getClientIp(event) {
  return event.headers['x-nf-client-connection-ip']
      || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || event.headers['client-ip']
      || 'unknown';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { name, phone } = body;
  const phone_normalized = normalizePhone(phone);

  if (!name || !phone_normalized) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and phone are required' }) };
  }
  // US numbers only. Every pass is stored with a 10-digit number, so anything
  // else cannot match. Refused here, before the attempt is logged, so a
  // mistyped number does not count toward the failed-attempt rate limit.
  if (phone_normalized.length !== 10) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter your 10-digit phone number, numbers only.' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const ip = getClientIp(event);

  // Whitelist bypasses rate limit. Skip the check entirely for 'unknown' IPs
  // (we can't bucket them safely) — production traffic always has an IP.
  let whitelisted = false;
  if (ip !== 'unknown') {
    const { data: wl } = await supabase
      .from('invite_ip_whitelist')
      .select('ip')
      .eq('ip', ip)
      .maybeSingle();
    whitelisted = !!wl;
  }

  if (!whitelisted && ip !== 'unknown') {
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
    const { count: failCount } = await supabase
      .from('invite_lookup_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('ip', ip)
      .eq('success', false)
      .gte('attempted_at', windowStart);

    if ((failCount || 0) >= RATE_LIMIT_MAX_FAILS) {
      // Don't log the blocked attempt itself — would extend the window forever.
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'Too many failed attempts. Please contact the event organizer to verify your invitation.' })
      };
    }
  }

  // Pull every pass matching the phone (could span multiple events).
  const { data: matches, error } = await supabase
    .from('vip_passes')
    .select('id, guest_name, event_id, created_at')
    .eq('phone_normalized', phone_normalized)
    .order('created_at', { ascending: false });

  if (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
  }

  const verified = matches && matches.find(p => namesMatch(name, p.guest_name));

  // Log the attempt — fire-and-forget; don't block the response on logging.
  supabase.from('invite_lookup_attempts').insert([{
    ip,
    success: !!verified,
    name_attempted: String(name).slice(0, 100),
    phone_attempted: String(phone).slice(0, 30)
  }]).then(() => {}, () => {});

  if (!verified) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'No invitation found for that name and phone.' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ id: verified.id }) };
};
