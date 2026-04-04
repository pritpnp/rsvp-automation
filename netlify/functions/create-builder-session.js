const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const token = event.headers['x-manager-token'];
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Verify manager session
  const { data: session } = await supabase
    .from('manager_sessions')
    .select('manager_id, expires_at')
    .eq('token', token)
    .single();

  if (!session || new Date(session.expires_at) < new Date())
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired' }) };

  const isSuperadmin = !session.manager_id;
  let allowedZones = ['scranton','mountain-top','moosic','bloomsburg','satsang-sabha'];
  let allowAdvanced = true;
  let managerId = null;

  if (!isSuperadmin) {
    const { data: manager } = await supabase
      .from('managers')
      .select('id, permissions')
      .eq('id', session.manager_id)
      .single();

    if (!manager?.permissions?.flyer_builder)
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to use flyer builder' }) };

    allowedZones = manager.permissions.flyer_zones || [];
    allowAdvanced = !!manager.permissions.flyer_builder_advanced;
    managerId = manager.id;
  }

  // Create a short-lived builder session
  const { data: builderSession, error } = await supabase
    .from('builder_sessions')
    .insert({
      manager_id: managerId,
      is_superadmin: isSuperadmin,
      allowed_zones: allowedZones,
      allow_advanced: allowAdvanced,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      used: false,
    })
    .select('id')
    .single();

  if (error)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create session' }) };

  return { statusCode: 200, headers, body: JSON.stringify({ sessionId: builderSession.id }) };
};
