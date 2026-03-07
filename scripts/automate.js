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

// ─── Step 2: Create Tally Form ───────────────────────────────────────────────

async function createTallyForm(eventInfo, zone) {
  console.log('📋 Creating Tally form...');

  const zoneLabel = zoneName(zone);
  const formTitle = `${eventInfo.eventName} – ${zoneLabel} RSVP`;

  const response = await axios.post(
    'https://api.tally.so/forms',
    {
      title: formTitle,
      fields: [
        {
          type: 'INPUT_TEXT',
          label: 'Full Name',
          placeholder: 'Enter your full name',
          required: true
        },
        {
          type: 'INPUT_PHONE_NUMBER',
          label: 'Phone Number',
          placeholder: 'Enter your phone number',
          required: true
        },
        {
          type: 'INPUT_NUMBER',
          label: 'Number of Guests Attending',
          placeholder: 'Including yourself',
          required: true
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.TALLY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const formId = response.data.id;
  const embedUrl = `https://tally.so/embed/${formId}?alignLeft=1&hideTitle=1&transparentBackground=1`;
  console.log('✅ Tally form created:', formId);
  return { formId, embedUrl };
}

// ─── Step 3: Build HTML Page ─────────────────────────────────────────────────

async function buildHtmlPage(eventInfo, zone, flyerPath, embedUrl) {
  console.log('🏗️ Building HTML page...');

  const zoneLabel = zoneName(zone);
  const imageBuffer = fs.readFileSync(flyerPath);
  const base64Image = imageBuffer.toString('base64');
  const ext = path.extname(flyerPath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const imageDataUrl = `data:${mediaType};base64,${base64Image}`;

  const pageUrl = `https://scparasabha.com/rsvp/${zone}/${slugify(eventInfo.eventName)}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${eventInfo.eventName} – ${zoneLabel} RSVP</title>

  <!-- OG Tags for WhatsApp / Telegram preview -->
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
      min-height: 420px;
      border-radius: 12px;
      background: #1a1a1a;
    }

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
    <iframe src="${embedUrl}" title="RSVP Form"></iframe>

    <div class="footer">scparasabha.com</div>
  </div>

</body>
</html>`;

  console.log('✅ HTML page built');
  return html;
}

// ─── Step 4: Deploy to Netlify ───────────────────────────────────────────────

async function deployToNetlify(html, eventSlug, zone) {
  console.log('🚀 Deploying to Netlify...');

  const deployPath = `rsvp/${zone}/${eventSlug}`;
  const files = {
    [`${deployPath}/index.html`]: Buffer.from(html)
  };

  // Build zip in memory
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  for (const [filePath, content] of Object.entries(files)) {
    zip.addFile(filePath, content);
  }

  const zipBuffer = zip.toBuffer();

  const response = await axios.post(
    `https://api.netlify.com/api/v1/sites/${process.env.NETLIFY_SITE_ID}/deploys`,
    zipBuffer,
    {
      headers: {
        Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
        'Content-Type': 'application/zip'
      }
    }
  );

  const deployedUrl = `https://scparasabha.com/${deployPath}`;
  console.log('✅ Deployed!', deployedUrl);
  return deployedUrl;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const flyerPath = path.join(REPO_ROOT, process.env.FLYER_PATH);

  if (!flyerPath) {
    console.error('❌ No flyer path provided');
    process.exit(1);
  }

  console.log(`\n🎉 Processing flyer: ${flyerPath}\n`);

  // Parse zone from path: flyers/scranton/image.jpg
  const flyerRelPath = process.env.FLYER_PATH;
  const parts = flyerRelPath.split('/');
  const zone = parts[1];
  const fileName = parts[2];

  console.log(`📍 Zone: ${zone}`);

  // Run all steps
  const eventInfo = await extractEventInfo(flyerPath);
  const { embedUrl } = await createTallyForm(eventInfo, zone);
  const html = await buildHtmlPage(eventInfo, zone, flyerPath, embedUrl);
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
