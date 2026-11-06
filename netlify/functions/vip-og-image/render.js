// Draws the 1200×630 link-preview card for one VIP pass: the same dark-and-gold
// ticket as images/vip-og.jpg (tools/vip-og-template.html), personalised with
// the invitee's name, the event name, and its date · time.
//
// SVG -> pixels with resvg (WebAssembly, no native binaries), pixels -> JPEG
// with jpeg-js, so the image stays ~100 KB (WhatsApp drops large previews).
// Fonts and artwork live in ./assets, the libraries in ./vendor (see its
// README); all are loaded once per warm function.
const fs = require('fs');
const path = require('path');
const { Resvg, initWasm } = require('./vendor/resvg-wasm/index.js');
const jpeg = require('./vendor/jpeg-js');

const W = 1200, H = 630;

// Netlify places included_files at their repo-relative path inside the
// bundle; depending on the bundler the function file itself may sit elsewhere,
// so look in each likely place.
function findFile(rel, candidates) {
  for (const base of candidates) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('vip-og-image: missing ' + rel);
}
const roots = () => [
  __dirname,
  path.join(__dirname, 'netlify/functions/vip-og-image'),
  path.join(process.cwd(), 'netlify/functions/vip-og-image'),
  process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, 'netlify/functions/vip-og-image') : null,
].filter(Boolean);

let ready = null;
function load() {
  if (ready) return ready;
  ready = (async () => {
    await initWasm(fs.readFileSync(findFile('vendor/resvg-wasm/index_bg.wasm', roots())));
    const asset = (f) => fs.readFileSync(findFile(path.join('assets', f), roots()));
    return {
      fonts: ['CormorantGaramond-Bold.ttf', 'CormorantGaramond-SemiBold.ttf', 'DMSans-Medium.ttf', 'DMSans-Regular.ttf'].map((f) => new Uint8Array(asset(f))),
      art: 'data:image/png;base64,' + asset('APM-1.png').toString('base64'),
    };
  })();
  ready.catch(() => { ready = null; });   // let the next request retry
  return ready;
}

const xml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Same tidy-up as the pass page: "11 am" / "11:00am" -> "11:00 AM".
function formatTime(raw) {
  const t = String(raw || '').trim();
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?$/i);
  if (!m || +m[1] < 1 || +m[1] > 12 || (m[2] && +m[2] > 59)) return t;
  return (+m[1]) + ':' + (m[2] || '00') + ' ' + m[3].toUpperCase() + 'M';
}

function whenLine(date, start, end) {
  const s = formatTime(start), e = formatTime(end);
  const time = s ? (e ? s + ' – ' + e : s) : '';
  return [String(date || '').trim(), time].filter(Boolean).join('  ·  ');
}

// Width of a line of text as resvg will draw it, using the real fonts.
function measure(assets, text, font) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="300"><text x="10" y="200" ${font}>${xml(text)}</text></svg>`;
  const r = new Resvg(svg, { font: { fontBuffers: assets.fonts, loadSystemFonts: false } });
  const box = r.getBBox();
  r.free();
  return box ? box.width : text.length * 30;
}

// Largest size from `max` down to `min` at which `text` fits `maxWidth` on
// one line; below that, two lines split at the space nearest the middle.
function fit(assets, text, { family, weight, max, min, maxWidth, letterSpacing = 0 }) {
  const font = (size) => `font-family="${family}" font-weight="${weight}" font-size="${size}" letter-spacing="${letterSpacing}"`;
  const w = measure(assets, text, font(max));
  if (w <= maxWidth) return { lines: [text], size: max };
  const size = Math.floor(max * maxWidth / w);
  if (size >= min) return { lines: [text], size };
  const words = text.split(' ');
  if (words.length < 2) return { lines: [text], size: Math.max(Math.floor(max * maxWidth / w), 12) };
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const widest = Math.max(measure(assets, a, font(max)), measure(assets, b, font(max)));
    if (!best || widest < best.widest) best = { lines: [a, b], widest };
  }
  return { lines: best.lines, size: Math.min(max, Math.floor(max * maxWidth / best.widest), min) };
}

function textLines(fitted, { cx, firstBaseline, lineGap, family, weight, fill, letterSpacing = 0 }) {
  return fitted.lines.map((line, i) =>
    `<text x="${cx}" y="${firstBaseline + i * lineGap}" text-anchor="middle" font-family="${family}" font-weight="${weight}" font-size="${fitted.size}" letter-spacing="${letterSpacing}" fill="${fill}">${xml(line)}</text>`
  ).join('');
}

async function renderCard({ guestName, eventName, eventDate, startTime, endTime }) {
  const assets = await load();
  const cx = W / 2;
  const name = fit(assets, String(guestName || 'Our Guest').trim(), { family: 'Cormorant Garamond', weight: 700, max: 96, min: 62, maxWidth: 960 });
  const event = fit(assets, String(eventName || '').trim(), { family: 'Cormorant Garamond', weight: 700, max: 54, min: 38, maxWidth: 960 });
  const when = fit(assets, whenLine(eventDate, startTime, endTime), { family: 'DM Sans', weight: 400, max: 28, min: 18, maxWidth: 960 });

  // Name block, between "VIP INVITATION" (~250) and the divider (390): one
  // line on a baseline at 344, or two lines whose descenders clear the rule.
  const twoLineName = name.lines.length > 1;
  const nameBase = twoLineName ? Math.round(252 + 0.72 * name.size) : 344;
  const nameGap = Math.round(name.size * (twoLineName ? 1.0 : 1.02));
  const eventBase = event.lines.length === 1 ? 462 : 446;
  const eventGap = Math.round(event.size * 1.05);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bar" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#5C2D0A"/><stop offset="0.25" stop-color="#E8650A"/><stop offset="0.5" stop-color="#F5C842"/><stop offset="0.75" stop-color="#E8650A"/><stop offset="1" stop-color="#5C2D0A"/>
    </linearGradient>
    <linearGradient id="card" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#3D1F0A"/><stop offset="0.5" stop-color="#6B2D0A"/><stop offset="1" stop-color="#3D1F0A"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.32" cy="0.22" r="0.6">
      <stop offset="0" stop-color="#F5C842" stop-opacity="0.12"/><stop offset="1" stop-color="#F5C842" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rule" x1="0" x2="1">
      <stop offset="0" stop-color="#F5C842" stop-opacity="0"/><stop offset="0.5" stop-color="#F5C842" stop-opacity="0.6"/><stop offset="1" stop-color="#F5C842" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#FDF6EC"/>
  <rect width="${W}" height="10" fill="url(#bar)"/>
  <rect x="44" y="40" width="1112" height="558" rx="34" fill="url(#card)"/>
  <rect x="44" y="40" width="1112" height="558" rx="34" fill="url(#shine)"/>
  <rect x="58" y="54" width="1084" height="530" rx="24" fill="none" stroke="#F5C842" stroke-opacity="0.32" stroke-width="1.5"/>
  <circle cx="44" cy="319" r="28" fill="#FDF6EC"/>
  <circle cx="1156" cy="319" r="28" fill="#FDF6EC"/>
  <image href="${assets.art}" x="${cx - 63}" y="70" width="126" height="84"/>
  <text x="${cx}" y="192" text-anchor="middle" font-family="DM Sans" font-weight="500" font-size="17" letter-spacing="5" fill="#F5C842" fill-opacity="0.72">BAPS SWAMINARAYAN SANSTHA · SCRANTON</text>
  <text x="${cx}" y="232" text-anchor="middle" font-family="Cormorant Garamond" font-weight="600" font-size="24" letter-spacing="9" fill="#F5C842">VIP INVITATION</text>
  ${textLines(name, { cx, firstBaseline: nameBase, lineGap: nameGap, family: 'Cormorant Garamond', weight: 700, fill: '#FFFFFF' })}
  <rect x="${cx - 260}" y="389" width="245" height="1.5" fill="url(#rule)"/>
  <circle cx="${cx}" cy="390" r="4.5" fill="#F5C842" fill-opacity="0.8"/>
  <rect x="${cx + 15}" y="389" width="245" height="1.5" fill="url(#rule)"/>
  ${textLines(event, { cx, firstBaseline: eventBase, lineGap: eventGap, family: 'Cormorant Garamond', weight: 700, fill: '#F5C842' })}
  ${textLines(when, { cx, firstBaseline: 528, lineGap: 32, family: 'DM Sans', weight: 400, fill: '#FFFFFF' }).replace(/fill="#FFFFFF"/g, 'fill="#FFFFFF" fill-opacity="0.86"')}
  <text x="${cx}" y="570" text-anchor="middle" font-family="DM Sans" font-weight="500" font-size="16" letter-spacing="4" fill="#F5C842" fill-opacity="0.55">SCREVENTS.COM</text>
</svg>`;

  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { fontBuffers: assets.fonts, loadSystemFonts: false, defaultFontFamily: 'DM Sans' },
  });
  const img = r.render();
  const out = jpeg.encode({ data: Buffer.from(img.pixels), width: img.width, height: img.height }, 86).data;
  img.free(); r.free();
  return out;
}

module.exports = { renderCard, formatTime, whenLine };
