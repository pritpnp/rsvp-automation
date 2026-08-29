const { createClient } = require('@supabase/supabase-js');

const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// Read the audit log. Superadmin only (session with manager_id null, or the
// admin password). Read-only — nothing here mutates state.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── Auth: superadmin only ──────────────────────────────────────────────
    const token   = event.headers['x-manager-token'];
    const adminPw = event.headers['x-admin-password'];
    let ok = false;
    if (adminPw && adminPw === process.env.ADMIN_PASSWORD) {
      ok = true;
    } else if (token) {
      const { data: session } = await supabase
        .from('manager_sessions')
        .select('manager_id, expires_at')
        .eq('token', token)
        .single();
      // manager_id === null marks a superadmin session
      if (session && new Date(session.expires_at) > new Date() && session.manager_id === null) {
        ok = true;
      }
    }
    if (!ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Superadmin access required' }) };

    const q     = event.queryStringParameters || {};
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 200));

    const { data, error } = await supabase
      .from('audit_log')
      .select('created_at, actor_name, is_superadmin, action, target, details, success, ip, user_agent')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('audit_log read failed:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load audit log: ' + error.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(data || []) };
  } catch (e) {
    console.error('superadmin-audit-log error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + e.message }) };
  }
};
