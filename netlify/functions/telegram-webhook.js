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

  // Suffix map — used for admin commands and Mandir group sub-zone selection
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
  // mandir-1 → /mandir/1/flyer.jpg
  // scranton  → /scranton/flyer.jpg
  // satsang-sabha → /satsang-sabha/flyer.jpg
  const buildFlyerUrl = (zone) => {
    const match = zone.match(/^mandir-(\d+)$/);
    if (match) {
      return `https://screvents.com/mandir/${match[1]}/flyer.jpg?t=${Date.now()}`;
    }
    return `https://screvents.com/${zone}/flyer.jpg?t=${Date.now()}`;
  };

  const sendMessage = (chat_id, msg) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text: msg }),
    });

  const sendPhoto = (chat_id, photo, caption) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, photo, ...(caption ? { caption } : {}) }),
    });

  // ─── /getflyer ─────────────────────────────────────────────────────────────
  if (isGetFlyer) {
    // Strip bot mention + whitespace: /getflyermandir2@MyBot → /getflyermandir2
    const cmd    = text.toLowerCase().replace(/@\S+/g, '').replace(/\s/g, '');
    const suffix = cmd.replace('/getflyer', ''); // '' | 'scranton' | 'mandir2' etc.

    let flyerZone;

    if (suffix === '') {
      // No suffix — determine zone from which group the command was sent in
      const zone = ZONE_CHAT_MAP[chatId];

      if (!zone) {
        await sendMessage(chatId, '⚠️ This command is only available in zone groups, or use a suffix:\n/getflyerscranton\n/getflyermountaintop\n/getflyermoosic\n/getflyerbloomsburg\n/getflyersatsang\n/getflyermandir1 – mandir5');
        return { statusCode: 200, body: 'OK' };
      }

      if (zone === 'mandir') {
        // Mandir group covers multiple sub-zones — prompt them to be specific
        await sendMessage(chatId, 'Which Mandir flyer would you like?\n\n/getflyersatsang\n/getflyermandir1\n/getflyermandir2\n/getflyermandir3\n/getflyermandir4\n/getflyermandir5');
        return { statusCode: 200, body: 'OK' };
      }

      flyerZone = zone;

    } else {
      // Suffix provided — resolve it
      flyerZone = SUFFIX_MAP[suffix];

      if (!flyerZone) {
        await sendMessage(chatId, '⚠️ Unknown zone. Valid options:\n/getflyerscranton\n/getflyermountaintop\n/getflyermoosic\n/getflyerbloomsburg\n/getflyersatsang\n/getflyermandir1 – mandir5');
        return { statusCode: 200, body: 'OK' };
      }
    }

    const flyerUrl = buildFlyerUrl(flyerZone);
    console.log(`Sending flyer for zone "${flyerZone}": ${flyerUrl}`);

    const photoRes  = await sendPhoto(chatId, flyerUrl, `🪷 Flyer for ${flyerZone}`);
    const photoBody = await photoRes.json();

    if (!photoBody.ok) {
      console.error(`sendPhoto failed: ${JSON.stringify(photoBody)}`);
      await sendMessage(chatId, `⚠️ Could not retrieve flyer for ${flyerZone}. It may not be uploaded yet.`);
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
