const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// Read-only view of past-event RSVPs in rsvps_archive. Uses the same
// permission as the live RSVP view (view_rsvps); archive is a sibling
// concept, not a separate sensitivity level.
//
// GET params (all optional):
//   zone        — restrict to one zone
//   event_date  — restrict to one event date (YYYY-MM-DD)
//   q           — case-insensitive name search
//
// Response also includes the distinct list of zones and event_dates
// present in the archive, so the admin can populate filter dropdowns
// without a second round-trip.

async function authCheck(event) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
  const adminPassword = event.headers['x-admin-password'];
  const managerToken = event.headers['x-manager-token'];
  if (adminPassword === process.env.ADMIN_PASSWORD) {
    return { ok: true, permissions: { view_rsvps: true } };
  }
  if (managerToken) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', managerToken)
      .single();
    if (session && new Date(session.expires_at) > new Date()) {
      if (!session.manager_id) return { ok: true, permissions: { view_rsvps: true } };
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
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = await authCheck(event);
  if (!auth.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  if (!auth.permissions.view_rsvps) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to view RSVPs' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
  const q          = (event.queryStringParameters?.q || '').trim();
  const zoneFilter = (event.queryStringParameters?.zone || '').trim();
  const dateFilter = (event.queryStringParameters?.event_date || '').trim();

  let query = supabase
    .from('rsvps_archive')
    .select('id, zone, name, guests, event_name, submitted_at, sheet_row_id, event_date, archived_at')
    .order('archived_at', { ascending: false })
    .order('submitted_at', { ascending: false });

  if (zoneFilter) query = query.eq('zone', zoneFilter);
  if (dateFilter) query = query.eq('event_date', dateFilter);
  if (q)          query = query.ilike('name', `%${q}%`);

  const { data, error } = await query;
  if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

  const rows = (data || []).map(r => ({
    id:           r.id,
    zone:         r.zone,
    name:         r.name,
    guests:       String(r.guests),
    submitted:    r.submitted_at || '',
    powerapps_id: r.sheet_row_id || '',
    event_name:   r.event_name || '',
    event_date:   r.event_date || '',
    archived_at:  r.archived_at || ''
  }));

  // Pull the distinct dropdown options separately so the admin can populate
  // them even when the current filter narrows the result set to one zone.
  const { data: facets } = await supabase
    .from('rsvps_archive')
    .select('zone, event_date');
  const zones      = [...new Set((facets || []).map(r => r.zone).filter(Boolean))].sort();
  const eventDates = [...new Set((facets || []).map(r => r.event_date).filter(Boolean))].sort().reverse();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ rows, zones, event_dates: eventDates })
  };
};
