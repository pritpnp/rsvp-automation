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
- location: Read street numbers very carefully. Count each digit exactly as printed. Do not add or remove digits (e.g. "311" must not become "3111").
- rsvpDeadline: YYYY-MM-DD format using year 2026 unless clearly stated otherwise. Empty string if not mentioned.
- invitationYPercent: A number between 0 and 1 representing how far down the image (as a fraction of total height) the word "Invitation" first appears. If not present, use 0.55.

{"eventName":"...","date":"...","time":"...","location":"...","description":"...","rsvpDeadline":"...","invitationYPercent":0.55}` }
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
  const safeLog = { ...info, location: '[redacted]' };
  console.log('✅ Extracted:', JSON.stringify(safeLog, null, 2));
  return info;
}

function buildHtmlPage(eventInfo, zone, flyerPath, embedUrl, formUrl, noPreview = false) {
  const zoneLabel = zoneName(zone);
  const pageUrl = `https://screvents.com/${zone}`;
  const flyerUrl = `${pageUrl}/flyer.jpg`;

  const logoPath = path.join(REPO_ROOT, 'images', 'baps-logo.png');
  const bapsLogoBase64 = fs.existsSync(logoPath)
    ? fs.readFileSync(logoPath).toString('base64')
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${eventInfo.eventName} — ${zoneLabel} Zone</title>
  ${bapsLogoBase64 ? `<link rel="icon" type="image/png" href="data:image/png;base64,${bapsLogoBase64}" />` : ''}
  ${noPreview ? '' : `<meta property="og:title" content="${eventInfo.eventName} — ${zoneLabel} Zone" />
  <meta property="og:description" content="${eventInfo.date ? eventInfo.date + (eventInfo.time ? ' at ' + eventInfo.time : '') + ' · ' : ''}${eventInfo.location}" />
  <meta property="og:image" content="${pageUrl}/og.jpg" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="website" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta name="twitter:card" content="summary_large_image" />`}
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
    <div class="zone-label">BAPS ${zone === 'satsang-sabha' ? 'Satsang Sabha Events' : zoneLabel + ' Zone'}</div>
  </div>
  <div class="flyer-wrap"><img src="${flyerUrl}" alt="${eventInfo.eventName} flyer" /></div>
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
        <iframe id="rsvp-iframe" src="${embedUrl}" title="RSVP Form" tabindex="-1" onload="onIframeLoad()">Loading…</iframe>
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
    // Lock scroll to top until user intentionally scrolls
    if (history.scrollRestoration) history.scrollRestoration = 'manual';
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);

    var userHasScrolled = false;
    window.addEventListener('touchstart', function() { userHasScrolled = true; }, { once: true });
    window.addEventListener('wheel', function() { userHasScrolled = true; }, { once: true });

    function onIframeLoad() {
      document.getElementById('form-loader').style.display = 'none';
      if (!userHasScrolled) {
        window.scrollTo(0, 0);
        // Keep snapping back for a short window in case of delayed focus steal
        var snaps = 0;
        var interval = setInterval(function() {
          if (!userHasScrolled) window.scrollTo(0, 0);
          if (++snaps >= 10) clearInterval(interval);
        }, 50);
      }
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
      fetch('/.netlify/functions/late-rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, guests: guests, zone: '${zoneLabel} Zone', eventName: '${eventInfo.eventName}' })
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


async function buildOgImage(flyerPath, invitationYPercent) {
  const metadata = await sharp(flyerPath).metadata();
  const { width: w, height: h } = metadata;

  const cutY = Math.max(0, Math.round((invitationYPercent || 0.55) * h) - 50);
  console.log(`🖼️  OG image cut at y=${cutY} (${Math.round(cutY/h*100)}%)`);

  // Sample dominant background color from flyer
  const { dominant } = await sharp(flyerPath).stats();
  const bg = { r: dominant.r, g: dominant.g, b: dominant.b };

  async function makePanel(top, left, width, height) {
    // Sharp thumbnail (contain) — no cropping
    const contained = await sharp(flyerPath)
      .extract({ left, top, width, height })
      .resize(600, 630, { fit: 'contain', background: bg })
      .toBuffer();

    // Blurred background — stretch to fill then blur
    const blurred = await sharp(flyerPath)
      .extract({ left, top, width, height })
      .resize(600, 630, { fit: 'fill' })
      .blur(40)
      .toBuffer();

    // Composite: blurred bg + sharp contained image on top
    return sharp(blurred)
      .composite([{ input: contained }])
      .toBuffer();
  }

  const leftPanel = await makePanel(0, 0, w, cutY);
  const rightPanel = await makePanel(cutY, 0, w, h - cutY);

  // Composite side by side
  return sharp({ create: { width: 1200, height: 630, channels: 3, background: bg } })
    .composite([
      { input: leftPanel, left: 0, top: 0 },
      { input: rightPanel, left: 600, top: 0 }
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function buildHubPage(allFlyers, deadlines) {
  // Load BAPS logo from images folder if available
  const logoPath = path.join(REPO_ROOT, 'images', 'baps-logo.png');
  const bapsLogoBase64 = fs.existsSync(logoPath)
    ? fs.readFileSync(logoPath).toString('base64')
    : '';

  const sansthaLogoPath = path.join(REPO_ROOT, 'images', 'baps-sanstha.png');
  const bapsSansthaBase64 = fs.existsSync(sansthaLogoPath)
    ? fs.readFileSync(sansthaLogoPath).toString('base64')
    : '';

  const zoneLabels = {
    'mountain-top': 'Mountain Top',
    'scranton': 'Scranton',
    'satsang-sabha': 'Satsang Sabha',
    'moosic': 'Moosic',
    'bloomsburg': 'Bloomsburg'
  };

  const today = new Date().toISOString().split('T')[0];

  // Only show zones with a flyer AND upcoming event date
  const activeZones = allFlyers.filter(({ zone }) => {
    const info = deadlines[zone];
    if (!info) return false;
    if (info.eventDate && info.eventDate < today) return false;
    return true;
  });

  const cards = activeZones.map(({ zone }) => {
    const info = deadlines[zone] || {};
    const label = zoneLabels[zone] || zone;
    const eventName = info.eventName || 'Para Satsang Sabha';
    const date = info.date || '';
    const time = info.time || '';
    const deadline = info.deadline ? new Date(info.deadline + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

    return `
    <a href="/${zone}" class="card" style="animation-delay: ${activeZones.indexOf(allFlyers.find(f => f.zone === zone))}00ms">
      <div class="card-inner">
        <div class="card-zone">${zone === 'satsang-sabha' ? 'Satsang Sabha Events' : label + ' Zone'}</div>
        <div class="card-event">${eventName}</div>
        ${date ? `<div class="card-detail">📅 ${date}${time ? ' at ' + time : ''}</div>` : ''}
        ${deadline ? `<div class="card-detail">⏳ RSVP by ${deadline}</div>` : ''}
        <div class="card-cta">View Invitation →</div>
      </div>
    </a>`;
  }).join('');

  const noEvents = activeZones.length === 0 ? `
    <div class="no-events">
      <p>No upcoming events at this time.</p>
      <p>Check back soon!</p>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BAPS SCRANTON MANDIR</title>
  ${bapsLogoBase64 ? `<link rel="icon" type="image/png" href="data:image/png;base64,${bapsLogoBase64}" />` : ''}
  <meta name="description" content="RSVP for upcoming BAPS events in the Scranton region." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --saffron: #C8860A;
      --gold: #E8A020;
      --cream: #FDF6EC;
      --brown: #3D1F0A;
      --light-brown: #7A4520;
      --card-bg: #FFFAF3;
    }

    body {
      background-color: var(--cream);
      color: var(--brown);
      font-family: 'DM Sans', sans-serif;
      min-height: 100vh;
    }

    /* Decorative top border */
    .top-border {
      height: 5px;
      background: linear-gradient(90deg, var(--saffron), var(--gold), var(--saffron));
    }

    /* Header */
    header {
      text-align: center;
      padding: 56px 24px 40px;
      background: linear-gradient(180deg, #FDF0D8 0%, var(--cream) 100%);
      border-bottom: 1px solid rgba(200, 134, 10, 0.15);
    }

    .baps-logo {
      width: 90px;
      height: 90px;
      margin: 0 auto 20px;
    }

    header h1 {
      font-family: 'Cormorant Garamond', serif;
      font-size: clamp(34px, 7vw, 48px);
      font-weight: 700;
      color: var(--brown);
      line-height: 1.15;
      letter-spacing: -0.02em;
    }

    header h1 span {
      color: var(--saffron);
      font-style: italic;
    }

    header p {
      margin-top: 12px;
      font-size: 17px;
      color: var(--light-brown);
      font-weight: 300;
      letter-spacing: 0.04em;
    }

    .divider {
      width: 48px;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--gold), transparent);
      margin: 20px auto 0;
    }

    /* Grid */
    main {
      max-width: 900px;
      margin: 0 auto;
      padding: 48px 20px 80px;
    }

    .section-label {
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--saffron);
      text-align: center;
      margin-bottom: 28px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 20px;
    }

    /* Cards */
    .card {
      text-decoration: none;
      display: block;
      opacity: 0;
      animation: fadeUp 0.5s ease forwards;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .card-inner {
      background: var(--card-bg);
      border: 1px solid rgba(200, 134, 10, 0.2);
      border-radius: 16px;
      padding: 28px 24px;
      height: 100%;
      transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
      position: relative;
      overflow: hidden;
    }

    .card-inner::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--saffron), var(--gold));
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    .card:hover .card-inner {
      transform: translateY(-4px);
      box-shadow: 0 12px 32px rgba(200, 134, 10, 0.12);
      border-color: rgba(200, 134, 10, 0.4);
    }

    .card:hover .card-inner::before {
      opacity: 1;
    }

    .card-zone {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--saffron);
      margin-bottom: 8px;
    }

    .card-event {
      font-family: 'Cormorant Garamond', serif;
      font-size: 30px;
      font-weight: 700;
      color: var(--brown);
      line-height: 1.2;
      margin-bottom: 14px;
    }

    .card-detail {
      font-size: 15px;
      color: var(--light-brown);
      margin-bottom: 6px;
      font-weight: 300;
    }

    .card-cta {
      margin-top: 20px;
      font-size: 15px;
      font-weight: 500;
      color: var(--saffron);
      letter-spacing: 0.02em;
    }

    /* No events */
    .no-events {
      text-align: center;
      padding: 60px 20px;
      color: var(--light-brown);
      font-family: 'Cormorant Garamond', serif;
      font-size: 20px;
      line-height: 1.8;
    }

    /* Footer */
    footer {
      text-align: center;
      padding: 24px;
      font-size: 12px;
      color: rgba(122, 69, 32, 0.5);
      letter-spacing: 0.04em;
      border-top: 1px solid rgba(200, 134, 10, 0.1);
    }
  </style>
</head>
<body>
  <div class="top-border"></div>

  <header>
    ${bapsLogoBase64 ? `<div style="width:120px;height:120px;border-radius:50%;border:2px solid rgba(200,134,10,0.4);overflow:hidden;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;"><img src="data:image/png;base64,${bapsLogoBase64}" style="width:100%;height:auto;object-fit:contain;" alt="BAPS" /></div>` : ''}
    <h1>BAPS SCRANTON MANDIR</h1>
    <p>Upcoming Events</p>
    <div class="divider"></div>
  </header>

  <main>
    ${activeZones.length > 0 ? '<p class="section-label">Select your zone to RSVP</p>' : ''}
    <div class="grid">
      ${cards}
    </div>
    ${noEvents}
  </main>

  <footer>
    ${bapsSansthaBase64
      ? `<img src="data:image/png;base64,${bapsSansthaBase64}" style="max-width:200px;width:100%;display:block;margin:0 auto 8px;" alt="BAPS Swaminarayan Sanstha" />`
      : `<span class="footer-logo">BAPS Swaminarayan Sanstha</span>`}
    <a href="https://www.baps.org/Scranton" target="_blank" style="color:rgba(122,69,32,0.6);text-decoration:none;font-size:12px;letter-spacing:0.04em;">www.baps.org/Scranton</a>
  </footer>
</body>
</html>`;
}

async function deployAllToNetlify(pages, deadlines = {}, eventInfoMap = {}) {
  console.log(`🚀 Deploying ${pages.length} page(s) to Netlify in one deploy...`);

  // Build file manifest
  const files = {};
  const fileContents = {};

  // Add hub page at root
  const hubHtml = buildHubPage(pages, deadlines || {});
  const hubContent = Buffer.from(hubHtml);
  const hubSha1 = crypto.createHash('sha1').update(hubContent).digest('hex');
  files['/index.html'] = hubSha1;
  fileContents[hubSha1] = { filePath: '/index.html', content: hubContent };

  for (const { zone, html, flyerPath } of pages) {
    // HTML page
    const htmlFilePath = `/${zone}/index.html`;
    const htmlContent = Buffer.from(html);
    const htmlSha1 = crypto.createHash('sha1').update(htmlContent).digest('hex');
    files[htmlFilePath] = htmlSha1;
    fileContents[htmlSha1] = { filePath: htmlFilePath, content: htmlContent };

    // No-preview version at /np/{zone}/ — same page but OG/Twitter tags stripped
    const pageData = pages.find(p => p.zone === zone);
    if (pageData) {
      const npHtml = buildHtmlPage(eventInfoMap[zone], zone, flyerPath, pageData.embedUrl, pageData.formUrl, true);
      const npFilePath = `/np/${zone}/index.html`;
      const npContent = Buffer.from(npHtml);
      const npSha1 = crypto.createHash('sha1').update(npContent).digest('hex');
      files[npFilePath] = npSha1;
      fileContents[npSha1] = { filePath: npFilePath, content: npContent };
    }

    // OG image — 1200x630 split preview for WhatsApp/social
    // Use preview.png/jpg if present in zone folder, otherwise fall back to flyer
    const zoneDir = path.dirname(flyerPath);
    const previewPath = ['preview.png', 'preview.jpg', 'preview.jpeg']
      .map(f => path.join(zoneDir, f))
      .find(f => fs.existsSync(f)) || flyerPath;
    console.log(`🖼️  OG source: ${path.basename(previewPath)}`);
    const ogFilePath = `/${zone}/og.jpg`;
    const ogContent = await buildOgImage(previewPath, eventInfoMap[zone]?.invitationYPercent);
    const ogSha1 = crypto.createHash('sha1').update(ogContent).digest('hex');
    files[ogFilePath] = ogSha1;
    fileContents[ogSha1] = { filePath: ogFilePath, content: ogContent };
    console.log(`🖼️  OG image: ${Math.round(ogContent.length / 1024)}KB`);

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
  const zones = ['satsang-sabha', 'mountain-top', 'scranton', 'moosic', 'bloomsburg'];
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
  const eventInfoMap = {};
  const deadlines = {};

  for (const { zone, flyerRelPath, flyerPath } of allFlyers) {
    const isChanged = changedFlyers.includes(flyerRelPath);
    console.log(`\n❓ Zone: ${zone} — ${isChanged ? '🆕 NEW' : '♻️ existing'}`);

    const eventInfo = await extractEventInfo(flyerPath);
    eventInfoMap[zone] = eventInfo;

    const { embedUrl, formUrl } = getGoogleForm(zone);
    const html = buildHtmlPage(eventInfo, zone, flyerPath, embedUrl, formUrl);
    pages.push({ zone, html, flyerPath, embedUrl, formUrl });
    console.log(`✅ Page ready for ${zone}`);

    if (eventInfo && eventInfo.rsvpDeadline) {
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

  // Save deadlines.json
  const deadlinesPath = path.join(REPO_ROOT, 'deadlines.json');
  let existing = {};
  if (fs.existsSync(deadlinesPath)) {
    try { existing = JSON.parse(fs.readFileSync(deadlinesPath, 'utf8')); } catch(e) {}
  }
  const merged = { ...existing, ...deadlines };
  fs.writeFileSync(deadlinesPath, JSON.stringify(merged, null, 2));
  console.log('📅 deadlines.json updated:', merged);

  const deployedUrls = await deployAllToNetlify(pages, merged, eventInfoMap);

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