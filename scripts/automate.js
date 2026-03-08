const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const REPO_ROOT = path.join(__dirname, '..');

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function zoneName(zoneSlug) {
  const names = {
    'scranton': 'Scranton',
    'mountain-top': 'Mountain Top',
    'satsang-sabha': 'Satsang Sabha',
    'moosic': 'Moosic',
    'bloomsburg': 'Bloomsburg'
  };
  return names[zoneSlug] || zoneSlug;
}

async function extractEventInfo(flyerPath) {
  console.log('📸 Reading flyer with Claude OCR...');
  const imageBuffer = fs.readFileSync(flyerPath);
  const base64Image = imageBuffer.toString('base64');
  const ext = path.extname(flyerPath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
        { type: 'text', text: `Extract event information from this flyer. Return ONLY a JSON object:
{
  "eventName": "full event name",
  "date": "date as written on flyer",
  "time": "time as written on flyer or empty string",
  "location": "location as written on flyer or empty string",
  "description": "brief description of the event in 1-2 sentences"
}
Return only the JSON, no other text.` }
      ]
    }]
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  const info = JSON.parse(clean);
  console.log('✅ Extracted:', info);
  return info;
}

function getGoogleForm(zone) {
  console.log('📋 Looking up Google Form for zone...');
  const zoneForms = {
    'mountain-top':  '1o-Pf2-5yy5VKBZivdWlXrlKRTY6Gn0w3aC5tXWx0aZs',
    'scranton':      '18cyDaaAMUf8eOg99xt0BhpKceKqzO4IRbBcyNB9GjiI',
    'satsang-sabha': '1F0gzZ1TnagC5jBw8rdO58k4qj3LXxCFgD3LKX1OWN7o',
    'moosic':        '1rGN-E1xHU6U1OSCsJhBNoik92iiNpG-7Fop1d9eHE04',
    'bloomsburg':    '1PD9pyiweTKTutVB8maKZPqNqwR4bIPl_2TYdPmTfM3o'
  };
  const formId = zoneForms[zone];
  if (!formId) throw new Error(`No form found for zone: ${zone}`);
  const formUrl = `https://docs.google.com/forms/d/${formId}/viewform`;
  const embedUrl = `https://docs.google.com/forms/d/${formId}/viewform?embedded=true`;
  console.log('✅ Google Form ready:', formUrl);
  return { formId, formUrl, embedUrl };
}

async function buildHtmlPage(eventInfo, zone, flyerPath, embedUrl, formUrl) {
  console.log('🏗️ Building HTML page...');
  const zoneLabel = zoneName(zone);
  const imageBuffer = fs.readFileSync(flyerPath);
  const base64Image = imageBuffer.toString('base64');
  const ext = path.extname(flyerPath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const imageDataUrl = `data:${mediaType};base64,${base64Image}`;
  const pageUrl = `https://scparasabha.com/${zone}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${eventInfo.eventName} — ${zoneLabel} Zone</title>
  <meta property="og:title" content="${eventInfo.eventName} — ${zoneLabel} Zone" />
  <meta property="og:description" content="${eventInfo.date ? eventInfo.date + (eventInfo.time ? ' at ' + eventInfo.time : '') + ' · ' : ''}${eventInfo.location}" />
  <meta property="og:image" content="${pageUrl}/flyer.jpg" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --saffron: #E8650A;
      --gold: #C8860A;
      --gold-light: #F5C842;
      --cream: #FDF6EC;
      --cream-dark: #F5E6CC;
      --brown: #5C2D0A;
      --brown-mid: #8B4513;
      --text: #3D1A00;
      --text-muted: #8B6040;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--cream);
      color: var(--text);
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* ── Decorative top border ── */
    .top-border {
      height: 5px;
      background: linear-gradient(90deg, var(--brown) 0%, var(--saffron) 30%, var(--gold-light) 50%, var(--saffron) 70%, var(--brown) 100%);
    }

    /* ── Header ── */
    .header {
      background: linear-gradient(160deg, var(--brown) 0%, #7a1f00 100%);
      padding: 20px 20px 28px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }

    .header::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at 50% 0%, rgba(200,134,10,0.25) 0%, transparent 70%);
      pointer-events: none;
    }

    .header-ornament {
      font-size: 22px;
      letter-spacing: 6px;
      color: var(--gold-light);
      opacity: 0.8;
      margin-bottom: 10px;
      display: block;
    }

    .zone-label {
      display: inline-block;
      background: rgba(245,200,66,0.15);
      border: 1px solid rgba(245,200,66,0.4);
      color: var(--gold-light);
      font-family: 'DM Sans', sans-serif;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      padding: 5px 14px;
      border-radius: 40px;
      margin-bottom: 12px;
    }

    .header h1 {
      font-family: 'Cormorant Garamond', serif;
      font-size: clamp(28px, 8vw, 40px);
      font-weight: 700;
      color: #fff;
      line-height: 1.15;
      margin-bottom: 6px;
    }

    .header-subtitle {
      font-size: 13px;
      color: rgba(255,255,255,0.55);
      font-weight: 300;
      letter-spacing: 0.04em;
    }

    /* ── Flyer ── */
    .flyer-wrap {
      background: var(--brown);
      display: flex;
      justify-content: center;
      padding: 0;
    }

    .flyer-wrap img {
      width: 100%;
      max-width: 480px;
      display: block;
      object-fit: contain;
    }

    /* ── Details card ── */
    .details-card {
      margin: 0 16px;
      margin-top: -1px;
      background: #fff;
      border-radius: 0 0 20px 20px;
      box-shadow: 0 4px 24px rgba(92,45,10,0.10);
      padding: 20px 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .detail-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .detail-icon {
      width: 36px;
      height: 36px;
      background: var(--cream-dark);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 17px;
      flex-shrink: 0;
    }

    .detail-content {
      flex: 1;
    }

    .detail-label {
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 2px;
    }

    .detail-value {
      font-size: 15px;
      font-weight: 500;
      color: var(--text);
      line-height: 1.4;
    }

    /* ── Divider ── */
    .section-divider {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 24px 16px 8px;
    }

    .section-divider::before,
    .section-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--cream-dark), transparent);
    }

    .section-divider span {
      font-family: 'Cormorant Garamond', serif;
      font-size: 18px;
      font-weight: 600;
      color: var(--brown-mid);
      white-space: nowrap;
    }

    /* ── RSVP section ── */
    .rsvp-section {
      padding: 0 16px 40px;
    }

    .rsvp-note {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
      margin-bottom: 16px;
      line-height: 1.5;
    }

    .form-container {
      background: #fff;
      border-radius: 20px;
      box-shadow: 0 4px 24px rgba(92,45,10,0.10);
      overflow: hidden;
    }

    iframe {
      width: 100%;
      border: none;
      min-height: 520px;
      display: block;
    }

    .open-form-link {
      text-align: center;
      padding: 14px;
      border-top: 1px solid var(--cream-dark);
    }

    .open-form-link a {
      font-size: 13px;
      color: var(--saffron);
      text-decoration: none;
      font-weight: 500;
    }

    /* ── Footer ── */
    .footer {
      text-align: center;
      padding: 20px;
      font-size: 11px;
      color: var(--text-muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .footer-logo {
      font-family: 'Cormorant Garamond', serif;
      font-size: 15px;
      font-weight: 600;
      color: var(--brown-mid);
      display: block;
      margin-bottom: 4px;
      letter-spacing: 0.05em;
    }

    /* ── Animations ── */
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .header       { animation: fadeUp 0.5s ease both; }
    .flyer-wrap   { animation: fadeUp 0.5s 0.1s ease both; }
    .details-card { animation: fadeUp 0.5s 0.2s ease both; }
    .rsvp-section { animation: fadeUp 0.5s 0.3s ease both; }
  </style>
</head>
<body>

  <div class="top-border"></div>

  <div class="header">
    <span class="header-ornament">✦ ✦ ✦</span>
    <div class="zone-label">BAPS ${zoneLabel} Zone</div>
    <h1>${eventInfo.eventName}</h1>
    <p class="header-subtitle">You are cordially invited</p>
  </div>

  <div class="flyer-wrap">
    <img src="${imageDataUrl}" alt="${eventInfo.eventName} flyer" />
  </div>

  <div class="details-card">
    ${eventInfo.date ? `
    <div class="detail-row">
      <div class="detail-icon">📅</div>
      <div class="detail-content">
        <div class="detail-label">Date</div>
        <div class="detail-value">${eventInfo.date}${eventInfo.time ? ' at ' + eventInfo.time : ''}</div>
      </div>
    </div>` : ''}
    ${eventInfo.location ? `
    <div class="detail-row">
      <div class="detail-icon">📍</div>
      <div class="detail-content">
        <div class="detail-label">Location</div>
        <div class="detail-value">${eventInfo.location}</div>
      </div>
    </div>` : ''}
  </div>

  <div class="section-divider">
    <span>RSVP</span>
  </div>

  <div class="rsvp-section">
    <p class="rsvp-note">Please fill out the form below to confirm your attendance.</p>
    <div class="form-container">
      <iframe src="${embedUrl}" title="RSVP Form">Loading…</iframe>
      <div class="open-form-link">
        <a href="${formUrl}" target="_blank">Open form in browser ↗</a>
      </div>
    </div>
  </div>

  <div class="footer">
    <span class="footer-logo">SC Parasabha</span>
    scparasabha.com
  </div>

</body>
</html>`;

  console.log('✅ HTML page built');
  return html;
}

async function deployToNetlify(html, eventSlug, zone) {
  console.log('🚀 Deploying to Netlify...');
  const crypto = require('crypto');
  const filePath = `${zone}/index.html`;
  const fileContent = Buffer.from(html);
  const sha1 = crypto.createHash('sha1').update(fileContent).digest('hex');

  const deployRes = await axios.post(
    `https://api.netlify.com/api/v1/sites/${process.env.NETLIFY_SITE_ID}/deploys`,
    { files: { [`/${filePath}`]: sha1 }, async: false },
    { headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`, 'Content-Type': 'application/json' } }
  );

  const deployId = deployRes.data.id;
  const required = deployRes.data.required || [];

  if (required.includes(sha1)) {
    await axios.put(
      `https://api.netlify.com/api/v1/deploys/${deployId}/files/${filePath}`,
      fileContent,
      { headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`, 'Content-Type': 'application/octet-stream' } }
    );
  }

  const deployedUrl = `https://scparasabha.com/${zone}`;
  console.log('✅ Deployed!', deployedUrl);
  return deployedUrl;
}

async function main() {
  const flyerRelPath = process.env.FLYER_PATH;
  const flyerPath = path.join(REPO_ROOT, flyerRelPath);

  if (!flyerRelPath) {
    console.error('❌ No flyer path provided');
    process.exit(1);
  }

  console.log(`\n🎉 Processing flyer: ${flyerPath}\n`);

  const parts = flyerRelPath.split('/');
  const zone = parts[1];
  console.log(`📍 Zone: ${zone}`);

  const eventInfo = await extractEventInfo(flyerPath);
  const { embedUrl, formUrl } = getGoogleForm(zone);
  const html = await buildHtmlPage(eventInfo, zone, flyerPath, embedUrl, formUrl);
  const eventSlug = slugify(eventInfo.eventName);
  const deployedUrl = await deployToNetlify(html, eventSlug, zone);

  console.log(`\n✨ All done!\n`);
  console.log(`🔗 Your RSVP page: ${deployedUrl}`);
  console.log(`📲 Share this link on WhatsApp/Telegram!\n`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
