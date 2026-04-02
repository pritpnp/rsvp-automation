const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const token = event.headers['x-manager-token'];
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: session } = await supabase
    .from('manager_sessions')
    .select('manager_id, expires_at')
    .eq('token', token)
    .single();

  if (!session || new Date(session.expires_at) < new Date()) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired' }) };
  }

  const isSuperadmin = !session.manager_id;
  if (!isSuperadmin) {
    const { data: manager } = await supabase
      .from('managers')
      .select('permissions')
      .eq('id', session.manager_id)
      .single();
    if (!manager?.permissions?.refresh_flyers) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to refresh flyers' }) };
    }
  }

  // ── Dispatch GitHub Actions workflow with force_all=true ──────────────────
  const ghRes = await fetch(
    'https://api.github.com/repos/pritpnp/rsvp-automation/actions/workflows/rsvp-automation.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { force_all: 'true' },
      }),
    }
  );

  if (!ghRes.ok) {
    const err = await ghRes.text();
    return { statusCode: 500, headers, body: JSON.stringify({ error: `GitHub dispatch failed: ${err}` }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
