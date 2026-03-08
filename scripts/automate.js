const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Repo root is one level up from scripts/
const REPO_ROOT = path.join(__dirname, '..');

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Step 1: OCR with Claude ─────────────────────────────────────────────────

async function extractEventInfo(flyerPath) {
  console.log('📸 Reading flyer with Claude OCR...');

  const imageBuffer = fs.readFileSync(flyerPath);
  const base64Image = imageBuffer.toString('base64');
  const ext = path.extname(flyerPath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image }
          },
          {
            type: 'text',
            text: `Extract event information from this flyer. Return ONLY a JSON object with these fields:
{
  "eventName": "full event name",
  "date": "date as written on flyer",
  "time": "time as written on flyer or empty string",
  "location": "location as written on flyer or empty string",
  "description": "brief description of the event in 1-2 sentences"
}
Return only the JSON, no other text.`
          }
        ]
      }
    ]
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  const info = JSON.parse(clean);
  console.log('✅ Extracted:', info);
  return info;
}

// ─── Step 2: Get Google Form for Zone ────────────────────────────────────────

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

// ─── Step 3: Build HTML Page ─────────────────────────────────────────────────

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
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${eventInfo.eventName} – ${zoneLabel} RSVP</title>

  <meta property="og:title" content="${eventInfo.eventName} – ${zoneLabel}" />
  <meta property="og:description" content="${eventInfo.description} ${eventInfo.date ? '📅 ' + eventInfo.date : ''} ${eventInfo.time ? '⏰ ' + eventInfo.time : ''}" />
  <meta property="og:image" content="${pageUrl}/flyer.jpg" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #fff;
      min-height: 100vh;
    }
    .hero {
      width: 100%;
      max-height: 70vh;
      object-fit: contain;
      display: block;
      background: #000;
    }
    .content {
      max-width: 560px;
      margin: 0 auto;
      padding: 32px 20px 60px;
    }
    .zone-badge {
      display: inline-block;
      background: #7c3aed;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 4px 12px;
      border-radius: 20px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 26px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 12px;
    }
    .details {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 32px;
      color: #aaa;
      font-size: 15px;
    }
    .details span { display: flex; align-items: center; gap: 8px; }
    .divider {
      border: none;
      border-top: 1px solid #222;
      margin-bottom: 32px;
    }
    .rsvp-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 20px;
      color: #e5e5e5;
    }
    iframe {
      width: 100%;
      border: none;
      min-height: 480px;
      border-radius: 12px;
      background: #fff;
    }
    .open-form {
      display: block;
      text-align: center;
      margin-top: 16px;
      color: #888;
      font-size: 13px;
    }
    .open-form a { color: #7c3aed; text-decoration: none; }
    .footer {
      text-align: center;
      margin-top: 40px;
      font-size: 12px;
      color: #444;
    }
  </style>
</head>
<body>
  <img class="hero" src="${imageDataUrl}" alt="${eventInfo.eventName} flyer" />
  <div class="content">
    <span class="zone-badge">${zoneLabel}</span>
    <h1>${eventInfo.eventName}</h1>
    <div class="details">
      ${eventInfo.date ? `<span>📅 ${eventInfo.date}</span>` : ''}
      ${eventInfo.time ? `<span>⏰ ${eventInfo.time}</span>` : ''}
      ${eventInfo.location ? `<span>📍 ${eventInfo.location}</span>` : ''}
    </div>
    <hr class="divider" />
    <p class="rsvp-title">RSVP Below</p>
    <iframe src="${embedUrl}" title="RSVP Form">Loading…</iframe>
    <p class="open-form">
      Form not loading? <a href="${formUrl}" target="_blank">Open in new tab</a>
    </p>
    <div class="footer">scparasabha.com</div>
  </div>
</body>
</html>`;

  console.log('✅ HTML page built');
  return html;
}

// ─── Step 4: Deploy to Netlify ───────────────────────────────────────────────

async function deployToNetlify(html, eventSlug, zone) {
  console.log("🚀 Deploying to Netlify...");

  const crypto = require("crypto");
  const filePath = `${zone}/index.html`;
  const fileContent = Buffer.from(html);
  const sha1 = crypto.createHash("sha1").update(fileContent).digest("hex");

  // Step 1: Create deploy with file digest
  const deployRes = await axios.post(
    `https://api.netlify.com/api/v1/sites/${process.env.NETLIFY_SITE_ID}/deploys`,
    { files: { [`/${filePath}`]: sha1 }, async: false },
    {
      headers: {
        Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );

  const deployId = deployRes.data.id;
  const required = deployRes.data.required || [];

  // Step 2: Upload file if required
  if (required.includes(sha1)) {
    await axios.put(
      `https://api.netlify.com/api/v1/deploys/${deployId}/files/${filePath}`,
      fileContent,
      {
        headers: {
          Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
          "Content-Type": "application/octet-stream"
        }
      }
    );
  }

  const deployedUrl = `https://scparasabha.com/${zone}`;
  console.log("✅ Deployed!", deployedUrl);
  return deployedUrl;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const flyerRelPath = process.env.FLYER_PATH;
  const flyerPath = path.join(REPO_ROOT, flyerRelPath);

  if (!flyerRelPath) {
    console.error('❌ No flyer path provided');
    process.exit(1);
  }

  console.log(`\n🎉 Processing flyer: ${flyerPath}\n`);

  // Parse zone from FLYER_PATH env var (e.g. flyers/mountain-top/image.png)
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
