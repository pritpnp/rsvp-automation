const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase
    .from('rsvp_settings')
    .select('zone, enabled');

  if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

  // Convert to { zone: enabled } map
  const result = {};
  for (const row of (data || [])) {
    result[row.zone] = row.enabled;
  }

  // Default all zones to enabled if not set
  const ALL_ZONES = ['global', 'scranton', 'mountain-top', 'moosic', 'bloomsburg', 'satsang-sabha', 'mandir-1', 'mandir-2', 'mandir-3', 'mandir-4', 'mandir-5'];
  for (const zone of ALL_ZONES) {
    if (result[zone] === undefined) result[zone] = true;
  }

  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
