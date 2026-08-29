const { createClient } = require('@supabase/supabase-js');
const { logAudit } = require('./_audit');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// Supabase `rsvps` is the sole source of truth. The legacy Google Sheet
// mirror was retired — the admin portal reads and writes Supabase only.

async function authCheck(event) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const adminPassword = event.headers['x-admin-password'];
  const managerToken = event.headers['x-manager-token'];
  if (adminPassword === process.env.ADMIN_PASSWORD) {
    return { ok: true, permissions: { view_rsvps: true, edit_rsvps: true, delete_rsvps: true } };
  }
  if (managerToken) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', managerToken)
      .single();
    if (session && new Date(session.expires_at) > new Date()) {
      if (!session.manager_id) {
        return { ok: true, permissions: { view_rsvps: true, edit_rsvps: true, delete_rsvps: true } };
      }
      const { data: manager } = await supabase
        .from('managers')
        .select('permissions')
        .eq('id', session.manager_id)
        .single();
      return { ok: true, permissions: manager?.permissions || {} };
    }
  }
  return { ok: false };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_SERVICE_KEY not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Service misconfigured' }) };
  }

  const authResult = await authCheck(event);
  if (!authResult.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  const perms = authResult.permissions;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // GET — all RSVPs from Supabase
  if (event.httpMethod === 'GET') {
    if (!perms.view_rsvps) return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to view RSVPs' }) };

    const { data: supabaseRows, error: dbErr } = await supabase
      .from('rsvps')
      .select('zone, name, guests, submitted_at, sheet_row_id')
      .order('submitted_at', { ascending: false });

    if (dbErr) {
      console.error('Supabase read failed:', dbErr);
      // Don't fall through silently — surface the error rather than show
      // partial data that could mislead a manager. (Sheet-only fallback
      // would be confusing.)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load RSVPs from Supabase: ' + dbErr.message }) };
    }

    const fromSupabase = (supabaseRows || []).map(r => ({
      zone:         r.zone,
      name:         r.name,
      guests:       String(r.guests),
      submitted:    r.submitted_at || '',
      powerapps_id: r.sheet_row_id || ''
    }));

    return { statusCode: 200, headers, body: JSON.stringify(fromSupabase) };
  }

  // PATCH — update guest count (Supabase).
  if (event.httpMethod === 'PATCH') {
    if (!perms.edit_rsvps) return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to edit RSVPs' }) };
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const { powerapps_id, guests } = body;
    if (!powerapps_id || guests === undefined) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    const newGuests = parseInt(guests, 10);
    if (!Number.isFinite(newGuests) || newGuests < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Guest count must be at least 1' }) };
    }

    // Supabase first — by sheet_row_id (the cross-store key)
    const { error: dbErr } = await supabase
      .from('rsvps')
      .update({ guests: newGuests })
      .eq('sheet_row_id', powerapps_id);
    if (dbErr) {
      console.error('Supabase PATCH failed:', dbErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update RSVP: ' + dbErr.message }) };
    }

    logAudit(supabase, event, { action: 'rsvp.edit', target: powerapps_id, details: { guests: newGuests } });
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // DELETE — remove row (Supabase)
  if (event.httpMethod === 'DELETE') {
    if (!perms.delete_rsvps) return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to delete RSVPs' }) };
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const { powerapps_id } = body;
    if (!powerapps_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

    const { error: dbErr } = await supabase
      .from('rsvps')
      .delete()
      .eq('sheet_row_id', powerapps_id);
    if (dbErr) {
      console.error('Supabase DELETE failed:', dbErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to delete RSVP: ' + dbErr.message }) };
    }

    logAudit(supabase, event, { action: 'rsvp.delete', target: powerapps_id });
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
