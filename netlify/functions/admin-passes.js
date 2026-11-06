const { createClient } = require('@supabase/supabase-js');
const { logAudit } = require('./_audit');

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

// ── Several numbers on one pass ───────────────────────────────────────────
// A couple who may each come can share one pass and both look it up. The
// first number stays in phone / phone_normalized, exactly as every older pass
// has it; any others go in extra_phones (10-digit strings). Added by
// scripts/migrations/2026-11-04-add-pass-extra-phones.sql.
const MAX_PHONES = 4;

// Returns { primaryRaw, primary, extras, all } or { error }.
function preparePhones(primaryRaw, extrasRaw) {
  const raw = [primaryRaw, ...(Array.isArray(extrasRaw) ? extrasRaw : [])]
    .map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  if (!raw.length) return { error: 'Phone must be a valid 10-digit US number' };
  if (raw.length > MAX_PHONES) return { error: `At most ${MAX_PHONES} phone numbers per pass` };
  const all = [];
  for (const r of raw) {
    const n = normalizePhone(r);
    if (!isValidPhone(n)) return { error: `Phone must be a valid 10-digit US number ("${r}" is not)` };
    if (all.includes(n)) return { error: `${n} is entered twice on this pass` };
    all.push(n);
  }
  return { primaryRaw: raw[0], primary: all[0], extras: all.slice(1), all };
}

// Every number must be unique within its event, whether it is another pass's
// main number or one of its extras — otherwise one phone leads to two people's
// passes and the lookup has to guess. Loads the event's passes and compares
// here rather than with a compound database filter: an event holds at most a
// few hundred passes, and this keeps the check simple and testable.
// Returns { conflict: { guest_name, number } | null } or { error }.
async function loadEventPhones(supabase, event_id) {
  let { data, error } = await supabase.from('vip_passes')
    .select('id, guest_name, phone_normalized, extra_phones').eq('event_id', event_id);
  if (error && /extra_phones/.test(error.message || '')) {
    // Column not added yet (migration not run): only main numbers exist.
    ({ data, error } = await supabase.from('vip_passes')
      .select('id, guest_name, phone_normalized').eq('event_id', event_id));
  }
  if (error) return { error: 'Could not check for duplicate phone numbers. Please try again.' };
  return { passes: data || [] };
}
function findConflict(eventPasses, numbers, excludeId) {
  for (const row of eventPasses) {
    if (excludeId && row.id === excludeId) continue;
    const theirs = [row.phone_normalized, ...(row.extra_phones || [])];
    const hit = numbers.find((n) => theirs.includes(n));
    if (hit) return { guest_name: row.guest_name, number: hit };
  }
  return null;
}
function conflictMessage(c) {
  return `${c.number} is already on ${c.guest_name}'s pass for this event. Two people can't share a number.`;
}
// A pass's private note ("From Allentown", "Core Mark"): trimmed, one line,
// at most 120 characters. Shown to admins, volunteers and the VIP Telegram
// group — never on the guest's own pass.
const NOTE_MAX = 120;
function cleanNote(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
}

function dbError(error) {
  const m = (error && error.message) || 'Database error';
  if (/\bnote\b/.test(m) && /(column|schema cache)/i.test(m)) {
    return 'Pass notes are not set up in the database yet — run the notes SQL (scripts/migrations/2026-11-05-add-pass-notes.sql) in Supabase, then try again.';
  }
  if (/extra_phones/.test(m) && /(column|schema cache)/i.test(m)) {
    return 'Extra phone numbers are not set up in the database yet — run the extra-phones SQL in Supabase, then try again.';
  }
  return m;
}

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
    const { guest_name, phone, extra_phones, event_id } = body;
    const note = cleanNote(body.note);
    if (!guest_name || !event_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }
    const ph = preparePhones(phone, extra_phones);
    if (ph.error) return { statusCode: 400, headers, body: JSON.stringify({ error: ph.error }) };

    // Reject a number already on a pass for this event
    const ev = await loadEventPhones(supabase, event_id);
    if (ev.error) return { statusCode: 500, headers, body: JSON.stringify({ error: ev.error }) };
    const clash = findConflict(ev.passes, ph.all);
    if (clash) return { statusCode: 400, headers, body: JSON.stringify({ error: conflictMessage(clash) }) };

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
      .insert([{ guest_name, phone: ph.primaryRaw, phone_normalized: ph.primary, ...(ph.extras.length ? { extra_phones: ph.extras } : {}), ...(note ? { note } : {}), event_id, event_name: evt?.event_name || '', event_date }])
      .select()
      .single();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: dbError(error) }) };
    logAudit(supabase, event, { action: 'pass.create', target: String(event_id || ''), details: { count: 1 } });
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
