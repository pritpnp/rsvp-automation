const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const id = event.queryStringParameters?.id;
  if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY  // ← match the actual env var name
    );

  const { data, error } = await supabase
    .from('vip_passes')
    .select('id, guest_name, event_name, event_date, event_id')
    .eq('id', id)
    .single();

  if (error || !data) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Pass not found' }) };
  }

  // VIP parking is read live from the event, not copied onto the pass, so a
  // location edited after passes went out reaches every pass already sent.
  // Deliberately a SEPARATE query whose failure is ignored: if the parking
  // columns do not exist yet (migration not run) or the event was deleted, the
  // pass must still load — just without the parking panel. Folding this into
  // the query above would turn every valid pass into "Pass not found".
  let parking = null;
  if (data.event_id) {
    const { data: evt, error: evtErr } = await supabase
      .from('events')
      .select('vip_parking, vip_parking_note')
      .eq('id', data.event_id)
      .single();
    const location = !evtErr && evt ? String(evt.vip_parking || '').trim() : '';
    if (location) parking = { location, note: String(evt.vip_parking_note || '').trim() };
  }

  const { event_id, ...pass } = data;
  return { statusCode: 200, headers, body: JSON.stringify({ ...pass, parking }) };
};
