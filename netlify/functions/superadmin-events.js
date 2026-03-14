const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const adminPassword = event.headers['x-admin-password'];
  const managerToken = event.headers['x-manager-token'];
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  // Check if superadmin (password or superadmin session token)
  let isSuperadmin = adminPassword === process.env.ADMIN_PASSWORD;
  let authed = isSuperadmin;

  if (!authed && managerToken) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', managerToken)
      .single();
    if (session && new Date(session.expires_at) > new Date()) {
      authed = true;
      if (!session.manager_id) isSuperadmin = true; // superadmin session
    }
  }

  if (!authed) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .order('start_date', { ascending: true });
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  if (!isSuperadmin) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Only superadmin can modify events' }) };
  }

  if (event.httpMethod === 'POST') {
    const { event_name, start_date, end_date, start_time, end_time, max_passes, notes } = JSON.parse(event.body);
    if (!event_name || !start_date || !end_date) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }
    const { data, error } = await supabase
      .from('events')
      .insert([{ event_name, start_date, end_date, start_time: start_time || '', end_time: end_time || '', max_passes: max_passes || 50, notes: notes || '' }])
      .select()
      .single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  if (event.httpMethod === 'PATCH') {
    const { id, event_name, start_date, end_date, start_time, end_time, max_passes, notes } = JSON.parse(event.body);
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const { data, error } = await supabase
      .from('events')
      .update({ event_name, start_date, end_date, start_time: start_time || '', end_time: end_time || '', max_passes, notes })
      .eq('id', id)
      .select()
      .single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  if (event.httpMethod === 'DELETE') {
    const { id } = JSON.parse(event.body);
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const { error } = await supabase.from('events').delete().eq('id', id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
