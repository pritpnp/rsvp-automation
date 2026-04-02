// In-memory state store for /uploadflyer conversation flow
// State shape: { [chatId]: { step: 'awaiting_photo' | 'awaiting_zone' | 'awaiting_confirm', photoFileId, zone } }
const uploadState = {};

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

  const message = body?.message;
  if (!message) return { statusCode: 200, body: 'OK' };

  const chatId             = String(message.chat.id);
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GITHUB_PAT         = process.env.GITHUB_PAT;
  const ADMIN_CHAT_ID      = process.env.TELEGRAM_CHAT_ID;

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

  // All selectable zones for /uploadflyer
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

  // Downloads a photo from Telegram by file_id, returns ArrayBuffer
  const downloadTelegramPhoto = async (fileId) => {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileData = await fileRes.json();
    if (!fileData.ok) throw new Error(`getFile failed: ${JSON.stringify(fileData)}`);

    const filePath = fileData.result.file_path;
    const dlRes = await fetch(
      `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`
    );
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
    return dlRes.arrayBuffer();
  };

  // Uploads a flyer buffer to screvents.com via the existing upload-flyer Netlify function
  const uploadFlyerToSite = async (imageBuffer, zone) => {
    const base64 = Buffer.from(imageBuffer).toString('base64');

    const res = await fetch('https://screvents.com/.netlify/functions/upload-flyer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, imageBase64: base64 }),
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { ok: false, error: text }; }

    if (!res.ok) throw new Error(json.error || `upload-flyer returned ${res.status}`);
    return json;
  };

  // ─── Inline keyboard helpers ────────────────────────────────────────────────

  const zoneKeyboard = () => ({
    inline_keyboard: [
      [
        { text: 'Scranton',     callback_data: 'zone:scranton' },
        { text: 'Mountain Top', callback_data: 'zone:mountain-top' },
      ],
      [
        { text: 'Moosic',       callback_data: 'zone:moosic' },
        { text: 'Bloomsburg',   callback_data: 'zone:bloomsburg' },
      ],
      [
        { text: 'Satsang Sabha', callback_data: 'zone:satsang-sabha' },
      ],
      [
        { text: 'Mandir 1', callback_data: 'zone:mandir-1' },
        { text: 'Mandir 2', callback_data: 'zone:mandir-2' },
        { text: 'Mandir 3', callback_data: 'zone:mandir-3' },
      ],
      [
        { text: 'Mandir 4', callback_data: 'zone:mandir-4' },
        { text: 'Mandir 5', callback_data: 'zone:mandir-5' },
      ],
      [
        { text: '❌ Cancel', callback_data: 'upload:cancel' },
      ],
    ],
  });

  const confirmKeyboard = () => ({
    inline_keyboard: [
      [
        { text: '✅ Yes, upload',  callback_data: 'upload:confirm' },
        { text: '❌ Cancel',       callback_data: 'upload:cancel' },
      ],
    ],
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

  // ─── Handle callback_query (inline button presses) ─────────────────────────
  const callbackQuery = body?.callback_query;
  if (callbackQuery) {
    const cbChatId = String(callbackQuery.message.chat.id);
    const cbData   = callbackQuery.data;
    const msgId    = callbackQuery.message.message_id;

    // Only handle callbacks from the admin chat
    if (cbChatId !== ADMIN_CHAT_ID) {
      await answerCallbackQuery(callbackQuery.id);
      return { statusCode: 200, body: 'OK' };
    }

    const state = uploadState[cbChatId];

    // ── Cancel ──
    if (cbData === 'upload:cancel') {
      delete uploadState[cbChatId];
      await answerCallbackQuery(callbackQuery.id, 'Cancelled');
      await editMessageText(cbChatId, msgId, '❌ Upload cancelled.');
      return { statusCode: 200, body: 'OK' };
    }

    // ── Zone selected ──
    if (cbData.startsWith('zone:') && state?.step === 'awaiting_zone') {
      const selectedZone = cbData.replace('zone:', '');
      const zoneLabel    = UPLOAD_ZONES.find(z => z.value === selectedZone)?.label || selectedZone;

      uploadState[cbChatId] = { ...state, step: 'awaiting_confirm', zone: selectedZone };

      await answerCallbackQuery(callbackQuery.id);
      await editMessageText(
        cbChatId, msgId,
        `📍 Zone selected: *${zoneLabel}*\n\nUpload this flyer to *${zoneLabel}*?`,
        { parse_mode: 'Markdown', reply_markup: JSON.stringify(confirmKeyboard()) }
      );
      return { statusCode: 200, body: 'OK' };
    }

    // ── Confirm upload ──
    if (cbData === 'upload:confirm' && state?.step === 'awaiting_confirm') {
      const { photoFileId, zone } = state;
      const zoneLabel = UPLOAD_ZONES.find(z => z.value === zone)?.label || zone;

      delete uploadState[cbChatId];
      await answerCallbackQuery(callbackQuery.id, 'Uploading…');
      await editMessageText(cbChatId, msgId, `⏳ Uploading flyer to *${zoneLabel}*...`, { parse_mode: 'Markdown' });

      try {
        const imageBuffer = await downloadTelegramPhoto(photoFileId);
        await uploadFlyerToSite(imageBuffer, zone);
        await sendMessage(cbChatId, `✅ Flyer uploaded successfully to *${zoneLabel}*!`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Upload error:', err);
        await sendMessage(cbChatId, `❌ Upload failed: ${err.message}`);
      }

      return { statusCode: 200, body: 'OK' };
    }

    // Stale or unexpected callback
    await answerCallbackQuery(callbackQuery.id, 'Session expired. Use /uploadflyer to start again.');
    return { statusCode: 200, body: 'OK' };
  }

  // ─── Handle photo messages (awaiting_photo step) ────────────────────────────
  if (message.photo) {
    const state = uploadState[chatId];

    if (chatId === ADMIN_CHAT_ID && state?.step === 'awaiting_photo') {
      // Use the highest resolution version (last in array)
      const bestPhoto = message.photo[message.photo.length - 1];
      uploadState[chatId] = { step: 'awaiting_zone', photoFileId: bestPhoto.file_id };

      await sendMessage(
        chatId,
        '📸 Got the flyer! Which zone is this for?',
        { reply_markup: JSON.stringify(zoneKeyboard()) }
      );
    }

    return { statusCode: 200, body: 'OK' };
  }

  // ─── Handle text commands ───────────────────────────────────────────────────
  const text = message.text?.trim();
  if (!text) return { statusCode: 200, body: 'OK' };

  const normalizedText = text.toLowerCase().replace(/@\S+/g, '').trim();
  const isGetFlyer     = normalizedText.startsWith('/getflyer');
  const isSummary      = normalizedText.startsWith('/summary');
  const isUploadFlyer  = normalizedText === '/uploadflyer';
  const isCancel       = normalizedText === '/cancel';

  // ── /cancel (admin chat only) ──
  if (isCancel && chatId === ADMIN_CHAT_ID && uploadState[chatId]) {
    delete uploadState[chatId];
    await sendMessage(chatId, '❌ Upload cancelled.');
    return { statusCode: 200, body: 'OK' };
  }

  // ── /uploadflyer (admin chat only) ──
  if (isUploadFlyer) {
    if (chatId !== ADMIN_CHAT_ID) {
      return { statusCode: 200, body: 'OK' }; // silently ignore in non-admin chats
    }

    uploadState[chatId] = { step: 'awaiting_photo' };
    await sendMessage(
      chatId,
      '📤 Please send the flyer image now, or type /cancel to abort.'
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
