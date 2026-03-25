const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GITHUB_PAT           = process.env.GITHUB_PAT;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-manager-token, Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── Auth — superadmin only ────────────────────────────────────────────────
  const token = event.headers['x-manager-token'];
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: session, error: sessionErr } = await supabase
    .from('manager_sessions')
    .select('manager_id, expires_at')
    .eq('token', token)
    .single();

  if (sessionErr || !session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
  if (new Date(session.expires_at) < new Date()) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired' }) };
  if (session.manager_id !== null) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Superadmin access required' }) };

  // ── Dispatch rsvp-automation workflow ─────────────────────────────────────
  const ghRes = await fetch(
    'https://api.github.com/repos/pritpnp/rsvp-automation/actions/workflows/rsvp-automation.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );

  if (!ghRes.ok) {
    const ghBody = await ghRes.text();
    console.error(`GitHub dispatch failed: ${ghRes.status} — ${ghBody}`);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to trigger redeploy' }) };
  }

  console.log('✅ Redeploy triggered via admin');
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
