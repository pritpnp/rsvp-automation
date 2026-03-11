const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Password check
  const adminPassword = event.headers['x-admin-password'];
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  // GET — list all passes
  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('vip_passes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // POST — create a new pass
  if (event.httpMethod === 'POST') {
    const { guest_name, event_name, event_date } = JSON.parse(event.body);
    if (!guest_name || !event_name || !event_date) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    const { data, error } = await supabase
      .from('vip_passes')
      .insert([{ guest_name, event_name, event_date }])
      .select()
      .single();

    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // DELETE — delete a pass by id
  if (event.httpMethod === 'DELETE') {
    const { id } = JSON.parse(event.body);
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

    const { error } = await supabase
      .from('vip_passes')
      .delete()
      .eq('id', id);

    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
