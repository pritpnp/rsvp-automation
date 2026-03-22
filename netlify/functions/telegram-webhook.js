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

  const text = message.text.trim();
  if (!text.toLowerCase().startsWith('/summary')) return { statusCode: 200, body: 'OK' };

  const chatId = String(message.chat.id);
  const GITHUB_PAT          = process.env.GITHUB_PAT;
  const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
  const ADMIN_CHAT_ID       = process.env.TELEGRAM_CHAT_ID;

  const ZONE_CHAT_MAP = {
    [process.env.TELEGRAM_CHAT_ID_SCRANTON]:     'scranton',
    [process.env.TELEGRAM_CHAT_ID_MOUNTAIN_TOP]: 'mountain-top',
    [process.env.TELEGRAM_CHAT_ID_MOOSIC]:       'moosic',
    [process.env.TELEGRAM_CHAT_ID_BLOOMSBURG]:   'bloomsburg',
    [process.env.TELEGRAM_CHAT_ID_MANDIR]:       'mandir',
  };

  // Debug log
  console.log(`chatId: "${chatId}"`);
  console.log(`ZONE_CHAT_MAP keys: ${JSON.stringify(Object.keys(ZONE_CHAT_MAP))}`);
  console.log(`ZONE_CHAT_MAP lookup result: ${ZONE_CHAT_MAP[chatId]}`);

  // Parse command to determine target zone
  const cmd = text.toLowerCase().replace(/[@\s]/g, '');
  let targetZone = 'all';

  if (cmd === '/summary') {
    // From zone group → that zone only. From admin → all zones.
    targetZone = ZONE_CHAT_MAP[chatId] || 'all';
  } else {
    const suffixMap = {
      'scranton':    'scranton',
      'mountaintop': 'mountain-top',
      'moosic':      'moosic',
      'bloomsburg':  'bloomsburg',
      'mandir':      'mandir',
    };
    const suffix = cmd.replace('/summary', '');
    targetZone = suffixMap[suffix] || 'all';
  }

  // Send confirmation to the group that triggered the command
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '📊 Generating RSVP summary... check back in ~30 seconds.'
    })
  });

  // Dispatch GitHub Actions workflow
  const ghRes = await fetch(
    'https://api.github.com/repos/pritpnp/rsvp-automation/actions/workflows/rsvp-summary.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          target_zone: targetZone,
          trigger_chat_id: chatId,
          test_mode: 'false'
        }
      })
    }
  );

  const ghStatus = ghRes.status;
  const ghBody = await ghRes.text();
  console.log(`GitHub dispatch status: ${ghStatus}`);
  console.log(`GitHub dispatch response: ${ghBody}`);
  console.log(`target_zone: ${targetZone} | trigger_chat_id: ${chatId}`);

  return { statusCode: 200, body: 'OK' };
};
