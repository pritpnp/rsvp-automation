const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const adminPassword = event.headers['x-admin-password'];
  const managerToken = event.headers['x-manager-token'];
  let isSuperadmin = adminPassword === process.env.ADMIN_PASSWORD;

  if (!isSuperadmin && managerToken) {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
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

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);

  // GET — list all managers
  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('managers')
      .select('id, username, permissions, created_at')
      .order('created_at', { ascending: false });
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // POST — create manager
  if (event.httpMethod === 'POST') {
    const { username, password, permissions } = JSON.parse(event.body);
    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    const password_hash = await bcrypt.hash(password, 10);
    const perms = permissions || {};
    const { data, error } = await supabase
      .from('managers')
      .insert([{ username: username.toLowerCase().trim(), password_hash, permissions: perms }])
      .select('id, username, permissions, created_at')
      .single();
    if (error) {
      const msg = error.code === '23505' ? 'Username already exists' : error.message;
      return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // PATCH — update manager (username, password, permissions)
  if (event.httpMethod === 'PATCH') {
    const { id, username, password, permissions } = JSON.parse(event.body);
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const updates = {};
    if (username) updates.username = username.toLowerCase().trim();
    if (password) updates.password_hash = await bcrypt.hash(password, 10);
    if (permissions) updates.permissions = permissions;
    const { data, error } = await supabase
      .from('managers')
      .update(updates)
      .eq('id', id)
      .select('id, username, permissions, created_at')
      .single();
    if (error) {
      const msg = error.code === '23505' ? 'Username already exists' : error.message;
      return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // DELETE — delete manager by id
  if (event.httpMethod === 'DELETE') {
    const { id } = JSON.parse(event.body);
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const { error } = await supabase.from('managers').delete().eq('id', id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
