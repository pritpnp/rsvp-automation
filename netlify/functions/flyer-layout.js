const { createClient } = require('@supabase/supabase-js');
const { logAudit } = require('./_audit');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Live flyer layout (the object the builder's "Save layout" used to download
// as flyer-layout.json).
//
//   GET  -> { layout: {...} | null, updatedAt }      (no auth — the builder
//            must load it on every page open without a manager token; it is
//            pure geometry, the same data already public in flyer-layout.json)
//   POST -> { layout: {...} }  save                   (SUPERADMIN ONLY — layout
//            is global across every zone)
const LAYOUT_KEY  = 'flyer';
const TOP_KEYS    = ['header', 'footer', 'photoBox', 'fade', 'satsang', 'text', 'og'];
const MAX_BYTES   = 200 * 1024;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-manager-token, x-admin-password, x-builder-session, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    return await handleRequest(event, headers);
  } catch (e) {
    console.error('flyer-layout unhandled error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error — please try again.' }) };
  }
};

// Superadmin only, via any of the three credentials the site uses. Same
// shape as og-photo-crops.js.
async function authorize(supabase, event) {
  const adminPw = event.headers['x-admin-password'];
  if (adminPw && adminPw === process.env.ADMIN_PASSWORD) return { ok: true, actor: 'superadmin' };

  const token = event.headers['x-manager-token'];
  if (token) {
    const { data: s } = await supabase.from('manager_sessions').select('manager_id, expires_at').eq('token', token).single();
    if (!s || new Date(s.expires_at) < new Date()) return { ok: false, status: 401, error: 'Session expired' };
    if (s.manager_id === null) return { ok: true, actor: 'superadmin' };
    return { ok: false, status: 403, error: 'Superadmin access required' };
  }

  const bid = event.headers['x-builder-session'];
  if (bid) {
    const { data: b } = await supabase.from('builder_sessions').select('is_superadmin, expires_at').eq('id', bid).single();
    if (!b || new Date(b.expires_at) < new Date()) return { ok: false, status: 401, error: 'Builder session expired. Please reopen from the admin portal.' };
    if (!b.is_superadmin) return { ok: false, status: 403, error: 'Superadmin access required' };
    return { ok: true, actor: 'superadmin' };
  }
  return { ok: false, status: 401, error: 'Unauthorized' };
}

async function handleRequest(event, headers) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase.from('site_layouts').select('layout, updated_at').eq('key', LAYOUT_KEY).maybeSingle();
    if (error) {
      // Table missing (migration not run) must never break the builder — it
      // keeps using the static flyer-layout.json.
      console.warn('flyer-layout GET failed:', error.message);
      return { statusCode: 200, headers, body: JSON.stringify({ layout: null, degraded: true }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ layout: data ? data.layout : null, updatedAt: data ? data.updated_at : null }) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const auth = await authorize(supabase, event);
  if (!auth.ok) return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };

  if ((event.body || '').length > MAX_BYTES) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Layout too large' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const src = body.layout;
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'layout object required' }) };
  }
  // Keep only the top-level keys applyLayout() understands.
  const layout = {};
  for (const k of TOP_KEYS) if (src[k] !== undefined) layout[k] = src[k];
  if (!Object.keys(layout).length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'layout has no recognised keys' }) };
  }

  // Snapshot the OUTGOING value first. This is a full-snapshot replace with no
  // other record of the previous layout, so history is the only undo path.
  // Best-effort: a history failure must not block the save.
  const { data: prev } = await supabase
    .from('site_layouts').select('layout, updated_by').eq('key', LAYOUT_KEY).maybeSingle();
  if (prev && prev.layout) {
    const { error: hErr } = await supabase.from('site_layout_history')
      .insert({ key: LAYOUT_KEY, layout: prev.layout, saved_by: prev.updated_by || null });
    if (hErr) console.warn('site_layout_history insert failed (non-fatal):', hErr.message);
  }

  const { error } = await supabase.from('site_layouts').upsert(
    { key: LAYOUT_KEY, layout, updated_at: new Date().toISOString(), updated_by: auth.actor },
    { onConflict: 'key' }
  );
  if (error) {
    console.error('flyer-layout upsert error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save layout' }) };
  }

  logAudit(supabase, event, {
    action: 'layout.save', target: LAYOUT_KEY,
    details: { keys: Object.keys(layout), bytes: JSON.stringify(layout).length, hadPrevious: !!(prev && prev.layout) },
  });
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, keys: Object.keys(layout) }) };
}
