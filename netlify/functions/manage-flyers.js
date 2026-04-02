const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (!['POST', 'DELETE'].includes(event.httpMethod)) {
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
  let permissions = {};

  if (!isSuperadmin) {
    const { data: manager } = await supabase
      .from('managers')
      .select('permissions')
      .eq('id', session.manager_id)
      .single();
    permissions = manager?.permissions || {};
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { zone, imageBase64 } = body;

  const VALID_ZONES = [
    'scranton', 'mountain-top', 'moosic', 'bloomsburg',
    'satsang-sabha', 'mandir-1', 'mandir-2', 'mandir-3', 'mandir-4', 'mandir-5'
  ];

  if (!zone || !VALID_ZONES.includes(zone)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid zone' }) };
  }

  const GITHUB_PAT = process.env.GITHUB_PAT;
  const filePath   = `flyers/${zone}/flyer.jpg`;
  const apiUrl     = `https://api.github.com/repos/pritpnp/rsvp-automation/contents/${filePath}`;
  const ghHeaders  = {
    'Authorization': `Bearer ${GITHUB_PAT}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // ── POST: Upload flyer ────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    if (!isSuperadmin && !permissions.upload_flyers) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to upload flyers' }) };
    }
    if (!imageBase64) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing imageBase64' }) };
    }

    // Get existing SHA if file exists (required for overwrite)
    let sha;
    const getRes = await fetch(apiUrl, { headers: ghHeaders });
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    }

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `Upload flyer for ${zone} via admin portal`,
        content: imageBase64,
        ...(sha ? { sha } : {}),
      }),
    });

    if (!putRes.ok) {
      const err = await putRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: `GitHub error: ${err}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ── DELETE: Remove flyer ──────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    if (!isSuperadmin && !permissions.remove_flyers) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to remove flyers' }) };
    }

    const getRes = await fetch(apiUrl, { headers: ghHeaders });
    if (!getRes.ok) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `No flyer found for ${zone}` }) };
    }

    const existing = await getRes.json();
    const sha      = existing.sha;

    const delRes = await fetch(apiUrl, {
      method: 'DELETE',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `Remove flyer for ${zone} via admin portal`,
        sha,
      }),
    });

    if (!delRes.ok) {
      const err = await delRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: `GitHub error: ${err}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }
};
