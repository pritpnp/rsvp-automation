const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { logAudit } = require('./_audit');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// Superadmin-only CRUD for volunteer accounts. Volunteers sign in at /scan
// (netlify/functions/volunteer-scan.js) and can only look up and check in VIP
// passes. They live in their own `volunteers` table, never in `managers`.

const NOT_SET_UP = 'Volunteers are not set up in the database yet — run the volunteers SQL (scripts/migrations/2026-11-05-add-volunteers-and-checkins.sql) in Supabase, then try again.';

function isMissingTable(error) {
  const m = (error && error.message) || '';
  return !!error && (error.code === '42P01' || error.code === 'PGRST205' ||
                     (/volunteer/.test(m) && /(does not exist|schema cache)/i.test(m)));
}

function fail(error) {
  if (isMissingTable(error)) return { statusCode: 503, headers, body: JSON.stringify({ error: NOT_SET_UP }) };
  const msg = error.code === '23505' ? 'That username is already taken' : (error.message || 'Database error');
  return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
}

function cleanUsername(u) { return String(u || '').toLowerCase().trim(); }

function parseBody(event) {
  try { return JSON.parse(event.body || '{}') || {}; } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const adminPassword = event.headers['x-admin-password'];
  const managerToken = event.headers['x-manager-token'];
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
  let isSuperadmin = !!process.env.ADMIN_PASSWORD && !!adminPassword && adminPassword === process.env.ADMIN_PASSWORD;

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

  if (!isSuperadmin) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // GET — list volunteers
  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('volunteers')
      .select('id, username, created_at')
      .order('created_at', { ascending: false });
    if (error) return fail(error);
    return { statusCode: 200, headers, body: JSON.stringify(data || []) };
  }

  const body = parseBody(event);
  if (!body) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };

  // POST — add volunteer
  if (event.httpMethod === 'POST') {
    const username = cleanUsername(body.username);
    const password = String(body.password || '');
    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please fill in both username and password' }) };
    }
    if (password.length < 4) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 4 characters' }) };
    }
    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('volunteers')
      .insert([{ username, password_hash }])
      .select('id, username, created_at')
      .single();
    if (error) return fail(error);
    logAudit(supabase, event, { action: 'volunteer.create', target: data.username });
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // PATCH — rename and/or set a new password. A new password signs the
  // volunteer out everywhere, so an old phone cannot keep scanning.
  if (event.httpMethod === 'PATCH') {
    const { id } = body;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const updates = {};
    const username = cleanUsername(body.username);
    const password = String(body.password || '');
    if (username) updates.username = username;
    if (password) {
      if (password.length < 4) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 4 characters' }) };
      }
      updates.password_hash = await bcrypt.hash(password, 10);
    }
    if (!Object.keys(updates).length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nothing to change' }) };
    }
    const { data, error } = await supabase
      .from('volunteers')
      .update(updates)
      .eq('id', id)
      .select('id, username, created_at')
      .single();
    if (error) return fail(error);
    if (password) await supabase.from('volunteer_sessions').delete().eq('volunteer_id', id);
    logAudit(supabase, event, { action: 'volunteer.update', target: data.username, details: { password_changed: !!password } });
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // DELETE — remove volunteer. Their sessions go too (on delete cascade; the
  // explicit delete covers a table created without the cascade).
  if (event.httpMethod === 'DELETE') {
    const { id } = body;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    await supabase.from('volunteer_sessions').delete().eq('volunteer_id', id);
    const { error } = await supabase.from('volunteers').delete().eq('id', id);
    if (error) return fail(error);
    logAudit(supabase, event, { action: 'volunteer.delete', target: id });
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
