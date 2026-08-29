// Shared audit-logging helper.
//
// Records who / what / when for manager logins and every state-changing manager
// action into the `audit_log` table. It is deliberately FIRE-AND-FORGET: it never
// awaits and never throws, so a logging failure — including the table not existing
// yet — can never break or slow the action being audited.
//
// Call sites are uniform and do NOT thread actor identity:
//   logAudit(supabase, event, { action: 'flyer.upload', target: zone, details: {...} })
// The actor (superadmin vs which manager) is derived, in the background, from the
// SAME auth credential the request already carries (x-manager-token /
// x-admin-password / x-builder-session). Login is the one exception (no session
// exists yet), so it passes an explicit actorName / isSuperadmin.

function getClientIp(event) {
  const h = (event && event.headers) || {};
  return h['x-nf-client-connection-ip']                       // Netlify's true client IP
      || (h['x-forwarded-for'] || '').split(',')[0].trim()
      || h['client-ip']
      || 'unknown';
}

function logAudit(supabase, event, entry) {
  try {
    const h  = (event && event.headers) || {};
    const ip = getClientIp(event);
    const ua = (h['user-agent'] || '').slice(0, 400) || null;

    const doInsert = (actorName, actorId, isSuper) => {
      supabase.from('audit_log').insert([{
        actor_id:      actorId != null ? String(actorId) : null,
        actor_name:    actorName || (isSuper ? 'admin' : 'unknown'),
        is_superadmin: !!isSuper,
        action:        entry.action,
        target:        entry.target != null ? String(entry.target) : null,
        details:       entry.details || null,
        success:       entry.success !== false,
        ip,
        user_agent:    ua,
      }]).then(() => {}, () => {});   // swallow all errors — never blocks the caller
    };

    // Fill in a missing username from the manager id (keeps the log readable even
    // after the manager is later deleted), then insert. All in the background.
    const finish = (actorName, actorId, isSuper) => {
      if (actorName || isSuper || actorId == null) return doInsert(actorName, actorId, isSuper);
      supabase.from('managers').select('username').eq('id', actorId).single()
        .then(({ data }) => doInsert(data && data.username, actorId, false), () => doInsert(null, actorId, false));
    };

    // 1) Explicit actor from the caller (login: no session row exists yet).
    if (entry.actorName || entry.isSuperadmin || entry.actorId != null) {
      return finish(entry.actorName, entry.actorId, entry.isSuperadmin);
    }

    // 2) Otherwise derive the actor from the request's own auth credential.
    if (h['x-admin-password'] && h['x-admin-password'] === process.env.ADMIN_PASSWORD) {
      return finish('admin', null, true);
    }
    if (h['x-manager-token']) {
      return supabase.from('manager_sessions').select('manager_id').eq('token', h['x-manager-token']).single()
        .then(({ data }) => finish(null, data && data.manager_id, !!data && data.manager_id == null),
              () => finish(null, null, false));
    }
    if (h['x-builder-session']) {
      return supabase.from('builder_sessions').select('manager_id, is_superadmin').eq('id', h['x-builder-session']).single()
        .then(({ data }) => finish(null, data && data.manager_id, !!(data && data.is_superadmin)),
              () => finish(null, null, false));
    }
    return finish(null, null, false);
  } catch (_) {
    /* never let auditing break the caller */
  }
}

module.exports = { logAudit, getClientIp };
