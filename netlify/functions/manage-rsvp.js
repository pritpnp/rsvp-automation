const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

const VALID_ZONES = ['global', 'scranton', 'mountain-top', 'moosic', 'bloomsburg', 'satsang-sabha', 'mandir-1', 'mandir-2', 'mandir-3', 'mandir-4', 'mandir-5'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── Auth: superadmin only ─────────────────────────────────────────────────
  const adminPassword  = event.headers['x-admin-password'];
  const managerToken   = event.headers['x-manager-token'];
  const supabase       = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  let isSuperadmin     = adminPassword === process.env.ADMIN_PASSWORD;

  if (!isSuperadmin && managerToken) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', managerToken)
      .single();
    if (session && !session.manager_id && new Date(session.expires_at) > new Date()) {
      isSuperadmin = true;
    }
  }

  if (!isSuperadmin) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { zone, enabled } = body;
  if (!zone || !VALID_ZONES.includes(zone) || typeof enabled !== 'boolean') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid zone or enabled value' }) };
  }

  const { error } = await supabase
    .from('rsvp_settings')
    .upsert({ zone, enabled }, { onConflict: 'zone' });

  if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zone, enabled }) };
};
