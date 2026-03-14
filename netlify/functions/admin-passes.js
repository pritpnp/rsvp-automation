const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

async function authenticate(event, supabase) {
  const adminPassword = event.headers['x-admin-password'];
  if (adminPassword === process.env.ADMIN_PASSWORD) {
    return { ok: true, role: 'superadmin', permissions: { view_passes: true, create_delete_passes: true, edit_passes: true } };
  }

  const token = event.headers['x-manager-token'];
  if (token) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at, managers(username, permissions)')
      .eq('token', token)
      .single();
    if (session && new Date(session.expires_at) > new Date()) {
      return {
        ok: true,
        role: 'manager',
        username: session.managers.username,
        permissions: session.managers.permissions || { view_passes: true, create_delete_passes: false, edit_passes: false }
      };
    }
  }
  return { ok: false };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
  const auth = await authenticate(event, supabase);

  if (!auth.ok) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // GET — requires view_passes
  if (event.httpMethod === 'GET') {
    if (!auth.permissions.view_passes) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to view passes' }) };
    }
    const event_id = event.queryStringParameters?.event_id;
    let query = supabase
      .from('vip_passes')
      .select('*, events(event_name, start_date)')
      .order('created_at', { ascending: false });
    if (event_id) query = query.eq('event_id', event_id);
    const { data, error } = await query;
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // POST — requires create_delete_passes
  if (event.httpMethod === 'POST') {
    if (!auth.permissions.create_delete_passes) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to create passes' }) };
    }
    const { guest_name, event_id } = JSON.parse(event.body);
    if (!guest_name || !event_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    const { data: evt } = await supabase.from('events').select('max_passes, event_name, start_date, end_date').eq('id', event_id).single();
    const { count } = await supabase.from('vip_passes').select('*', { count: 'exact', head: true }).eq('event_id', event_id);
    if (evt && count >= evt.max_passes) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Max passes (${evt.max_passes}) reached for this event` }) };
    }
    const event_date = evt?.start_date === evt?.end_date
      ? evt?.start_date
      : `${evt?.start_date} – ${evt?.end_date}`;
    const { data, error } = await supabase
      .from('vip_passes')
      .insert([{ guest_name, event_id, event_name: evt?.event_name || '', event_date }])
      .select()
      .single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // DELETE — requires create_delete_passes
  if (event.httpMethod === 'DELETE') {
    if (!auth.permissions.create_delete_passes) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to delete passes' }) };
    }
    const { id } = JSON.parse(event.body);
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const { error } = await supabase.from('vip_passes').delete().eq('id', id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // PATCH — requires edit_passes
  if (event.httpMethod === 'PATCH') {
    if (!auth.permissions.edit_passes) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to edit passes' }) };
    }
    const { id, guest_name } = JSON.parse(event.body);
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const { data, error } = await supabase.from('vip_passes').update({ guest_name }).eq('id', id).select().single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
