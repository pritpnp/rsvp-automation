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

function normalizeName(n) {
  return String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Loose name match: handles nicknames, "First Last" vs "First", etc.
function namesMatch(entered, stored) {
  const a = normalizeName(entered);
  const b = normalizeName(stored);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aTokens = a.split(' ').filter(t => t.length >= 2);
  const bTokens = b.split(' ').filter(t => t.length >= 2);
  return aTokens.some(t => bTokens.includes(t));
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
