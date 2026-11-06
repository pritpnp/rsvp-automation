// Personal link previews for VIP passes.
//
// Chat apps build a link preview from the page's <meta> tags and never run
// its JavaScript, so every /vip/<id> page used to share one generic card. This
// edge function runs in front of the static pass page and rewrites its Open
// Graph / Twitter tags (and <title>) for that pass: the invitee's name, the
// event, its date · time, and a picture drawn for them by the vip-og-image
// function.
//
// It never breaks the page: on a bad id, a missing pass, missing settings, a
// slow database (over 1.5 s) or any error, the page is served unchanged with
// its generic preview.

const UUID_RE = /^\/vip\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

const attr = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Same tidy-up as the pass page: "11 am" / "11:00am" -> "11:00 AM".
function formatTime(raw) {
  const t = String(raw || '').trim();
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?$/i);
  if (!m || +m[1] < 1 || +m[1] > 12 || (m[2] && +m[2] > 59)) return t;
  return (+m[1]) + ':' + (m[2] || '00') + ' ' + m[3].toUpperCase() + 'M';
}

// FNV-1a: a short version tag for the picture URL, so an edited name or time
// gets a new image instead of a cached old one.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function setMeta(html, key, value, isName) {
  const re = new RegExp(`(<meta ${isName ? 'name' : 'property'}="${key}" content=")[^"]*(")`);
  return re.test(html) ? html.replace(re, `$1${attr(value)}$2`) : html;
}

export default async (request, context) => {
  const response = await context.next();
  let original = null;   // the page as served, once read
  try {
    const m = new URL(request.url).pathname.match(UUID_RE);
    if (!m || !(response.headers.get('content-type') || '').includes('text/html')) return response;
    const id = m[1].toLowerCase();

    const base = Netlify.env.get('SUPABASE_URL');
    const key = Netlify.env.get('SUPABASE_SERVICE_KEY');
    if (!base || !key) return response;

    const q = `${base}/rest/v1/vip_passes?id=eq.${id}&select=guest_name,event_name,event_date,events(start_time,end_time)&limit=1`;
    const r = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return response;
    const rows = await r.json();
    const p = Array.isArray(rows) && rows[0];
    if (!p || !p.guest_name) return response;

    const evt = p.events || {};
    const start = formatTime(evt.start_time), end = formatTime(evt.end_time);
    const time = start ? (end ? `${start} – ${end}` : start) : '';
    const name = String(p.guest_name).trim();
    const title = `${name} — VIP Invitation`;
    const description = [p.event_name, p.event_date, time].map((s) => String(s || '').trim()).filter(Boolean).join(' · ')
      || 'Your personal VIP pass. Please show it to a volunteer at the VIP parking lot.';
    const origin = new URL(request.url).origin;
    const v = hash([name, p.event_name, p.event_date, evt.start_time, evt.end_time].join('|'));
    const image = `${origin}/.netlify/functions/vip-og-image?id=${id}&v=${v}`;

    original = await response.text();
    let html = original;
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${attr(`VIP Pass — ${name}`)}</title>`);
    html = setMeta(html, 'og:title', title);
    html = setMeta(html, 'og:description', description);
    html = setMeta(html, 'og:image', image);
    html = setMeta(html, 'og:image:alt', `VIP Invitation for ${name}`);
    html = setMeta(html, 'twitter:title', title, true);
    html = setMeta(html, 'twitter:description', description, true);
    html = setMeta(html, 'twitter:image', image, true);
    html = setMeta(html, 'description', description, true);
    // og:url, so apps that de-duplicate by URL keep each pass separate.
    if (!/property="og:url"/.test(html)) {
      html = html.replace('<meta property="og:type"', `<meta property="og:url" content="${attr(`${origin}/vip/${id}`)}" />\n  <meta property="og:type"`);
    }

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('etag');
    // Personal content: don't let a shared cache hand it to another pass.
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return new Response(html, { status: response.status, headers });
  } catch (e) {
    console.error('vip-pass-preview:', e && e.message);
    if (original === null) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(original, { status: response.status, headers });
  }
};

export const config = { path: '/vip/*' };
