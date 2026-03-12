const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const adminPassword = event.headers['x-admin-password'];
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  // GET — list all managers
  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('managers')
      .select('id, username, created_at')
      .order('created_at', { ascending: false });
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // POST — create manager
  if (event.httpMethod === 'POST') {
    const { username, password } = JSON.parse(event.body);
    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('managers')
      .insert([{ username: username.toLowerCase().trim(), password_hash }])
      .select('id, username, created_at')
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
