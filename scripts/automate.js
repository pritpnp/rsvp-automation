const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REPO_ROOT = path.join(__dirname, '..');

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function zoneName(zoneSlug) {
  const names = { 'scranton': 'Scranton', 'mountain-top': 'Mountain Top', 'satsang-sabha': 'Satsang Sabha', 'moosic': 'Moosic', 'bloomsburg': 'Bloomsburg' };
  return names[zoneSlug] || zoneSlug;
}

function getGoogleForm(zone) {
  const zoneForms = {
    'mountain-top':  '1o-Pf2-5yy5VKBZivdWlXrlKRTY6Gn0w3aC5tXWx0aZs',
    'scranton':      '18cyDaaAMUf8eOg99xt0BhpKceKqzO4IRbBcyNB9GjiI',
    'satsang-sabha': '1F0gzZ1TnagC5jBw8rdO58k4qj3LXxCFgD3LKX1OWN7o',
    'moosic':        '1rGN-E1xHU6U1OSCsJhBNoik92iiNpG-7Fop1d9eHE04',
    'bloomsburg':    '1PD9pyiweTKTutVB8maKZPqNqwR4bIPl_2TYdPmTfM3o'
  };
  const formId = zoneForms[zone];
  if (!formId) throw new Error(`No form found for zone: ${zone}`);
  return {
    formId,
    formUrl: `https://docs.google.com/forms/d/${formId}/viewform`,
    embedUrl: `https://docs.google.com/forms/d/${formId}/viewform?embedded=true`
  };
}

async function extractEventInfo(flyerPath) {
  console.log('📸 Reading flyer with Claude OCR...');
  const imageBuffer = fs.readFileSync(flyerPath);
  const base64Image = imageBuffer.toString('base64');
  const mediaType = path.extname(flyerPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
      { type: 'text', text: `Extract event info. Return ONLY JSON:\n{"eventName":"...","date":"...","time":"...","location":"...","description":"..."}` }
    ]}]
  });
  const info = JSON.parse(response.content[0].text.trim().replace(/\`\`\`json|\`\`\`/g, '').trim());
  console.log('✅ Extracted:', info);
  return info;
}

function buildHtmlPage(eventInfo, zone, flyerPath, embedUrl, formUrl) {
  const zoneLabel = zoneName(zone);
  const imageBuffer = fs.readFileSync(flyerPath);
  const base64Image = imageBuffer.toString('base64');
  const mediaType = path.extname(flyerPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const imageDataUrl = `data:${mediaType};base64,${base64Image}`;
  const pageUrl = `https://scparasabha.com/${zone}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${eventInfo.eventName} — ${zoneLabel} Zone</title>
  <meta property="og:title" content="${eventInfo.eventName} — ${zoneLabel} Zone" />
  <meta property="og:description" content="${eventInfo.date ? eventInfo.date + (eventInfo.time ? ' at ' + eventInfo.time : '') + ' · ' : ''}${eventInfo.location}" />
  <meta property="og:image" content="${pageUrl}/flyer${path.extname(flyerPath).toLowerCase()}" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="website" />
  <meta property="og:image:width" content="1125" />
  <meta property="og:image:height" content="2436" />
  <meta property="og:image:type" content="image/png" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --saffron: #E8650A; --gold: #C8860A; --gold-light: #F5C842;
      --cream: #FDF6EC; --cream-dark: #F5E6CC;
      --brown: #5C2D0A; --brown-mid: #8B4513;
      --text: #3D1A00; --text-muted: #8B6040;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', sans-serif; background: var(--cream); color: var(--text); min-height: 100vh; overflow-x: hidden; }
    .top-border { height: 5px; background: linear-gradient(90deg, var(--brown) 0%, var(--saffron) 30%, var(--gold-light) 50%, var(--saffron) 70%, var(--brown) 100%); }
    .header { background: linear-gradient(160deg, var(--brown) 0%, #7a1f00 100%); padding: 20px 20px 28px; text-align: center; position: relative; overflow: hidden; }
    .header::before { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 0%, rgba(200,134,10,0.25) 0%, transparent 70%); pointer-events: none; }
    .header-ornament { font-size: 22px; letter-spacing: 6px; color: var(--gold-light); opacity: 0.8; margin-bottom: 10px; display: block; }
    .zone-label { display: inline-block; background: rgba(245,200,66,0.15); border: 1px solid rgba(245,200,66,0.4); color: var(--gold-light); font-size: 11px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; padding: 5px 14px; border-radius: 40px; margin-bottom: 12px; }
    .header h1 { font-family: 'Cormorant Garamond', serif; font-size: clamp(28px, 8vw, 40px); font-weight: 700; color: #fff; line-height: 1.15; margin-bottom: 6px; }
    .header-subtitle { font-size: 13px; color: rgba(255,255,255,0.55); font-weight: 300; letter-spacing: 0.04em; }
    .flyer-wrap { background: var(--brown); display: flex; justify-content: center; }
    .flyer-wrap img { width: 100%; max-width: 480px; display: block; object-fit: contain; }
    .details-card { margin: 0 16px; background: #fff; border-radius: 0 0 20px 20px; box-shadow: 0 4px 24px rgba(92,45,10,0.10); padding: 20px 20px 24px; display: flex; flex-direction: column; gap: 12px; }
    .detail-row { display: flex; align-items: flex-start; gap: 12px; }
    .detail-icon { width: 36px; height: 36px; background: var(--cream-dark); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 17px; flex-shrink: 0; }
    .detail-label { font-size: 10px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px; }
    .detail-value { font-size: 15px; font-weight: 500; color: var(--text); line-height: 1.4; }
    .section-divider { display: flex; align-items: center; gap: 12px; padding: 24px 16px 8px; }
    .section-divider::before, .section-divider::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--cream-dark), transparent); }
    .section-divider span { font-family: 'Cormorant Garamond', serif; font-size: 18px; font-weight: 600; color: var(--brown-mid); white-space: nowrap; }
    .rsvp-section { padding: 0 16px 40px; }
    .rsvp-note { font-size: 13px; color: var(--text-muted); text-align: center; margin-bottom: 16px; line-height: 1.5; }
    .form-container { background: #fff; border-radius: 20px; box-shadow: 0 4px 24px rgba(92,45,10,0.10); overflow: hidden; }
    iframe { width: 100%; border: none; min-height: 520px; display: block; }
    .open-form-link { text-align: center; padding: 14px; border-top: 1px solid var(--cream-dark); }
    .open-form-link a { font-size: 13px; color: var(--saffron); text-decoration: none; font-weight: 500; }
    .footer { text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted); letter-spacing: 0.08em; text-transform: uppercase; }
    .footer-logo { font-family: 'Cormorant Garamond', serif; font-size: 15px; font-weight: 600; color: var(--brown-mid); display: block; margin-bottom: 4px; }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    .header { animation: fadeUp 0.5s ease both; }
    .flyer-wrap { animation: fadeUp 0.5s 0.1s ease both; }
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
  <div class="flyer-wrap"><img src="${imageDataUrl}" alt="${eventInfo.eventName} flyer" /></div>
  <div class="details-card">
    ${eventInfo.date ? `<div class="detail-row"><div class="detail-icon">📅</div><div class="detail-content"><div class="detail-label">Date</div><div class="detail-value">${eventInfo.date}${eventInfo.time ? ' at ' + eventInfo.time : ''}</div></div></div>` : ''}
    ${eventInfo.location ? `<div class="detail-row"><div class="detail-icon">📍</div><div class="detail-content"><div class="detail-label">Location</div><div class="detail-value">${eventInfo.location}</div></div></div>` : ''}
  </div>
  <div class="section-divider"><span>RSVP</span></div>
  <div class="rsvp-section">
    <p class="rsvp-note">Please fill out the form below to confirm your attendance.</p>
    <div class="form-container">
      <iframe src="${embedUrl}" title="RSVP Form">Loading…</iframe>
      <div class="open-form-link"><a href="${formUrl}" target="_blank">Open form in browser ↗</a></div>
    </div>
  </div>
  <div class="footer"><span class="footer-logo">SC Parasabha</span>scparasabha.com</div>
</body>
</html>`;
}

async function deployAllToNetlify(pages) {
  console.log(`🚀 Deploying ${pages.length} page(s) to Netlify in one deploy...`);

  // Build file manifest
  const files = {};
  const fileContents = {};

  for (const { zone, html, flyerPath } of pages) {
    // HTML page
    const htmlFilePath = `/${zone}/index.html`;
    const htmlContent = Buffer.from(html);
    const htmlSha1 = crypto.createHash('sha1').update(htmlContent).digest('hex');
    files[htmlFilePath] = htmlSha1;
    fileContents[htmlSha1] = { filePath: htmlFilePath, content: htmlContent };

    // Flyer image for OG preview
    const ext = require('path').extname(flyerPath).toLowerCase();
    const imgFilePath = `/${zone}/flyer${ext}`;
    const imgContent = fs.readFileSync(flyerPath);
    const imgSha1 = crypto.createHash('sha1').update(imgContent).digest('hex');
    files[imgFilePath] = imgSha1;
    fileContents[imgSha1] = { filePath: imgFilePath, content: imgContent };
  }

  // Create deploy
  const deployRes = await axios.post(
    `https://api.netlify.com/api/v1/sites/${process.env.NETLIFY_SITE_ID}/deploys`,
    { files, async: false },
    { headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`, 'Content-Type': 'application/json' } }
  );

  const deployId = deployRes.data.id;
  const required = deployRes.data.required || [];

  // Upload required files
  for (const sha1 of required) {
    const { filePath, content } = fileContents[sha1];
    console.log(`📤 Uploading ${filePath}...`);
    await axios.put(
      `https://api.netlify.com/api/v1/deploys/${deployId}/files${filePath}`,
      content,
      { headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`, 'Content-Type': 'application/octet-stream' } }
    );
  }

  console.log('✅ All pages deployed!');
  return pages.map(({ zone }) => `https://scparasabha.com/${zone}`);
}

async function main() {
  const flyerPathsRaw = process.env.FLYER_PATHS || process.env.FLYER_PATH || '';
  const changedFlyers = flyerPathsRaw.split(',').map(s => s.trim()).filter(Boolean);

  if (!changedFlyers.length) {
    console.error('❌ No flyer paths provided');
    process.exit(1);
  }

  console.log(`
🎉 Changed flyers: ${changedFlyers.join(', ')}
`);

  // Scan ALL zone folders in the repo and collect every flyer
  const REPO_ROOT_PATH = path.join(__dirname, '..');
  const zones = ['mountain-top', 'scranton', 'satsang-sabha', 'moosic', 'bloomsburg'];
  const allFlyers = [];

  for (const zone of zones) {
    const zoneDir = path.join(REPO_ROOT_PATH, 'flyers', zone);
    if (!fs.existsSync(zoneDir)) continue;
    const files = fs.readdirSync(zoneDir).filter(f => /.(png|jpg|jpeg)$/i.test(f));
    for (const file of files) {
      allFlyers.push({ zone, flyerRelPath: `flyers/${zone}/${file}`, flyerPath: path.join(zoneDir, file) });
    }
  }

  if (!allFlyers.length) {
    console.log('ℹ️ No flyers found in any zone folder.');
    process.exit(0);
  }

  console.log(`📦 Deploying all ${allFlyers.length} flyer(s) across all zones...
`);

  const pages = [];

  for (const { zone, flyerRelPath, flyerPath } of allFlyers) {
    const isChanged = changedFlyers.includes(flyerRelPath);
    console.log(`
📍 Zone: ${zone} — ${isChanged ? '🆕 NEW' : '♻️ existing'}`);

    const eventInfo = await extractEventInfo(flyerPath);
    const { embedUrl, formUrl } = getGoogleForm(zone);
    const html = buildHtmlPage(eventInfo, zone, flyerPath, embedUrl, formUrl);
    pages.push({ zone, html, flyerPath });
    console.log(`✅ Page ready for ${zone}`);
  }

  const deployedUrls = await deployAllToNetlify(pages);

  console.log('\n✨ All done!');
  for (const url of deployedUrls) {
    console.log(`🔗 ${url}`);
  }
  console.log('📲 Share these links on WhatsApp/Telegram!');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});