const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── Auth via builder session ──────────────────────────────────────────────
  const builderSessionId = event.headers['x-builder-session'];
  if (!builderSessionId) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Standalone mode — superadmin only, no session validation
  let isSuperadmin = false;
  let managerName = 'Superadmin';
  let allowedZones = [];

  if (builderSessionId === 'standalone') {
    isSuperadmin = true;
  } else {
    const { data: bSession } = await supabase
      .from('builder_sessions')
      .select('*')
      .eq('id', builderSessionId)
      .single();

    if (!bSession || new Date(bSession.expires_at) < new Date())
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Builder session expired. Please reopen from the admin portal.' }) };

    isSuperadmin = bSession.is_superadmin;
    allowedZones = bSession.allowed_zones || [];

    if (!isSuperadmin && bSession.manager_id) {
      const { data: manager } = await supabase
        .from('managers')
        .select('username')
        .eq('id', bSession.manager_id)
        .single();
      managerName = manager?.username || 'Manager';
    }
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { zone, imageBase64, eventData } = body;

  const VALID_ZONES = ['scranton','mountain-top','moosic','bloomsburg','satsang-sabha','satsang-sabha-santos'];
  if (!zone || !VALID_ZONES.includes(zone))
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid zone' }) };

  if (!isSuperadmin && allowedZones.length) {
    const baseZone = zone.replace('-santos', '');
    if (!allowedZones.includes(baseZone) && !allowedZones.includes(zone))
      return { statusCode: 403, headers, body: JSON.stringify({ error: `Not permitted to submit flyers for ${zone}` }) };
  }

  if (!imageBase64)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing image' }) };

  // ── Upload image to Supabase Storage ──────────────────────────────────────
  const reviewId = crypto.randomUUID();
  const storagePath = `${reviewId}/${zone}-flyer.png`;
  const imageBuffer = Buffer.from(imageBase64, 'base64');

  const { error: uploadError } = await supabase.storage
    .from('flyer-reviews')
    .upload(storagePath, imageBuffer, { contentType: 'image/png', upsert: false });

  if (uploadError)
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Storage upload failed: ${uploadError.message}` }) };

  // ── Save review record ────────────────────────────────────────────────────
  await supabase.from('flyer_reviews').insert({
    id: reviewId,
    zone,
    storage_path: storagePath,
    event_data: eventData || {},
    status: 'pending',
    created_by: managerName,
  });

  // ── Build pre-filled reject URL ───────────────────────────────────────────
  const params = new URLSearchParams();
  if (eventData) {
    if (eventData.date)        params.set('date', eventData.date);
    if (eventData.time)        params.set('time', eventData.time);
    if (eventData.rsvpDate)    params.set('rsvpDate', eventData.rsvpDate);
    if (eventData.host)        params.set('host', eventData.host);
    if (eventData.addr1)       params.set('addr1', eventData.addr1);
    if (eventData.addr2)       params.set('addr2', eventData.addr2);
    if (eventData.mahaprasad)  params.set('mahaprasad', eventData.mahaprasad);
    if (eventData.santos)      params.set('santos', eventData.santos);
  }
  params.set('zone', zone.replace('-santos', '').replace('-sabha', '-sabha'));
  const rejectUrl = `https://screvents.com/flyer-builder/?${params.toString()}`;

  // ── Download image to send to Telegram ───────────────────────────────────
  const { data: signedData } = await supabase.storage
    .from('flyer-reviews')
    .createSignedUrl(storagePath, 3600);

  const imgRes = await fetch(signedData.signedUrl);
  const imgBuffer2 = await imgRes.arrayBuffer();
  const imgBytes = new Uint8Array(imgBuffer2);

  // ── Send to Telegram admin group with Approve/Reject buttons ──────────────
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  const ZONE_LABELS = {
    'scranton': 'Scranton', 'mountain-top': 'Mountain Top',
    'moosic': 'Moosic', 'bloomsburg': 'Bloomsburg',
    'satsang-sabha': 'Satsang Sabha', 'satsang-sabha-santos': 'Satsang Sabha (Santos)',
  };
  const zoneLabel = ZONE_LABELS[zone] || zone;

  const caption = `📋 *Flyer Review Request*\n\nZone: *${zoneLabel}*\nSubmitted by: *${managerName}*\n\nPlease review and approve or reject.`;
  const replyMarkup = JSON.stringify({
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `review:approve:${reviewId}` },
      { text: '❌ Reject',  callback_data: `review:reject:${reviewId}` },
    ]]
  });

  // Send as multipart photo
  const boundary = '----ReviewBoundary' + Date.now();
  const encoder = new TextEncoder();
  const parts = [];
  parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${ADMIN_CHAT_ID}\r\n`));
  parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
  parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown\r\n`));
  parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${replyMarkup}\r\n`));
  parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="flyer.png"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(imgBytes);
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const multipart = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { multipart.set(p, offset); offset += p.length; }

  const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipart,
  });

  const tgData = await tgRes.json();
  if (!tgData.ok)
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Telegram send failed: ${JSON.stringify(tgData)}` }) };

  // Store reject URL in review record for webhook to use later
  await supabase.from('flyer_reviews').update({ event_data: { ...(eventData || {}), rejectUrl } }).eq('id', reviewId);

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reviewId }) };
};
