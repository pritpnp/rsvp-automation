const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'OK' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 200, body: 'OK' };
  }

  const message       = body?.message;
  const callbackQuery = body?.callback_query;
  if (!message && !callbackQuery) return { statusCode: 200, body: 'OK' };

  const chatId             = String(message ? message.chat.id : callbackQuery.message.chat.id);
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GITHUB_PAT         = process.env.GITHUB_PAT;
  const ADMIN_CHAT_ID      = process.env.TELEGRAM_CHAT_ID;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // ─── Supabase session helpers ───────────────────────────────────────────────

  const getSession = async (chat_id) => {
    const { data } = await supabase
      .from('telegram_upload_sessions')
      .select('*')
      .eq('chat_id', chat_id)
      .single();
    return data || null;
  };

  const setSession = async (chat_id, step, photo_file_id = null, zone = null) => {
    await supabase
      .from('telegram_upload_sessions')
      .upsert({ chat_id, step, photo_file_id, zone, updated_at: new Date().toISOString() });
  };

  const clearSession = async (chat_id) => {
    await supabase
      .from('telegram_upload_sessions')
      .delete()
      .eq('chat_id', chat_id);
  };

  // ─── Constants ─────────────────────────────────────────────────────────────

  const ZONE_CHAT_MAP = {
    [process.env.TELEGRAM_CHAT_ID_SCRANTON]:     'scranton',
    [process.env.TELEGRAM_CHAT_ID_MOUNTAIN_TOP]: 'mountain-top',
    [process.env.TELEGRAM_CHAT_ID_MOOSIC]:       'moosic',
    [process.env.TELEGRAM_CHAT_ID_BLOOMSBURG]:   'bloomsburg',
    [process.env.TELEGRAM_CHAT_ID_MANDIR]:       'mandir',
  };

  const MANDIR_ZONES = [
    'satsang-sabha',
    'mandir-1',
    'mandir-2',
    'mandir-3',
    'mandir-4',
    'mandir-5',
  ];

  const SUFFIX_MAP = {
    'scranton':    'scranton',
    'mountaintop': 'mountain-top',
    'moosic':      'moosic',
    'bloomsburg':  'bloomsburg',
    'satsang':     'satsang-sabha',
    'mandir':      'mandir-1',
    'mandir1':     'mandir-1',
    'mandir2':     'mandir-2',
    'mandir3':     'mandir-3',
    'mandir4':     'mandir-4',
    'mandir5':     'mandir-5',
  };

  const UPLOAD_ZONES = [
    { label: 'Scranton',      value: 'scranton' },
    { label: 'Mountain Top',  value: 'mountain-top' },
    { label: 'Moosic',        value: 'moosic' },
    { label: 'Bloomsburg',    value: 'bloomsburg' },
    { label: 'Satsang Sabha', value: 'satsang-sabha' },
    { label: 'Mandir 1',      value: 'mandir-1' },
    { label: 'Mandir 2',      value: 'mandir-2' },
    { label: 'Mandir 3',      value: 'mandir-3' },
    { label: 'Mandir 4',      value: 'mandir-4' },
    { label: 'Mandir 5',      value: 'mandir-5' },
  ];

  // ─── Telegram helpers ───────────────────────────────────────────────────────

  const buildFlyerUrl = (zone) => {
    const match = zone.match(/^mandir-(\d+)$/);
    if (match) return `https://screvents.com/mandir/${match[1]}/flyer.jpg`;
    return `https://screvents.com/${zone}/flyer.jpg`;
  };

  const sendMessage = (chat_id, text, extra = {}) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, ...extra }),
    });

  const answerCallbackQuery = (callbackQueryId, text = '') =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });

  const editMessageText = (chat_id, message_id, text, extra = {}) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, message_id, text, ...extra }),
    });

  const sendPhotoBuffer = async (chat_id, flyerUrl) => {
    const imgRes = await fetch(flyerUrl);
    if (!imgRes.ok) {
      console.log(`⏭ Flyer not found at ${flyerUrl} (${imgRes.status}) — skipping`);
      return null;
    }

    const imgBuffer = await imgRes.arrayBuffer();
    const imgBytes  = new Uint8Array(imgBuffer);
    const boundary  = '----TelegramBoundary' + Date.now();
    const filename  = flyerUrl.split('/').pop() || 'flyer.jpg';
    const encoder   = new TextEncoder();
    const parts     = [];

    parts.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chat_id}\r\n`
    ));
    parts.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
    ));
    parts.push(imgBytes);
    parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const multipartBody = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) { multipartBody.set(part, offset); offset += part.length; }

    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody,
    });

    return tgRes.json();
  };

  // Downloads the highest-res photo from Telegram by file_id, returns base64 string
  const downloadTelegramPhotoAsBase64 = async (fileId) => {
    const fileRes  = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) throw new Error(`getFile failed: ${JSON.stringify(fileData)}`);

    const filePath = fileData.result.file_path;
    const dlRes    = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
    if (!dlRes.ok) throw new Error(`Telegram download failed: ${dlRes.status}`);

    const buffer = await dlRes.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  };

  // Commits flyer.jpg to the repo via GitHub Contents API
  const commitFlyerToGitHub = async (zone, base64Image) => {
    const path    = `flyers/${zone}/flyer.jpg`;
    const apiUrl  = `https://api.github.com/repos/pritpnp/rsvp-automation/contents/${path}`;
    const headers = {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };

    let sha;
    const getRes = await fetch(apiUrl, { headers });
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    }

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Upload flyer for ${zone} via Telegram`,
        content: base64Image,
        ...(sha ? { sha } : {}),
      }),
    });

    if (!putRes.ok) {
      const err = await putRes.text();
      throw new Error(`GitHub commit failed (${putRes.status}): ${err}`);
    }

    return putRes.json();
  };

  // Deletes flyer.jpg from the repo via GitHub Contents API
  const deleteFlyerFromGitHub = async (zone) => {
    const path    = `flyers/${zone}/flyer.jpg`;
    const apiUrl  = `https://api.github.com/repos/pritpnp/rsvp-automation/contents/${path}`;
    const headers = {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };

    // Must fetch SHA before deleting
    const getRes = await fetch(apiUrl, { headers });
    if (!getRes.ok) throw new Error(`No flyer found for ${zone} — nothing to delete.`);

    const existing = await getRes.json();
    const sha      = existing.sha;

    const delRes = await fetch(apiUrl, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        message: `Remove flyer for ${zone} via Telegram`,
        sha,
      }),
    });

    if (!delRes.ok) {
      const err = await delRes.text();
      throw new Error(`GitHub delete failed (${delRes.status}): ${err}`);
    }

    return delRes.json();
  };

  // ─── Inline keyboard builders ───────────────────────────────────────────────

  const zoneKeyboard = (prefix = 'zone') => ({
    inline_keyboard: [
      [
        { text: 'Scranton',     callback_data: `${prefix}:scranton` },
        { text: 'Mountain Top', callback_data: `${prefix}:mountain-top` },
      ],
      [
        { text: 'Moosic',     callback_data: `${prefix}:moosic` },
        { text: 'Bloomsburg', callback_data: `${prefix}:bloomsburg` },
      ],
      [
        { text: 'Satsang Sabha', callback_data: `${prefix}:satsang-sabha` },
      ],
      [
        { text: 'Mandir 1', callback_data: `${prefix}:mandir-1` },
        { text: 'Mandir 2', callback_data: `${prefix}:mandir-2` },
        { text: 'Mandir 3', callback_data: `${prefix}:mandir-3` },
      ],
      [
        { text: 'Mandir 4', callback_data: `${prefix}:mandir-4` },
        { text: 'Mandir 5', callback_data: `${prefix}:mandir-5` },
      ],
      [
        { text: '❌ Cancel', callback_data: 'action:cancel' },
      ],
    ],
  });

  const confirmKeyboard = (action) => ({
    inline_keyboard: [
      [
        { text: '✅ Yes',    callback_data: `${action}:confirm` },
        { text: '❌ Cancel', callback_data: 'action:cancel' },
      ],
    ],
  });

  // ─── Handle callback_query (inline button presses) ─────────────────────────

  if (callbackQuery) {
    const cbChatId = String(callbackQuery.message.chat.id);
    const cbData   = callbackQuery.data;
    const msgId    = callbackQuery.message.message_id;

    if (cbChatId !== ADMIN_CHAT_ID) {
      await answerCallbackQuery(callbackQuery.id);
      return { statusCode: 200, body: 'OK' };
    }

    const state = await getSession(cbChatId);

    // ── Cancel ──
    if (cbData === 'action:cancel') {
      await clearSession(cbChatId);
      await answerCallbackQuery(callbackQuery.id, 'Cancelled');
      await editMessageText(cbChatId, msgId, '❌ Cancelled.');
      return { statusCode: 200, body: 'OK' };
    }

    // ── Upload: zone selected ──
    if (cbData.startsWith('zone:') && state?.step === 'awaiting_zone') {
      const selectedZone = cbData.replace('zone:', '');
      const zoneLabel    = UPLOAD_ZONES.find(z => z.value === selectedZone)?.label || selectedZone;

      await setSession(cbChatId, 'awaiting_confirm', state.photo_file_id, selectedZone);
      await answerCallbackQuery(callbackQuery.id);
      await editMessageText(
        cbChatId, msgId,
        `📍 Zone selected: *${zoneLabel}*\n\nUpload this flyer to *${zoneLabel}*?`,
        { parse_mode: 'Markdown', reply_markup: JSON.stringify(confirmKeyboard('upload')) }
      );
      return { statusCode: 200, body: 'OK' };
    }

    // ── Upload: confirm ──
    if (cbData === 'upload:confirm' && state?.step === 'awaiting_confirm') {
      const { photo_file_id, zone } = state;
      const zoneLabel = UPLOAD_ZONES.find(z => z.value === zone)?.label || zone;

      await clearSession(cbChatId);
      await answerCallbackQuery(callbackQuery.id, 'Uploading…');
      await editMessageText(cbChatId, msgId, `⏳ Uploading flyer to *${zoneLabel}*...`, { parse_mode: 'Markdown' });

      try {
        const base64Image = await downloadTelegramPhotoAsBase64(photo_file_id);
        await commitFlyerToGitHub(zone, base64Image);
        await sendMessage(
          cbChatId,
          `✅ Flyer uploaded to *${zoneLabel}*! GitHub Actions will process it now.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Upload error:', err);
        await sendMessage(cbChatId, `❌ Upload failed: ${err.message}`);
      }

      return { statusCode: 200, body: 'OK' };
    }

    // ── Remove: zone selected ──
    if (cbData.startsWith('removezone:') && state?.step === 'awaiting_remove_zone') {
      const selectedZone = cbData.replace('removezone:', '');
      const zoneLabel    = UPLOAD_ZONES.find(z => z.value === selectedZone)?.label || selectedZone;

      await setSession(cbChatId, 'awaiting_remove_confirm', null, selectedZone);
      await answerCallbackQuery(callbackQuery.id);
      await editMessageText(
        cbChatId, msgId,
        `🗑 Remove the flyer for *${zoneLabel}*?\n\nThis will delete it from the site.`,
        { parse_mode: 'Markdown', reply_markup: JSON.stringify(confirmKeyboard('remove')) }
      );
      return { statusCode: 200, body: 'OK' };
    }

    // ── Remove: confirm ──
    if (cbData === 'remove:confirm' && state?.step === 'awaiting_remove_confirm') {
      const { zone } = state;
      const zoneLabel = UPLOAD_ZONES.find(z => z.value === zone)?.label || zone;

      await clearSession(cbChatId);
      await answerCallbackQuery(callbackQuery.id, 'Removing…');
      await editMessageText(cbChatId, msgId, `⏳ Removing flyer for *${zoneLabel}*...`, { parse_mode: 'Markdown' });

      try {
        await deleteFlyerFromGitHub(zone);
        await sendMessage(
          cbChatId,
          `✅ Flyer removed for *${zoneLabel}*! GitHub Actions will process it now.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Remove error:', err);
        await sendMessage(cbChatId, `❌ Remove failed: ${err.message}`);
      }

      return { statusCode: 200, body: 'OK' };
    }

    // ── Review: Approve ──
    if (cbData.startsWith('review:approve:')) {
      const reviewId = cbData.replace('review:approve:', '');
      await answerCallbackQuery(callbackQuery.id, 'Approving...');
      await editMessageText(cbChatId, msgId, '⏳ Approving flyer...');

      try {
        // Fetch review record
        const { data: review } = await supabase
          .from('flyer_reviews')
          .select('*')
          .eq('id', reviewId)
          .single();

        if (!review) throw new Error('Review not found');
        if (review.status !== 'pending') throw new Error('Already processed');

        // Download image from Supabase storage
        const { data: signedData } = await supabase.storage
          .from('flyer-reviews')
          .createSignedUrl(review.storage_path, 300);

        const imgRes = await fetch(signedData.signedUrl);
        if (!imgRes.ok) throw new Error('Could not download flyer from storage');
        const imgBuffer = await imgRes.arrayBuffer();
        const base64Image = Buffer.from(imgBuffer).toString('base64');

        // Commit to GitHub — same as /uploadflyer
        const zone = review.zone.replace('-santos', '');
        const filePath = `flyers/${zone}/flyer.jpg`;
        const apiUrl = `https://api.github.com/repos/pritpnp/rsvp-automation/contents/${filePath}`;
        const ghHeaders = {
          'Authorization': `Bearer ${GITHUB_PAT}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        };

        let sha;
        const getRes = await fetch(apiUrl, { headers: ghHeaders });
        if (getRes.ok) { const ex = await getRes.json(); sha = ex.sha; }

        const putRes = await fetch(apiUrl, {
          method: 'PUT', headers: ghHeaders,
          body: JSON.stringify({
            message: `Upload flyer for ${zone} via admin portal (approved)`,
            content: base64Image,
            ...(sha ? { sha } : {}),
          }),
        });

        if (!putRes.ok) {
          const err = await putRes.text();
          throw new Error(`GitHub commit failed: ${err}`);
        }

        // Mark review as approved
        await supabase.from('flyer_reviews').update({ status: 'approved' }).eq('id', reviewId);

        // Clean up storage
        await supabase.storage.from('flyer-reviews').remove([review.storage_path]);

        const ZONE_LABELS = {
          'scranton': 'Scranton', 'mountain-top': 'Mountain Top',
          'moosic': 'Moosic', 'bloomsburg': 'Bloomsburg',
          'satsang-sabha': 'Satsang Sabha',
        };
        const zoneLabel = ZONE_LABELS[zone] || zone;
        await editMessageText(cbChatId, msgId, `✅ *Flyer approved and uploaded for ${zoneLabel}!*
GitHub Actions will process it now (~2 minutes).`, { parse_mode: 'Markdown' });

        // TODO: When zone chats are ready, also notify the zone chat here:
        // const zoneChatId = ZONE_CHAT_IDS[zone];
        // if (zoneChatId) await sendMessage(zoneChatId, `✅ Your flyer for ${zoneLabel} has been approved and is being processed!`);

      } catch (err) {
        console.error('Review approve error:', err);
        await editMessageText(cbChatId, msgId, `❌ Approval failed: ${err.message}`);
      }

      return { statusCode: 200, body: 'OK' };
    }

    // ── Review: Reject ──
    if (cbData.startsWith('review:reject:')) {
      const reviewId = cbData.replace('review:reject:', '');
      await answerCallbackQuery(callbackQuery.id, 'Rejected');

      try {
        const { data: review } = await supabase
          .from('flyer_reviews')
          .select('*')
          .eq('id', reviewId)
          .single();

        if (!review) throw new Error('Review not found');

        // Mark as rejected
        await supabase.from('flyer_reviews').update({ status: 'rejected' }).eq('id', reviewId);

        // Clean up storage
        await supabase.storage.from('flyer-reviews').remove([review.storage_path]);

        const rejectUrl = review.event_data?.rejectUrl || 'https://screvents.com/flyer-builder/';
        const ZONE_LABELS = {
          'scranton': 'Scranton', 'mountain-top': 'Mountain Top',
          'moosic': 'Moosic', 'bloomsburg': 'Bloomsburg',
          'satsang-sabha': 'Satsang Sabha',
        };
        const zone = review.zone.replace('-santos', '');
        const zoneLabel = ZONE_LABELS[zone] || zone;

        // Edit original message to show rejected status
        await editMessageText(cbChatId, msgId, `❌ Flyer rejected for ${zoneLabel}.`);

        // Send a separate message with the link (avoids Markdown URL escaping issues)
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text: `🔗 Fix and resubmit the flyer here:\n${rejectUrl}`,
            disable_web_page_preview: false,
          }),
        });

        // TODO: When zone chats are ready, send the link directly to the manager here

      } catch (err) {
        console.error('Review reject error:', err);
        await editMessageText(cbChatId, msgId, `❌ Reject failed: ${err.message}`);
      }

      return { statusCode: 200, body: 'OK' };
    }

    // Stale or unexpected callback
    await answerCallbackQuery(callbackQuery.id, 'Session expired. Try your command again.');
    return { statusCode: 200, body: 'OK' };
  }

  // ─── Handle photo messages (awaiting_photo step) ────────────────────────────

  if (message.photo) {
    const state = await getSession(chatId);
    if (state?.step === 'awaiting_photo') {
      const bestPhoto = message.photo[message.photo.length - 1];
      await setSession(chatId, 'awaiting_zone', bestPhoto.file_id, null);
      await sendMessage(
        chatId,
        '📸 Got the flyer! Which zone is this for?',
        { reply_markup: JSON.stringify(zoneKeyboard('zone')) }
      );
    }
    return { statusCode: 200, body: 'OK' };
  }

  // ─── Handle text commands ───────────────────────────────────────────────────

  const text = message.text?.trim();
  if (!text) return { statusCode: 200, body: 'OK' };

  const normalizedText  = text.toLowerCase().replace(/@\S+/g, '').trim();
  const isGetFlyer      = normalizedText.startsWith('/getflyer');
  const isSummary       = normalizedText.startsWith('/summary');
  const isUploadFlyer   = normalizedText === '/uploadflyer';
  const isRemoveFlyer   = normalizedText === '/removeflyer';
  const isCancel        = normalizedText === '/cancel';

  // ── /cancel (admin chat only) ──
  if (isCancel && chatId === ADMIN_CHAT_ID) {
    const state = await getSession(chatId);
    if (state) {
      await clearSession(chatId);
      await sendMessage(chatId, '❌ Cancelled.');
    }
    return { statusCode: 200, body: 'OK' };
  }

  // ── /uploadflyer (admin chat only) ──
  if (isUploadFlyer) {
    if (chatId !== ADMIN_CHAT_ID) return { statusCode: 200, body: 'OK' };

    await setSession(chatId, 'awaiting_photo');
    await sendMessage(chatId, '📤 Please send the flyer image now, or type /cancel to abort.');
    return { statusCode: 200, body: 'OK' };
  }

  // ── /removeflyer (admin chat only) ──
  if (isRemoveFlyer) {
    if (chatId !== ADMIN_CHAT_ID) return { statusCode: 200, body: 'OK' };

    await setSession(chatId, 'awaiting_remove_zone');
    await sendMessage(
      chatId,
      '🗑 Which zone\'s flyer do you want to remove?',
      { reply_markup: JSON.stringify(zoneKeyboard('removezone')) }
    );
    return { statusCode: 200, body: 'OK' };
  }

  if (!isSummary && !isGetFlyer) return { statusCode: 200, body: 'OK' };

  // ─── /getflyer ─────────────────────────────────────────────────────────────

  if (isGetFlyer) {
    const cmd    = normalizedText.replace(/\s/g, '');
    const suffix = cmd.replace('/getflyer', '');

    let flyerZone;

    if (suffix === '') {
      const zone = ZONE_CHAT_MAP[chatId];

      if (!zone) {
        await sendMessage(chatId, '⚠️ This command is only available in zone groups, or use a suffix:\n/getflyerscranton\n/getflyermountaintop\n/getflyermoosic\n/getflyerbloomsburg\n/getflyersatsang\n/getflyermandir1 – mandir5');
        return { statusCode: 200, body: 'OK' };
      }

      if (zone === 'mandir') {
        for (const mandirZone of MANDIR_ZONES) {
          const flyerUrl = buildFlyerUrl(mandirZone);
          console.log(`Sending mandir flyer for zone "${mandirZone}": ${flyerUrl}`);
          const result = await sendPhotoBuffer(chatId, flyerUrl);
          if (result && !result.ok) {
            console.error(`sendPhoto failed for ${mandirZone}: ${JSON.stringify(result)}`);
          }
        }
        return { statusCode: 200, body: 'OK' };
      }

      flyerZone = zone;

    } else {
      flyerZone = SUFFIX_MAP[suffix];

      if (!flyerZone) {
        await sendMessage(chatId, '⚠️ Unknown zone. Valid options:\n/getflyerscranton\n/getflyermountaintop\n/getflyermoosic\n/getflyerbloomsburg\n/getflyersatsang\n/getflyermandir1 – mandir5');
        return { statusCode: 200, body: 'OK' };
      }
    }

    const flyerUrl = buildFlyerUrl(flyerZone);
    console.log(`Sending flyer for zone "${flyerZone}": ${flyerUrl}`);

    const result = await sendPhotoBuffer(chatId, flyerUrl);
    if (!result) {
      await sendMessage(chatId, `⚠️ Could not retrieve flyer for ${flyerZone}. It may not be uploaded yet.`);
    } else if (!result.ok) {
      console.error(`sendPhoto failed: ${JSON.stringify(result)}`);
      await sendMessage(chatId, `⚠️ Could not send flyer for ${flyerZone}. Please try again.`);
    }

    return { statusCode: 200, body: 'OK' };
  }

  // ─── /summary ──────────────────────────────────────────────────────────────

  console.log(`chatId: "${chatId}"`);
  console.log(`ZONE_CHAT_MAP keys: ${JSON.stringify(Object.keys(ZONE_CHAT_MAP))}`);
  console.log(`ZONE_CHAT_MAP lookup result: ${ZONE_CHAT_MAP[chatId]}`);

  const summaryCmd = normalizedText.replace(/\s/g, '');
  let targetZone   = 'all';

  if (summaryCmd === '/summary') {
    targetZone = ZONE_CHAT_MAP[chatId] || 'all';
  } else {
    const summarySuffixMap = {
      'scranton':    'scranton',
      'mountaintop': 'mountain-top',
      'moosic':      'moosic',
      'bloomsburg':  'bloomsburg',
      'mandir':      'mandir',
    };
    const suffix = summaryCmd.replace('/summary', '');
    targetZone = summarySuffixMap[suffix] || 'all';
  }

  await sendMessage(chatId, '📊 Generating RSVP summary... check back in ~30 seconds.');

  const ghRes = await fetch(
    'https://api.github.com/repos/pritpnp/rsvp-automation/actions/workflows/rsvp-summary.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          target_zone: targetZone,
          trigger_chat_id: chatId,
          test_mode: 'false',
        },
      }),
    }
  );

  const ghStatus = ghRes.status;
  const ghBody   = await ghRes.text();
  console.log(`GitHub dispatch status: ${ghStatus}`);
  console.log(`GitHub dispatch response: ${ghBody}`);
  console.log(`target_zone: ${targetZone} | trigger_chat_id: ${chatId}`);

  return { statusCode: 200, body: 'OK' };
};
