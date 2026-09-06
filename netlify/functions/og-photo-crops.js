const { createClient } = require('@supabase/supabase-js');
const { logAudit } = require('./_audit');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Per-photo crop overrides for the LANDSCAPE (preview/OG) card.
//
//   GET    -> { crops: { <photoId>: { focusX, focusY, zoom } } }   (no auth)
//   POST   -> upsert one or many crops                             (auth)
//   DELETE -> reset one photo, or all                              (auth)
//
// GET is intentionally unauthenticated: these are three layout numbers per
// photo, the same class of data already served publicly in swami-photos.json,
// and the flyer builder must be able to read them on every render without a
// manager token.
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-manager-token, x-admin-password, x-builder-session, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    // Short cache: the builder should pick up a new crop quickly, but repeated
    // renders in one session shouldn't hammer the function.
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Top-level net so a throw returns JSON rather than a bodiless 502 the client
  // can't parse (same failure that produced "Unexpected end of JSON input").
  try {
    return await handleRequest(event, headers);
  } catch (e) {
    console.error('og-photo-crops unhandled error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error — please try again.' }) };
  }
};

// SUPERADMIN ONLY. Crops are per-photo and global — one row changes the
// landscape card for EVERY zone — so a zone manager must not be able to change
// them. Accepts a superadmin manager token, the admin password, or a builder
// session that was minted for a superadmin (the positioner page is opened from
// the admin portal with a builder session, the same ticket the flyer builder
// uses for review-flyer). flyer_builder_advanced is deliberately NOT enough.
async function authorize(supabase, event) {
  const adminPw = event.headers['x-admin-password'];
  if (adminPw && adminPw === process.env.ADMIN_PASSWORD) {
    return { ok: true, actor: 'superadmin' };
  }

  const token = event.headers['x-manager-token'];
  if (token) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', token)
      .single();
    if (!session || new Date(session.expires_at) < new Date()) {
      return { ok: false, status: 401, error: 'Session expired' };
    }
    if (session.manager_id === null) return { ok: true, actor: 'superadmin' };
    return { ok: false, status: 403, error: 'Superadmin access required' };
  }

  const builderSessionId = event.headers['x-builder-session'];
  if (builderSessionId) {
    const { data: b } = await supabase
      .from('builder_sessions')
      .select('*')
      .eq('id', builderSessionId)
      .single();
    if (!b || new Date(b.expires_at) < new Date()) {
      return { ok: false, status: 401, error: 'Builder session expired. Please reopen from the admin portal.' };
    }
    if (!b.is_superadmin) {
      return { ok: false, status: 403, error: 'Superadmin access required' };
    }
    return { ok: true, actor: 'superadmin' };
  }

  return { ok: false, status: 401, error: 'Unauthorized' };
}

// True when Postgres rejects a query because flip_x does not exist yet (the
// flip migration has not been run). The function then retries without it so
// nothing breaks between deploying the code and running the migration.
const isMissingFlipColumn = (err) => !!err && /flip_x|42703/i.test((err.message || '') + ' ' + (err.code || ''));

const num = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

async function handleRequest(event, headers) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── GET — every crop, as a photoId-keyed map ──────────────────────────────
  if (event.httpMethod === 'GET') {
    let { data, error } = await supabase
      .from('photo_og_crops')
      .select('photo_id, focus_x, focus_y, zoom, flip_x, updated_at');
    if (error && isMissingFlipColumn(error)) {
      ({ data, error } = await supabase
        .from('photo_og_crops')
        .select('photo_id, focus_x, focus_y, zoom, updated_at'));
    }

    if (error) {
      // Table missing (migration not run yet) must not break the builder — it
      // falls back to the manifest crop. Report empty rather than 500.
      console.warn('og-photo-crops GET failed:', error.message);
      return { statusCode: 200, headers, body: JSON.stringify({ crops: {}, degraded: true }) };
    }

    const crops = {};
    for (const r of (data || [])) {
      crops[r.photo_id] = { focusX: r.focus_x, focusY: r.focus_y, zoom: r.zoom, flipX: !!r.flip_x, updatedAt: r.updated_at };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ crops }) };
  }

  if (!['POST', 'DELETE'].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = await authorize(supabase, event);
  if (!auth.ok) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // ── POST — upsert one or many ─────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    // Accept either { crops: { id: {...} } } (bulk / apply-to-all) or a single
    // { photoId, focusX, focusY, zoom }.
    let incoming = body.crops;
    if (!incoming && body.photoId) {
      incoming = { [body.photoId]: { focusX: body.focusX, focusY: body.focusY, zoom: body.zoom } };
    }
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide crops {} or photoId' }) };
    }

    const ids = Object.keys(incoming);
    if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No crops provided' }) };
    if (ids.some((id) => !String(id).trim())) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'photoId cannot be empty' }) };
    }
    if (ids.length > 500) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Too many crops in one request' }) };

    const now = new Date().toISOString();
    let rows = ids.map((id) => {
      const c = incoming[id] || {};
      return {
        photo_id: String(id).slice(0, 200),
        focus_x: num(c.focusX, 0, 1, 0.5),
        focus_y: num(c.focusY, 0, 1, 0.5),
        zoom:    num(c.zoom, 0.2, 4, 1),
        flip_x:  c.flipX === true,
        updated_at: now,
        updated_by: auth.actor,
      };
    });

    let { error } = await supabase.from('photo_og_crops').upsert(rows, { onConflict: 'photo_id' });
    if (error && isMissingFlipColumn(error)) {
      rows = rows.map(({ flip_x, ...r }) => r);
      ({ error } = await supabase.from('photo_og_crops').upsert(rows, { onConflict: 'photo_id' }));
    }
    if (error) {
      console.error('og-photo-crops upsert error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save: ' + error.message }) };
    }

    logAudit(supabase, event, {
      action: 'photo_crop.save',
      target: ids.length === 1 ? ids[0] : ids.length + ' photos',
      details: { count: ids.length },
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved: ids.length }) };
  }

  // ── DELETE — reset one photo, or all ──────────────────────────────────────
  if (body.all === true) {
    const { error } = await supabase.from('photo_og_crops').delete().neq('photo_id', '');
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reset: ' + error.message }) };
    logAudit(supabase, event, { action: 'photo_crop.reset_all', target: 'all' });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reset: 'all' }) };
  }

  if (!body.photoId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'photoId required' }) };
  }
  const { error } = await supabase.from('photo_og_crops').delete().eq('photo_id', body.photoId);
  if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reset: ' + error.message }) };

  logAudit(supabase, event, { action: 'photo_crop.reset', target: body.photoId });
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reset: body.photoId }) };
}
