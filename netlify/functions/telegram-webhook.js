exports.handler = async (event) => {
  // Always respond 200 immediately — prevents Telegram retries
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
  if (!message?.text) return { statusCode: 200, body: 'OK' };

  const text       = message.text.trim();
  const isGetFlyer = text.toLowerCase().startsWith('/getflyer');
  const isSummary  = text.toLowerCase().startsWith('/summary');

  if (!isSummary && !isGetFlyer) return { statusCode: 200, body: 'OK' };

  const chatId             = String(message.chat.id);
  const GITHUB_PAT         = process.env.GITHUB_PAT;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  const ZONE_CHAT_MAP = {
    [process.env.TELEGRAM_CHAT_ID_SCRANTON]:     'scranton',
    [process.env.TELEGRAM_CHAT_ID_MOUNTAIN_TOP]: 'mountain-top',
    [process.env.TELEGRAM_CHAT_ID_MOOSIC]:       'moosic',
    [process.env.TELEGRAM_CHAT_ID_BLOOMSBURG]:   'bloomsburg',
    [process.env.TELEGRAM_CHAT_ID_MANDIR]:       'mandir',
  };

  // All mandir sub-zones sent when /getflyer is used in the Mandir group
  const MANDIR_ZONES = [
    'satsang-sabha',
    'mandir-1',
    'mandir-2',
    'mandir-3',
    'mandir-4',
    'mandir-5',
  ];

  // Suffix map — used for admin commands and explicit zone selection
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

  // Builds the correct flyer URL based on zone slug
  const buildFlyerUrl = (zone) => {
    const match = zone.match(/^mandir-(\d+)$/);
    if (match) return `https://screvents.com/mandir/${match[1]}/flyer.jpg`;
    return `https://screvents.com/${zone}/flyer.jpg`;
  };

  const sendMessage = (chat_id, msg) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text: msg }),
    });

  // Fetches the image buffer from our server, then uploads it directly to Telegram.
  // This avoids Telegram trying to fetch the URL itself (which gets blocked by the firewall).
  const sendPhotoBuffer = async (chat_id, flyerUrl) => {
    // Fetch the image from our own server
    const imgRes = await fetch(flyerUrl);
    if (!imgRes.ok) {
      console.log(`⏭ Flyer not found at ${flyerUrl} (${imgRes.status}) — skipping`);
      return null;
    }

    const imgBuffer = await imgRes.arrayBuffer();
    const imgBytes  = new Uint8Array(imgBuffer);

    // Build multipart/form-data manually
    const boundary = '----TelegramBoundary' + Date.now();
    const filename  = flyerUrl.split('/').pop() || 'flyer.jpg';

    // Build the multipart body as a Uint8Array
    const encoder = new TextEncoder();
    const parts = [];

    // chat_id field
    parts.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chat_id}\r\n`
    ));

    // photo field (binary)
    parts.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
    ));
    parts.push(imgBytes);
    parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

    // Concatenate all parts
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const multipartBody = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      multipartBody.set(part, offset);
      offset += part.length;
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody,
    });

    return tgRes.json();
  };

  // ─── /getflyer ─────────────────────────────────────────────────────────────
  if (isGetFlyer) {
    const cmd    = text.toLowerCase().replace(/@\S+/g, '').replace(/\s/g, '');
    const suffix = cmd.replace('/getflyer', '');

    let flyerZone;

    if (suffix === '') {
      const zone = ZONE_CHAT_MAP[chatId];

      if (!zone) {
        await sendMessage(chatId, '⚠️ This command is only available in zone groups, or use a suffix:\n/getflyerscranton\n/getflyermountaintop\n/getflyermoosic\n/getflyerbloomsburg\n/getflyersatsang\n/getflyermandir1 – mandir5');
        return { statusCode: 200, body: 'OK' };
      }

      if (zone === 'mandir') {
        // Send all mandir flyers that exist
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

  const summaryCmd = text.toLowerCase().replace(/[@\s]/g, '');
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
