const { createClient } = require('@supabase/supabase-js');
const { logAudit } = require('./_audit');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  // Top-level safety net: any uncaught throw (a bad env var making createClient
  // throw, a transient GitHub fetch rejection before an inner try, a bodyless
  // request, etc.) returns JSON instead of a bodiless 502 that the client parses
  // as "Unexpected end of JSON input".
  try {
    return await handleRequest(event, headers);
  } catch (e) {
    console.error('manage-flyers unhandled error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error — please try again in a moment.' }) };
  }
};

async function handleRequest(event, headers) {
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
  // Default to '{}' so a bodyless request (event.body === null, which
  // JSON.parse(null) coerces to null WITHOUT throwing) parses to {} and hits the
  // field validators below instead of throwing on destructuring.
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { zone, zones, imageBase64 } = body;

  const VALID_ZONES = [
    'scranton', 'mountain-top', 'moosic', 'bloomsburg',
    'satsang-sabha', 'mandir-1', 'mandir-2', 'mandir-3', 'mandir-4', 'mandir-5'
  ];

  const GITHUB_PAT = process.env.GITHUB_PAT;
  const REPO       = 'pritpnp/rsvp-automation';
  const ghHeaders  = {
    'Authorization': `Bearer ${GITHUB_PAT}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // ── DELETE (bulk): remove several zones' flyers in ONE commit ─────────────
  // One commit = one RSVP Automation run, so deleting multiple flyers can't race
  // concurrent "deploy: update dist" pushes against each other. (The per-file
  // delete below fires 2 commits per zone → many parallel runs → rebase conflicts.)
  if (event.httpMethod === 'DELETE' && Array.isArray(zones)) {
    if (!isSuperadmin && !permissions.remove_flyers) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to remove flyers' }) };
    }
    const valid = [...new Set(zones)].filter((z) => VALID_ZONES.includes(z));
    if (!valid.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid zones provided' }) };
    }

    const api = `https://api.github.com/repos/${REPO}`;
    // Only delete paths that actually exist (flyer.jpg + og.jpg per zone).
    const candidates = valid.flatMap((z) => [`flyers/${z}/flyer.jpg`, `flyers/${z}/og.jpg`]);
    const toDelete = [];
    for (const p of candidates) {
      const r = await fetch(`${api}/contents/${p}`, { headers: ghHeaders });
      if (r.ok) toDelete.push(p);
    }
    if (!toDelete.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No flyers found for the selected zones' }) };
    }

    try {
      // 1. latest commit on main + its base tree
      const refRes = await fetch(`${api}/git/ref/heads/main`, { headers: ghHeaders });
      if (!refRes.ok) throw new Error(`ref ${await refRes.text()}`);
      const latestSha = (await refRes.json()).object.sha;

      const commitRes = await fetch(`${api}/git/commits/${latestSha}`, { headers: ghHeaders });
      if (!commitRes.ok) throw new Error(`commit ${await commitRes.text()}`);
      const baseTree = (await commitRes.json()).tree.sha;

      // 2. new tree with each file removed (sha: null deletes a path)
      const treeRes = await fetch(`${api}/git/trees`, {
        method: 'POST', headers: ghHeaders,
        body: JSON.stringify({
          base_tree: baseTree,
          tree: toDelete.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
        }),
      });
      if (!treeRes.ok) throw new Error(`tree ${await treeRes.text()}`);
      const newTreeSha = (await treeRes.json()).sha;

      // 3. ONE commit removing them all
      const newCommitRes = await fetch(`${api}/git/commits`, {
        method: 'POST', headers: ghHeaders,
        body: JSON.stringify({
          message: `Remove ${valid.length} flyer(s) via admin portal: ${valid.join(', ')}`,
          tree: newTreeSha,
          parents: [latestSha],
        }),
      });
      if (!newCommitRes.ok) throw new Error(`new commit ${await newCommitRes.text()}`);
      const newCommitSha = (await newCommitRes.json()).sha;

      // 4. advance main
      const updRes = await fetch(`${api}/git/refs/heads/main`, {
        method: 'PATCH', headers: ghHeaders,
        body: JSON.stringify({ sha: newCommitSha }),
      });
      if (!updRes.ok) throw new Error(`update ref ${await updRes.text()}`);

      logAudit(supabase, event, { action: 'flyer.remove_bulk', target: valid.join(', ') });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, removed: valid }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Bulk remove failed: ${e.message}` }) };
    }
  }

  if (!zone || !VALID_ZONES.includes(zone)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid zone' }) };
  }

  const filePath   = `flyers/${zone}/flyer.jpg`;
  const ogPath     = `flyers/${zone}/og.jpg`;
  const apiUrl     = `https://api.github.com/repos/${REPO}/contents/${filePath}`;
  const ogApiUrl   = `https://api.github.com/repos/${REPO}/contents/${ogPath}`;

  // Delete og.jpg if it exists; ignored if missing. Lets automate.js regenerate it from the new flyer.
  // Best-effort: never let a stale-og cleanup failure bubble up and fail an
  // upload/delete that already succeeded (that would report success as failure
  // and prompt a redundant re-upload).
  const deleteOgIfExists = async (commitMessage) => {
    try {
      const ogGetRes = await fetch(ogApiUrl, { headers: ghHeaders });
      if (!ogGetRes.ok) return;
      const ogExisting = await ogGetRes.json();
      await fetch(ogApiUrl, {
        method: 'DELETE',
        headers: ghHeaders,
        body: JSON.stringify({
          message: commitMessage,
          sha: ogExisting.sha,
        }),
      });
    } catch (e) {
      console.warn('og.jpg cleanup failed (non-fatal):', e.message);
    }
  };

  // ── POST: Upload flyer ────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    if (!isSuperadmin && !permissions.upload_flyers) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to upload flyers' }) };
    }
    if (!imageBase64) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing imageBase64' }) };
    }
    // Reject an oversized payload with a clear JSON error instead of letting the
    // function 502 with an empty body (the client can't JSON-parse that, which
    // surfaced as "Unexpected end of JSON input"). The admin UI now compresses
    // client-side, so this only fires on a pathological payload.
    if (imageBase64.length > 5500000) {
      return { statusCode: 413, headers, body: JSON.stringify({ error: 'Image too large — please use a smaller flyer image (under ~4MB).' }) };
    }

    // Wrap the GitHub calls so a network/parse throw returns JSON, not an empty
    // 502 body that the client can't parse.
    try {
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

      // Remove stale og.jpg so automate.js regenerates it from the new flyer
      await deleteOgIfExists(`Remove stale og.jpg for ${zone} after flyer upload`);

      logAudit(supabase, event, { action: 'flyer.upload', target: zone });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Upload failed: ${e.message}` }) };
    }
  }

  // ── DELETE: Remove flyer ──────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    if (!isSuperadmin && !permissions.remove_flyers) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to remove flyers' }) };
    }

    try {
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

      // Also remove og.jpg so no orphan OG image remains
      await deleteOgIfExists(`Remove og.jpg for ${zone} via admin portal`);

      logAudit(supabase, event, { action: 'flyer.remove', target: zone });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Remove failed: ${e.message}` }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unhandled request' }) };
}
