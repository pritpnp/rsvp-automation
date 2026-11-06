const { createClient } = require('@supabase/supabase-js');
const { renderCard } = require('./render');

// GET /.netlify/functions/vip-og-image?id=<pass uuid>&v=<version>
//
// The link-preview picture for one VIP pass (iMessage, WhatsApp, …): the
// dark-and-gold ticket with the invitee's name, the event name and its
// date · time. Referenced from each pass page's og:image by the
// vip-pass-preview edge function, which adds v = a hash of the text on the
// card, so an edited name or time gets a fresh URL and the old picture can be
// cached for good. Anything missing or failing falls back to the generic
// picture rather than a broken preview.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC = '/images/vip-og.jpg?v=1';

const fallback = (maxAge) => ({
  statusCode: 302,
  headers: { Location: GENERIC, 'Cache-Control': `public, max-age=${maxAge}` },
  body: '',
});

exports.handler = async (event) => {
  const id = String(event.queryStringParameters?.id || '').trim();
  if (!UUID_RE.test(id)) return fallback(3600);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: p, error } = await supabase
      .from('vip_passes')
      .select('guest_name, event_name, event_date, event_id')
      .eq('id', id)
      .maybeSingle();
    if (error) { console.error('vip-og-image pass read:', error.message); return fallback(60); }
    if (!p) return fallback(300);

    let evt = null;
    if (p.event_id) {
      const r = await supabase.from('events').select('start_time, end_time').eq('id', p.event_id).maybeSingle();
      if (!r.error) evt = r.data;
    }

    const jpg = await renderCard({
      guestName: p.guest_name,
      eventName: p.event_name,
      eventDate: p.event_date,
      startTime: evt && evt.start_time,
      endTime: evt && evt.end_time,
    });
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        // Browsers / chat apps: a day. Netlify's CDN: for good — a change to
        // the card's text changes v, and so the URL.
        'Cache-Control': 'public, max-age=86400',
        'Netlify-CDN-Cache-Control': 'public, durable, max-age=31536000, immutable',
        'Netlify-Vary': 'query=id|v',
      },
      body: jpg.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error('vip-og-image failed:', e && e.message);
    return fallback(60);
  }
};
