const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const VALID_ZONES = [
  'scranton', 'mountain-top', 'moosic', 'bloomsburg',
  'satsang-sabha', 'mandir-1', 'mandir-2', 'mandir-3', 'mandir-4', 'mandir-5'
];

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-manager-token, Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── Auth — required for both GET and POST ─────────────────────────────────
  const token = event.headers['x-manager-token'];
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: session, error: sessionErr } = await supabase
    .from('manager_sessions')
    .select('manager_id, expires_at')
    .eq('token', token)
    .single();

  if (sessionErr || !session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
  if (new Date(session.expires_at) < new Date()) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired' }) };

  // Superadmin only — manager_id is null for superadmin sessions
  if (session.manager_id !== null) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Superadmin access required' }) };
  }

  // ── GET — return all zone event names ─────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('zone_events')
      .select('zone, event_name, updated_at')
      .order('zone');

    if (error) {
      console.error('Supabase GET error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch zone names' }) };
    }

    // Return as a zone-keyed object for easy lookup in the admin UI
    const result = {};
    for (const row of (data || [])) {
      result[row.zone] = { eventName: row.event_name, updatedAt: row.updated_at };
    }
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  }

  // ── POST — update a zone event name ───────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { zone, eventName } = body;
    if (!zone || !eventName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'zone and eventName are required' }) };
    }
    if (!VALID_ZONES.includes(zone)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid zone: ${zone}` }) };
    }
    if (eventName.trim().length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'eventName cannot be empty' }) };
    }
    if (eventName.length > 200) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'eventName too long (max 200 chars)' }) };
    }

    const { error } = await supabase
      .from('zone_events')
      .upsert({ zone, event_name: eventName.trim(), updated_at: new Date().toISOString() });

    if (error) {
      console.error('Supabase upsert error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update event name' }) };
    }

    console.log(`✅ Zone event name updated: ${zone} → "${eventName.trim()}"`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zone, eventName: eventName.trim() }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
