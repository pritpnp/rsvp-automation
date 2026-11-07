// Creating and validating VIP passes — shared by the admin portal
// (netlify/functions/admin-passes.js) and the Telegram VIP group's /invite
// (netlify/functions/telegram-webhook.js), so a pass made either way passes the
// same checks: 10-digit US numbers, up to MAX_PHONES per pass, no number on two
// passes in one event, the event's max_passes, and a cleaned note.

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
  const s = String(v == null ? '' : v)
    .toWellFormed()                                   // a lone half of an emoji becomes U+FFFD
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')    // control characters (e.g. from a cp1252 CSV)
    .replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, NOTE_MAX).join('').trim();   // whole characters, never half an emoji
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

// One pass. Returns { status: 200, pass } or { status, error }; the caller
// writes the audit entry (it knows who acted). Behaviour is exactly the admin
// portal's single create, which now calls this.
async function createVipPass(supabase, { guest_name, phone, extra_phones, note: rawNote, event_id }) {
  const note = cleanNote(rawNote);
  if (!guest_name || !event_id) return { status: 400, error: 'Missing fields' };
  const ph = preparePhones(phone, extra_phones);
  if (ph.error) return { status: 400, error: ph.error };

  // Reject a number already on a pass for this event
  const ev = await loadEventPhones(supabase, event_id);
  if (ev.error) return { status: 500, error: ev.error };
  const clash = findConflict(ev.passes, ph.all);
  if (clash) return { status: 400, error: conflictMessage(clash) };

  const { data: evt } = await supabase.from('events').select('max_passes, event_name, start_date, end_date').eq('id', event_id).single();
  if (!evt) return { status: 400, error: 'Event not found' };
  const { count } = await supabase.from('vip_passes').select('*', { count: 'exact', head: true }).eq('event_id', event_id);
  if (count >= evt.max_passes) return { status: 400, error: `Max passes (${evt.max_passes}) reached for this event` };
  const event_date = evt?.start_date === evt?.end_date
    ? evt?.start_date
    : `${evt?.start_date} – ${evt?.end_date}`;
  const { data, error } = await supabase
    .from('vip_passes')
    .insert([{ guest_name, phone: ph.primaryRaw, phone_normalized: ph.primary, ...(ph.extras.length ? { extra_phones: ph.extras } : {}), ...(note ? { note } : {}), event_id, event_name: evt?.event_name || '', event_date }])
    .select()
    .single();
  if (error) return { status: 500, error: dbError(error) };
  return { status: 200, pass: data };
}

module.exports = {
  normalizePhone, isValidPhone, MAX_PHONES, preparePhones,
  loadEventPhones, findConflict, conflictMessage,
  NOTE_MAX, cleanNote, dbError, createVipPass,
};
