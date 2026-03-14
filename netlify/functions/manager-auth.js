const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const SUPERADMIN_PERMISSIONS = {
  view_passes: true, create_delete_passes: true, edit_passes: true,
  view_rsvps: true, edit_rsvps: true, delete_rsvps: true,
  manage_managers: true, manage_events: true
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
  const path = event.path.replace('/.netlify/functions/manager-auth', '') || '/';

  // POST /login
  if (event.httpMethod === 'POST' && path === '/login') {
    const { username, password } = JSON.parse(event.body);
    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    // Superadmin check
    if (username.toLowerCase().trim() === 'admin') {
      if (password === process.env.ADMIN_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        // Store superadmin session in a special way
        const { error: insertErr } = await supabase.from('manager_sessions').insert([{
          manager_id: null,
          token,
          expires_at
        }]);
        if (insertErr) console.error('Session insert error:', insertErr.message);
        return { statusCode: 200, headers, body: JSON.stringify({
          token, username: 'admin', role: 'superadmin', permissions: SUPERADMIN_PERMISSIONS
        })};
      }
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid username or password' }) };
    }

    // Manager check
    const { data: manager, error } = await supabase
      .from('managers')
      .select('id, username, password_hash, permissions')
      .eq('username', username.toLowerCase().trim())
      .single();

    if (error || !manager) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid username or password' }) };
    }

    const valid = await bcrypt.compare(password, manager.password_hash);
    if (!valid) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid username or password' }) };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('manager_sessions').insert([{ manager_id: manager.id, token, expires_at }]);

    return { statusCode: 200, headers, body: JSON.stringify({
      token, username: manager.username, role: 'manager', permissions: manager.permissions
    })};
  }

  // POST /logout
  if (event.httpMethod === 'POST' && path === '/logout') {
    const { token } = JSON.parse(event.body);
    if (token) await supabase.from('manager_sessions').delete().eq('token', token);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // GET /verify
  if (event.httpMethod === 'GET' && path === '/verify') {
    const token = event.queryStringParameters?.token;
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };

    // First check if it's a superadmin session (no manager_id)
    const { data: rawSession } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', token)
      .single();

    if (!rawSession || new Date(rawSession.expires_at) < new Date()) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired' }) };
    }

    // Superadmin session — manager_id is null
    if (!rawSession.manager_id) {
      return { statusCode: 200, headers, body: JSON.stringify({
        valid: true, username: 'admin', role: 'superadmin', permissions: SUPERADMIN_PERMISSIONS
      })};
    }

    // Manager session — fetch manager details
    const { data: session, error: sessionErr } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at, managers(username, permissions)')
      .eq('token', token)
      .single();

    if (sessionErr) console.error('Session fetch error:', sessionErr.message);
    if (!session || !session.managers) {
      // Fallback: fetch manager directly
      const { data: manager } = await supabase
        .from('managers')
        .select('username, permissions')
        .eq('id', rawSession.manager_id)
        .single();
      if (!manager) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Manager not found' }) };
      return { statusCode: 200, headers, body: JSON.stringify({
        valid: true, username: manager.username, role: 'manager', permissions: manager.permissions
      })};
    }

    return { statusCode: 200, headers, body: JSON.stringify({
      valid: true,
      username: session.managers.username,
      role: 'manager',
      permissions: session.managers.permissions
    })};
  }

  return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
};
