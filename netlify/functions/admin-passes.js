const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// Normalize a phone string to digits-only, stripping a leading US "1".
// Returns '' for empty input. A 10-digit result is considered a valid US number.
function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function isValidPhone(normalized) {
  return normalized.length === 10;
}

async function authenticate(event, supabase) {
  const adminPassword = event.headers['x-admin-password'];
  if (adminPassword === process.env.ADMIN_PASSWORD) {
    return { ok: true, role: 'superadmin', permissions: { view_passes: true, create_delete_passes: true, edit_passes: true } };
  }

  const token = event.headers['x-manager-token'];
  if (token) {
    const { data: session } = await supabase
      .from('manager_sessions')
      .select('manager_id, expires_at')
      .eq('token', token)
      .single();
    if (session && new Date(session.expires_at) > new Date()) {
      // Superadmin session — manager_id is null
      if (!session.manager_id) {
        return { ok: true, role: 'superadmin', permissions: { view_passes: true, create_delete_passes: true, edit_passes: true } };
      }
      // Regular manager — fetch directly
      const { data: manager } = await supabase
        .from('managers')
        .select('username, permissions')
        .eq('id', session.manager_id)
        .single();
      return {
        ok: true,
        role: 'manager',
        username: manager?.username || '',
        permissions: manager?.permissions || { view_passes: true, create_delete_passes: false, edit_passes: false }
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

  // POST — single pass OR batch
  if (event.httpMethod === 'POST') {
    if (!auth.permissions.create_delete_passes) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to create passes' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    // ── Batch create: { guests: [{name, phone}, ...], event_id } ────────────
    if (Array.isArray(body.guests)) {
      const { guests, event_id } = body;
      if (!event_id || !guests.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
      }

      // Validate each row has name + valid phone
      const prepared = [];
      for (let i = 0; i < guests.length; i++) {
        const g = guests[i];
        const name = (typeof g === 'string' ? g : g?.name || '').trim();
        const rawPhone = typeof g === 'object' ? (g?.phone || '') : '';
        const phone_normalized = normalizePhone(rawPhone);
        if (!name) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `Row ${i + 1}: missing name` }) };
        }
        if (!isValidPhone(phone_normalized)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `Row ${i + 1} (${name}): phone must be a valid 10-digit US number` }) };
        }
        prepared.push({ name, phone: String(rawPhone).trim(), phone_normalized });
      }

      // Reject duplicate phones within the same batch
      const seen = new Set();
      for (const p of prepared) {
        if (seen.has(p.phone_normalized)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `Duplicate phone in upload: ${p.phone}` }) };
        }
        seen.add(p.phone_normalized);
      }

      // Reject phones that already exist for this event
      const { data: existing } = await supabase
        .from('vip_passes')
        .select('phone_normalized')
        .eq('event_id', event_id)
        .in('phone_normalized', prepared.map(p => p.phone_normalized));
      if (existing && existing.length) {
        const dupes = new Set(existing.map(e => e.phone_normalized));
        const conflict = prepared.find(p => dupes.has(p.phone_normalized));
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Phone ${conflict.phone} already has a pass for this event` }) };
      }

      const { data: evt } = await supabase
        .from('events')
        .select('max_passes, event_name, start_date, end_date')
        .eq('id', event_id)
        .single();

      if (!evt) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Event not found' }) };
      }

      const { count } = await supabase
        .from('vip_passes')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', event_id);

      const remaining = (evt?.max_passes || 0) - (count || 0);
      if (guests.length > remaining) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Only ${remaining} pass slot(s) remaining for this event` }) };
      }

      const event_date = evt?.start_date === evt?.end_date
        ? evt?.start_date
        : `${evt?.start_date} – ${evt?.end_date}`;

      const rows = prepared.map(p => ({
        guest_name: p.name,
        phone: p.phone,
        phone_normalized: p.phone_normalized,
        event_id,
        event_name: evt?.event_name || '',
        event_date
      }));

      const { data, error } = await supabase
        .from('vip_passes')
        .insert(rows)
        .select();

      if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, headers, body: JSON.stringify({ created: data.length, passes: data }) };
    }

    // ── Single create: { guest_name, phone, event_id } ────────────────────
    const { guest_name, phone, event_id } = body;
    if (!guest_name || !event_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    const phone_normalized = normalizePhone(phone);
    if (!isValidPhone(phone_normalized)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Phone must be a valid 10-digit US number' }) };
    }

    // Reject phone already used for this event
    const { data: dupe } = await supabase
      .from('vip_passes')
      .select('id, guest_name')
      .eq('event_id', event_id)
      .eq('phone_normalized', phone_normalized)
      .maybeSingle();
    if (dupe) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `This phone already has a pass for this event (${dupe.guest_name})` }) };
    }

    const { data: evt } = await supabase.from('events').select('max_passes, event_name, start_date, end_date').eq('id', event_id).single();
    if (!evt) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Event not found' }) };
    }
    const { count } = await supabase.from('vip_passes').select('*', { count: 'exact', head: true }).eq('event_id', event_id);
    if (count >= evt.max_passes) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Max passes (${evt.max_passes}) reached for this event` }) };
    }
    const event_date = evt?.start_date === evt?.end_date
      ? evt?.start_date
      : `${evt?.start_date} – ${evt?.end_date}`;
    const { data, error } = await supabase
      .from('vip_passes')
      .insert([{ guest_name, phone: String(phone).trim(), phone_normalized, event_id, event_name: evt?.event_name || '', event_date }])
      .select()
      .single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // DELETE — single OR batch
  if (event.httpMethod === 'DELETE') {
    if (!auth.permissions.create_delete_passes) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No permission to delete passes' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    // ── Batch delete: { ids: ['id1', 'id2', ...] } ────────────────────────
    if (Array.isArray(body.ids)) {
      if (!body.ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No ids provided' }) };
      const { error } = await supabase.from('vip_passes').delete().in('id', body.ids);
      if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, headers, body: JSON.stringify({ deleted: body.ids.length }) };
    }

    // ── Single delete: { id } ──────────────────────────────────────────────
    const { id } = body;
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
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const { id, guest_name, phone } = body;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

    const update = {};
    if (typeof guest_name === 'string') update.guest_name = guest_name.trim();
    if (typeof phone === 'string') {
      const phone_normalized = normalizePhone(phone);
      if (!isValidPhone(phone_normalized)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Phone must be a valid 10-digit US number' }) };
      }
      // Check no other pass for the same event already uses this phone
      const { data: current } = await supabase
        .from('vip_passes')
        .select('event_id')
        .eq('id', id)
        .single();
      if (current) {
        const { data: dupe } = await supabase
          .from('vip_passes')
          .select('id, guest_name')
          .eq('event_id', current.event_id)
          .eq('phone_normalized', phone_normalized)
          .neq('id', id)
          .maybeSingle();
        if (dupe) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `This phone already has a pass for this event (${dupe.guest_name})` }) };
        }
      }
      update.phone = phone.trim();
      update.phone_normalized = phone_normalized;
    }

    if (!Object.keys(update).length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nothing to update' }) };
    }

    const { data, error } = await supabase.from('vip_passes').update(update).eq('id', id).select().single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
