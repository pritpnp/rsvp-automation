const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

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
    'mountain-top':  'https://forms.office.com/Pages/ResponsePage.aspx?id=vYPE0EyNF0uHS9KIombwfolzbVLOnpVGkHKVQVfq6HdUNUwxNTFRV0tSVTkyVDBGRVpYRE5QSDVBSi4u',
    'scranton':      'https://forms.office.com/Pages/ResponsePage.aspx?id=vYPE0EyNF0uHS9KIombwfolzbVLOnpVGkHKVQVfq6HdUNThFNTFGMTRKVlE1SUM4MVJKR05JNlA2Ny4u',
    'satsang-sabha': 'https://forms.office.com/Pages/ResponsePage.aspx?id=vYPE0EyNF0uHS9KIombwfolzbVLOnpVGkHKVQVfq6HdUODdBRUVZM1pLRk8xRDZaN0JENkg3WUJRVi4u',
    'moosic':        'https://forms.office.com/Pages/ResponsePage.aspx?id=vYPE0EyNF0uHS9KIombwfolzbVLOnpVGkHKVQVfq6HdUNjhXRUVMNkExVEVNQVZRNDhBRTRRUDFXRy4u',
    'bloomsburg':    'https://forms.office.com/Pages/ResponsePage.aspx?id=vYPE0EyNF0uHS9KIombwfolzbVLOnpVGkHKVQVfq6HdUNlpMN09XTFBNUTBCMjRLSVNUOVcxVjkzRC4u'
  };
  const formUrl = zoneForms[zone];
  if (!formUrl) throw new Error('No form found for zone: ' + zone);
  return { formUrl, embedUrl: formUrl };
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
      { type: 'text', text: `The current year is 2026. Extract event info from this flyer. Return ONLY valid JSON with NO extra text.

STRICT RULES:
- date: Use format "Weekday, Month Day" e.g. "Friday, March 20". NEVER use ISO format. NEVER include year.
- time: Use format "6:00 pm" (lowercase am/pm)
- location: Address ONLY. No sponsor names, no host names. Just the street address, city, state, zip.
- rsvpDeadline: YYYY-MM-DD format using year 2026 unless clearly stated otherwise. Empty string if not mentioned.

{"eventName":"...","date":"...","time":"...","location":"...","description":"...","rsvpDeadline":"..."}` }
    ]}]
  });
  const info = JSON.parse(response.content[0].text.trim().replace(/\`\`\`json|\`\`\`/g, '').trim());
  // Normalize date: if Claude returned ISO format (YYYY-MM-DD), convert to friendly
  if (info.date && /^\d{4}-\d{2}-\d{2}$/.test(info.date)) {
    info.date = new Date(info.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }
  // If no rsvpDeadline found, warn loudly
  if (!info.rsvpDeadline) {
    console.warn('⚠️  No RSVP deadline found on flyer — form will always be shown');
  }
  console.log('✅ Extracted:', JSON.stringify(info, null, 2));
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
  <meta property="og:image" content="${pageUrl}/flyer.jpg" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="website" />
  <meta property="og:image:width" content="1080" />
  <meta property="og:image:height" content="2340" />
  <meta property="og:image:type" content="image/jpeg" />
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
    iframe { width: 100%; border: none; height: 900px; display: block; }
    @keyframes spin { to { transform: rotate(360deg); } }
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
    <div class="zone-label">BAPS ${zoneLabel}${zone === 'satsang-sabha' ? '' : ' Zone'}</div>
  </div>
  <div class="flyer-wrap"><img src="${imageDataUrl}" alt="${eventInfo.eventName} flyer" /></div>
  <div class="details-card">
    ${eventInfo.date ? `<div class="detail-row"><div class="detail-icon">📅</div><div class="detail-content"><div class="detail-label">Date</div><div class="detail-value">${eventInfo.date}${eventInfo.time ? ' at ' + eventInfo.time : ''}</div></div></div>` : ''}
    ${eventInfo.location ? `<div class="detail-row"><div class="detail-icon">📍</div><div class="detail-content"><div class="detail-label">Location</div><div class="detail-value">${eventInfo.location}</div></div></div>` : ''}
    ${eventInfo.rsvpDeadline ? `<div class="detail-row"><div class="detail-icon">⏳</div><div class="detail-content"><div class="detail-label">RSVP By</div><div class="detail-value">${new Date(eventInfo.rsvpDeadline + 'T12:00:00').toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'})}</div></div></div>` : ''}
  </div>
  <div class="section-divider"><span>RSVP</span></div>
  <div class="rsvp-section">
    <div id="rsvp-open">
      ${!eventInfo.rsvpDeadline ? `<p style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:700;color:#C8860A;text-align:center;margin-bottom:8px;">RSVP Not Required</p>` : ''}
      <p class="rsvp-note">Please fill out the form below to confirm your attendance.</p>
      <div class="form-container" style="position:relative;">
        <div id="form-loader" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#fff;z-index:1;min-height:200px;">
          <div style="width:36px;height:36px;border:3px solid #e0d5c8;border-top-color:#C8860A;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
          <span style="font-size:13px;color:#8B6040;">Loading form...</span>
        </div>
        <iframe id="rsvp-iframe" data-src="${embedUrl}" title="RSVP Form" src="about:blank" onload="document.getElementById('form-loader').style.display='none'">Loading…</iframe>
        <div class="open-form-link"><a href="${formUrl}" target="_blank">Open form in browser ↗</a></div>
      </div>
    </div>
    <div id="rsvp-closed" style="display:none;">
      <div style="background:#fff;border-radius:20px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(92,45,10,0.10);">
        <div style="font-size:48px;margin-bottom:12px;">🙏</div>
        <h2 style="font-family:'Cormorant Garamond',serif;font-size:24px;color:#5C2D0A;margin-bottom:8px;">RSVP is now closed</h2>
        <p style="font-size:14px;color:#8B6040;line-height:1.6;margin-bottom:24px;">The deadline has passed, but you can still send a late request below.</p>
        <div id="late-form" style="text-align:left;">
          <input id="late-name" type="text" placeholder="Full Name" style="width:100%;padding:12px 14px;border:1px solid #e0d5c8;border-radius:12px;font-size:15px;margin-bottom:10px;box-sizing:border-box;font-family:'DM Sans',sans-serif;" />
          <input id="late-guests" type="number" placeholder="Number of Guests" min="1" style="width:100%;padding:12px 14px;border:1px solid #e0d5c8;border-radius:12px;font-size:15px;margin-bottom:16px;box-sizing:border-box;font-family:'DM Sans',sans-serif;" />
          <button onclick="sendLateRsvp()" style="width:100%;padding:14px;background:linear-gradient(135deg,#C8860A,#E6A817);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;">Send Late Request 🙏</button>
        </div>
        <div id="late-success" style="display:none;padding:16px;background:#f0fdf4;border-radius:12px;color:#166534;font-size:14px;">✅ Your late RSVP request has been sent!</div>
        <div id="late-error" style="display:none;padding:16px;background:#fef2f2;border-radius:12px;color:#991b1b;font-size:14px;">❌ Something went wrong. Please try again.</div>
      </div>
    </div>
  </div>
  <div class="footer"><span class="footer-logo">SC Parasabha</span>scparasabha.com</div>
  <script>
    // Force page to top on load
    if (history.scrollRestoration) history.scrollRestoration = 'manual';
    window.addEventListener('load', function() { window.scrollTo(0, 0); });

    // Load iframe when it comes into view
    var iframe = document.getElementById('rsvp-iframe');
    if (iframe) {
      var observer = new IntersectionObserver(function(entries) {
        if (entries[0].isIntersecting) {
          iframe.src = iframe.getAttribute('data-src');
          observer.disconnect();
        }
      }, { rootMargin: '200px' });
      observer.observe(iframe);
    }

    (function() {
      var deadline = "${eventInfo.rsvpDeadline || ''}";
      if (!deadline) return;
      var cutoff = new Date(deadline);
      cutoff.setHours(23, 59, 59, 999);
      if (new Date() > cutoff) {
        document.getElementById("rsvp-open").style.display = "none";
        document.getElementById("rsvp-closed").style.display = "block";
      }
    })();

    function sendLateRsvp() {
      var name = document.getElementById('late-name').value.trim();
      var guests = document.getElementById('late-guests').value.trim();
      if (!name || !guests) { alert('Please enter your name and number of guests.'); return; }
      var token = '${process.env.TELEGRAM_BOT_TOKEN}';
      var chatId = '${process.env.TELEGRAM_CHAT_ID}';
      var zone = '${zoneLabel}';
      var event = '${eventInfo.eventName}';
      var text = '⚠️ Late RSVP Request\\n🏛 ' + zone + ' Zone — ' + event + '\\n👤 ' + name + '\\n👥 Guests: ' + guests;
      fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
      }).then(function(r) {
        if (r.ok) {
          document.getElementById('late-form').style.display = 'none';
          document.getElementById('late-success').style.display = 'block';
        } else {
          document.getElementById('late-error').style.display = 'block';
        }
      }).catch(function() {
        document.getElementById('late-error').style.display = 'block';
      });
    }
  </script>
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

    // Flyer image — compress to JPEG under 300KB for WhatsApp preview
    const imgFilePath = `/${zone}/flyer.jpg`;
    const imgContent = await sharp(flyerPath)
      .resize({ width: 1080, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    console.log(`🗜️ Compressed flyer: ${Math.round(imgContent.length / 1024)}KB`);
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

  if (changedFlyers.length) {
    console.log(`\n🎉 Changed flyers: ${changedFlyers.join(', ')}`);
  } else {
    console.log('\n♻️ No changed flyers detected — redeploying all zones...');
  }

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

  // Save deadlines.json to repo for summary.js to use
  const deadlines = {};
  for (const { zone, flyerRelPath, flyerPath } of allFlyers) {
    const eventInfo = await extractEventInfo(flyerPath).catch(() => null);
    if (eventInfo && eventInfo.rsvpDeadline) {
      // Convert friendly date like "Friday, March 20" to YYYY-MM-DD
      let eventDateISO = '';
      if (eventInfo.date) {
        try {
          const parsed = new Date(eventInfo.date + ', 2026');
          if (!isNaN(parsed)) eventDateISO = parsed.toISOString().split('T')[0];
        } catch(e) {}
      }
      deadlines[zone] = {
        deadline: eventInfo.rsvpDeadline,
        eventName: eventInfo.eventName || 'Para Satsang Sabha',
        date: eventInfo.date || '',
        eventDate: eventDateISO,
        time: eventInfo.time || ''
      };
    }
  }
  const deadlinesPath = path.join(REPO_ROOT, 'deadlines.json');
  // Merge with existing deadlines to preserve other zones
  let existing = {};
  if (fs.existsSync(deadlinesPath)) {
    try { existing = JSON.parse(fs.readFileSync(deadlinesPath, 'utf8')); } catch(e) {}
  }
  const merged = { ...existing, ...deadlines };
  fs.writeFileSync(deadlinesPath, JSON.stringify(merged, null, 2));
  console.log('📅 deadlines.json updated:', merged);

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