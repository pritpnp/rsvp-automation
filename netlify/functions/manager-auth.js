const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const path = event.path.replace('/.netlify/functions/manager-auth', '') || '/';

  // POST /login
  if (event.httpMethod === 'POST' && path === '/login') {
    const { username, password } = JSON.parse(event.body);
    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    const { data: manager, error } = await supabase
      .from('managers')
      .select('id, username, password_hash')
      .eq('username', username.toLowerCase().trim())
      .single();

    if (error || !manager) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid username or password' }) };
    }

    const valid = await bcrypt.compare(password, manager.password_hash);
    if (!valid) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid username or password' }) };
    }

    // Create session token (expires in 24 hours)
    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await supabase.from('manager_sessions').insert([{ manager_id: manager.id, token, expires_at }]);

    return { statusCode: 200, headers, body: JSON.stringify({ token, username: manager.username }) };
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

    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at, managers(username)')
      .eq('token', token)
      .single();

    if (!session || new Date(session.expires_at) < new Date()) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ valid: true, username: session.managers.username }) };
  }

  return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
};
