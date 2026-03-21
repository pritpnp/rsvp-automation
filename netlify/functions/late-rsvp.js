exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  const ZONE_CHAT_IDS = {
    'scranton':      process.env.TELEGRAM_CHAT_ID_SCRANTON,
    'mountain-top':  process.env.TELEGRAM_CHAT_ID_MOUNTAIN_TOP,
    'moosic':        process.env.TELEGRAM_CHAT_ID_MOOSIC,
    'bloomsburg':    process.env.TELEGRAM_CHAT_ID_BLOOMSBURG,
    'satsang-sabha': process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-1':      process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-2':      process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-3':      process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-4':      process.env.TELEGRAM_CHAT_ID_MANDIR,
    'mandir-5':      process.env.TELEGRAM_CHAT_ID_MANDIR,
  };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { name, guests, zone, eventName } = body;

  if (!name || !zone || !eventName) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  const message = `🔔 <b>Late RSVP</b>\n<b>${eventName}</b>\n${name} — ${guests || 1} guest(s)`;

  async function sendTelegram(chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    return res.json();
  }

  // Send to zone group + admin (dedup if zone group = admin)
  const chatIds = new Set([ADMIN_CHAT_ID]);
  const zoneChatId = ZONE_CHAT_IDS[zone];
  if (zoneChatId) chatIds.add(zoneChatId);

  await Promise.all([...chatIds].map(id => sendTelegram(id, message)));

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
