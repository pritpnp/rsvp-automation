const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { sessionId } = body;
  if (!sessionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing sessionId' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: session } = await supabase
    .from('builder_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (!session)
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
  if (session.used)
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session already used' }) };
  if (new Date(session.expires_at) < new Date())
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired' }) };

  // Mark session as used — single use only
  await supabase.from('builder_sessions').update({ used: true }).eq('id', sessionId);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      isSuperadmin: session.is_superadmin,
      allowedZones: session.allowed_zones,
      allowAdvanced: session.allow_advanced,
      // Return a fresh review token — the manager's actual auth token for review submissions
      // We store manager_id so we can look up their permissions in review-flyer.js
      managerId: session.manager_id,
    }),
  };
};
