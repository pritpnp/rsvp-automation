const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const zone      = String(body.zone || '').trim();
  const name      = String(body.name || '').trim();
  const eventName = String(body.eventName || '').trim();
  const guests    = Math.max(1, parseInt(body.guests, 10) || 1);

  if (!zone || !name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name is required.' }) };
  }
  // Reject junk names — the recurring data-quality problem is people typing the
  // guest count (e.g. "4 people") into the name box. Require at least one letter
  // and no digits; the guest count belongs in the Number of Guests field.
  if (!/[a-zA-Z]/.test(name)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter your name using letters.' }) };
  }
  if (/[0-9]/.test(name)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Your name can\'t contain numbers — please put the guest count in the Number of Guests box.' }) };
  }
  if (guests > 100) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Guest count is too high — please contact the organizer directly.' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Honor the admin's RSVP on/off toggle. Same logic the rendered page
  // uses, but enforced server-side so a stale tab can't slip submissions
  // through after RSVPs are closed.
  const { data: settings, error: settingsErr } = await supabase
    .from('rsvp_settings')
    .select('zone, enabled')
    .in('zone', ['global', zone]);

  if (settingsErr) {
    console.error('rsvp_settings read failed', settingsErr);
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Could not verify RSVP status. Please try again in a moment.' }) };
  }

  const globalEnabled = settings?.find(s => s.zone === 'global')?.enabled !== false;
  const zoneEnabled   = settings?.find(s => s.zone === zone)?.enabled    !== false;
  if (!globalEnabled || !zoneEnabled) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'RSVPs are currently closed for this event.' }) };
  }

  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();

  // Supabase write is the source of truth. If this fails, the RSVP is
  // genuinely lost — return an error so the user can retry.
  const { error: dbError } = await supabase
    .from('rsvps')
    .insert([{
      id,
      zone,
      name,
      guests,
      event_name: eventName,
      submitted_at: submittedAt,
      sheet_row_id: id
    }]);

  if (dbError) {
    console.error('Supabase RSVP insert failed:', dbError);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save your RSVP. Please try again.' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id }) };
};
