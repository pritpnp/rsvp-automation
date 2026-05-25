const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const RATE_LIMIT_WINDOW_MIN = 60;
const RATE_LIMIT_MAX_FAILS  = 5;

async function authenticateSuperadmin(event, supabase) {
  const adminPassword = event.headers['x-admin-password'];
  if (adminPassword === process.env.ADMIN_PASSWORD) {
    return { ok: true, username: 'superadmin' };
  }
  const token = event.headers['x-manager-token'];
  if (token) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', token)
      .single();
    if (session && new Date(session.expires_at) > new Date() && !session.manager_id) {
      return { ok: true, username: 'superadmin' };
    }
  }
  return { ok: false };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const auth = await authenticateSuperadmin(event, supabase);
  if (!auth.ok) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Superadmin required' }) };
  }

  if (event.httpMethod === 'GET') {
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();

    // Recent attempts — last 100, both success and fail, for the activity log.
    const { data: recent } = await supabase
      .from('invite_lookup_attempts')
      .select('id, ip, success, name_attempted, phone_attempted, attempted_at')
      .order('attempted_at', { ascending: false })
      .limit(100);

    // Failed attempts in the rate-limit window — group by IP and count.
    const { data: failsInWindow } = await supabase
      .from('invite_lookup_attempts')
      .select('ip, attempted_at, name_attempted, phone_attempted')
      .eq('success', false)
      .gte('attempted_at', windowStart)
      .order('attempted_at', { ascending: false });

    const byIp = new Map();
    for (const f of (failsInWindow || [])) {
      if (!byIp.has(f.ip)) byIp.set(f.ip, { ip: f.ip, fail_count: 0, last_attempt: f.attempted_at, last_name: f.name_attempted, last_phone: f.phone_attempted });
      byIp.get(f.ip).fail_count++;
    }

    const { data: whitelist } = await supabase
      .from('invite_ip_whitelist')
      .select('ip, note, added_by, added_at')
      .order('added_at', { ascending: false });

    const whitelistSet = new Set((whitelist || []).map(w => w.ip));
    const blocked = [...byIp.values()]
      .filter(x => x.fail_count >= RATE_LIMIT_MAX_FAILS && !whitelistSet.has(x.ip))
      .sort((a, b) => b.fail_count - a.fail_count);
    const watching = [...byIp.values()]
      .filter(x => x.fail_count < RATE_LIMIT_MAX_FAILS && !whitelistSet.has(x.ip))
      .sort((a, b) => b.fail_count - a.fail_count);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        threshold: RATE_LIMIT_MAX_FAILS,
        window_minutes: RATE_LIMIT_WINDOW_MIN,
        blocked,
        watching,
        whitelist: whitelist || [],
        recent: recent || []
      })
    };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const ip = String(body.ip || '').trim();
    const note = String(body.note || '').trim().slice(0, 200);
    if (!ip) return { statusCode: 400, headers, body: JSON.stringify({ error: 'IP is required' }) };

    const { data, error } = await supabase
      .from('invite_ip_whitelist')
      .upsert({ ip, note, added_by: auth.username }, { onConflict: 'ip' })
      .select()
      .single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  if (event.httpMethod === 'DELETE') {
    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const ip = String(body.ip || '').trim();
    if (!ip) return { statusCode: 400, headers, body: JSON.stringify({ error: 'IP is required' }) };

    const { error } = await supabase.from('invite_ip_whitelist').delete().eq('ip', ip);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
