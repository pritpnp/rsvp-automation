exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Bad Request' }; }

  const message = body?.message?.text || '';
  const chatId = body?.message?.chat?.id;

  if (!message.startsWith('/summary')) return { statusCode: 200, body: 'ok' };

  // Trigger GitHub Actions workflow
  const response = await fetch('https://api.github.com/repos/pritpnp/rsvp-automation/actions/workflows/rsvp-summary.yml/dispatches', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GITHUB_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: 'main', inputs: { test_mode: 'false' } })
  });

  if (response.ok) {
    // Send confirmation back to Telegram
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '📊 Generating RSVP summary...' })
    });
  }

  return { statusCode: 200, body: 'ok' };
};
