exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  const { name, guests, zone, eventName } = body;
  if (!name || !guests || !zone) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  const text = `⚠️ Late RSVP Request\n🏛 ${zone} — ${eventName || 'Para Satsang Sabha'}\n👤 ${name}\n👥 Guests: ${guests}`;

  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text })
  });

  if (response.ok) {
    return { statusCode: 200, body: 'ok' };
  } else {
    return { statusCode: 500, body: 'Failed to send message' };
  }
};
