const { createClient } = require('@supabase/supabase-js');
const { logAudit } = require('./_audit');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// Phone/note validation and single-pass creation live in ../lib/vip-passes.js,
// shared with the Telegram VIP group's /invite so both apply the same checks.
const {
  normalizePhone, isValidPhone, MAX_PHONES, preparePhones,
  loadEventPhones, findConflict, conflictMessage,
  NOTE_MAX, cleanNote, dbError, createVipPass,
} = require('../lib/vip-passes');

async function authenticate(event, supabase) {
  const adminPassword = event.headers['x-admin-password'];
  if (!!process.env.ADMIN_PASSWORD && !!adminPassword && adminPassword === process.env.ADMIN_PASSWORD) {
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

      // Validate each row has name + valid phone(s)
      const prepared = [];
      for (let i = 0; i < guests.length; i++) {
        const g = guests[i];
        const name = (typeof g === 'string' ? g : g?.name || '').trim();
        const rawPhone = typeof g === 'object' ? (g?.phone || '') : '';
        if (!name) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `Row ${i + 1}: missing name` }) };
        }
        const ph = preparePhones(rawPhone, typeof g === 'object' ? g?.extra_phones : null);
        if (ph.error) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `Row ${i + 1} (${name}): ${ph.error}` }) };
        }
        prepared.push({ name, row: i + 1, phone: ph.primaryRaw, phone_normalized: ph.primary, extras: ph.extras, all: ph.all,
          note: typeof g === 'object' ? cleanNote(g?.note) : '' });
      }

      // Reject a number shared by two rows of the same upload
      const seen = new Map();
      for (const p of prepared) {
        for (const n of p.all) {
          if (seen.has(n)) {
            const other = seen.get(n);
            return { statusCode: 400, headers, body: JSON.stringify({ error: `Rows ${other.row} (${other.name}) and ${p.row} (${p.name}) share the number ${n}. Two people can't share a number.` }) };
          }
          seen.set(n, p);
        }
      }

      // Reject numbers already on a pass for this event
      const ev = await loadEventPhones(supabase, event_id);
      if (ev.error) return { statusCode: 500, headers, body: JSON.stringify({ error: ev.error }) };
      for (const p of prepared) {
        const c = findConflict(ev.passes, p.all);
        if (c) return { statusCode: 400, headers, body: JSON.stringify({ error: `Row ${p.row} (${p.name}): ${conflictMessage(c)}` }) };
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

      // extra_phones goes on EVERY row or none: a bulk insert fills a key some
      // rows lack with NULL, which the NOT NULL column rejects. Left out
      // entirely when nobody has extras, so uploads keep working before the
      // migration is run.
      const anyExtras = prepared.some(p => p.extras.length);
      // Same for note: on every row or none, and left out when no row has
      // one, so uploads keep working before the notes migration is run.
      const anyNotes = prepared.some(p => p.note);
      const rows = prepared.map(p => ({
        guest_name: p.name,
        phone: p.phone,
        phone_normalized: p.phone_normalized,
        ...(anyExtras ? { extra_phones: p.extras } : {}),
        ...(anyNotes ? { note: p.note } : {}),
        event_id,
        event_name: evt?.event_name || '',
        event_date
      }));

      const { data, error } = await supabase
        .from('vip_passes')
        .insert(rows)
        .select();

      if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: dbError(error) }) };
      logAudit(supabase, event, { action: 'pass.create', target: String(event_id || ''), details: { count: data.length } });
      return { statusCode: 200, headers, body: JSON.stringify({ created: data.length, passes: data }) };
    }

    // ── Single create: { guest_name, phone, event_id } ────────────────────
    const result = await createVipPass(supabase, body);
    if (result.status !== 200) return { statusCode: result.status, headers, body: JSON.stringify({ error: result.error }) };
    logAudit(supabase, event, { action: 'pass.create', target: String(body.event_id || ''), details: { count: 1 } });
    return { statusCode: 200, headers, body: JSON.stringify(result.pass) };
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
      logAudit(supabase, event, { action: 'pass.delete', target: body.ids.join(','), details: { count: body.ids.length } });
      return { statusCode: 200, headers, body: JSON.stringify({ deleted: body.ids.length }) };
    }

    // ── Single delete: { id } ──────────────────────────────────────────────
    const { id } = body;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    const { error } = await supabase.from('vip_passes').delete().eq('id', id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    logAudit(supabase, event, { action: 'pass.delete', target: id });
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

    // Arrivals are recorded by volunteers at /scan (volunteer-scan.js).
    //   { event_id, reset_arrivals: true }  clears the whole event's list
    //                                       (superadmin only), e.g. after testing.
    //   { id, clear_arrival: true }         undoes one pass, e.g. a mistaken scan.
    // A cleared pass checks in afresh, and its next scan messages the team again.
    const NO_ARRIVAL = { checked_in_at: null, checked_in_by: null };
    if (body.reset_arrivals) {
      if (auth.role !== 'superadmin') {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Only the superadmin can reset all arrivals' }) };
      }
      if (!body.event_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing event_id' }) };
      const { data, error } = await supabase
        .from('vip_passes')
        .update(NO_ARRIVAL)
        .eq('event_id', body.event_id)
        .not('checked_in_at', 'is', null)
        .select('id');
      if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: dbError(error) }) };
      logAudit(supabase, event, { action: 'pass.arrivals_reset', target: String(body.event_id), details: { count: (data || []).length } });
      return { statusCode: 200, headers, body: JSON.stringify({ cleared: (data || []).length }) };
    }
    if (body.clear_arrival) {
      if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
      const { data, error } = await supabase.from('vip_passes').update(NO_ARRIVAL).eq('id', body.id).select().single();
      if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: dbError(error) }) };
      logAudit(supabase, event, { action: 'pass.arrival_undo', target: body.id, details: { guest_name: data.guest_name } });
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    const { id, guest_name, phone, extra_phones } = body;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

    const update = {};
    if (typeof guest_name === 'string') update.guest_name = guest_name.trim();
    if (typeof body.note === 'string') update.note = cleanNote(body.note);
    if (typeof phone === 'string') {
      // extra_phones is sent only when the admin portal knows the column
      // exists or extras were typed; omitted, the pass's extras are untouched.
      const extrasGiven = Array.isArray(extra_phones);
      const ph = preparePhones(phone, extrasGiven ? extra_phones : []);
      if (ph.error) return { statusCode: 400, headers, body: JSON.stringify({ error: ph.error }) };
      // Check no other pass for the same event already uses any of these numbers
      const { data: current } = await supabase
        .from('vip_passes')
        .select('event_id')
        .eq('id', id)
        .single();
      if (current) {
        const ev = await loadEventPhones(supabase, current.event_id);
        if (ev.error) return { statusCode: 500, headers, body: JSON.stringify({ error: ev.error }) };
        const clash = findConflict(ev.passes, ph.all, id);
        if (clash) return { statusCode: 400, headers, body: JSON.stringify({ error: conflictMessage(clash) }) };
      }
      update.phone = ph.primaryRaw;
      update.phone_normalized = ph.primary;
      if (extrasGiven) update.extra_phones = ph.extras;
    }

    if (!Object.keys(update).length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nothing to update' }) };
    }

    const { data, error } = await supabase.from('vip_passes').update(update).eq('id', id).select().single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: dbError(error) }) };
    logAudit(supabase, event, { action: 'pass.edit', target: id });
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
