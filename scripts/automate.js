const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REPO_ROOT = path.join(__dirname, '..');

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function zoneName(zoneSlug) {
  const names = { 'scranton': 'Scranton', 'mountain-top': 'Mountain Top', 'satsang-sabha': 'Satsang Sabha', 'moosic': 'Moosic', 'bloomsburg': 'Bloomsburg' };
  return names[zoneSlug] || zoneSlug;
}

const PARASABHA_ZONES = ['scranton', 'mountain-top', 'moosic', 'bloomsburg'];
const MANDIR_ZONES = ['satsang-sabha', 'mandir-1', 'mandir-2', 'mandir-3', 'mandir-4', 'mandir-5'];
const MANDIR_SLOTS = ['mandir-1', 'mandir-2', 'mandir-3', 'mandir-4', 'mandir-5'];

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

// ── Supabase: resolve canonical event name ────────────────────────────────
// If a name has been set in zone_events, use it.
// Otherwise, save the OCR-extracted name as the initial value and return it.
async function resolveEventName(supabase, zone, ocrName) {
  try {
    const { data, error } = await supabase
      .from('zone_events')
      .select('event_name')
      .eq('zone', zone)
      .single();

    if (error || !data) {
      // Row missing — upsert OCR name as initial value
      console.log(`  📝 No DB name for ${zone} — saving OCR name: "${ocrName}"`);
      await supabase.from('zone_events').upsert({ zone, event_name: ocrName, updated_at: new Date().toISOString() });
      return ocrName;
    }

    const stored = (data.event_name || '').trim();
    if (!stored) {
      // Row exists but empty — save OCR name
      console.log(`  📝 Empty DB name for ${zone} — saving OCR name: "${ocrName}"`);
      await supabase.from('zone_events').update({ event_name: ocrName, updated_at: new Date().toISOString() }).eq('zone', zone);
      return ocrName;
    }

    if (stored !== ocrName) {
      console.log(`  ✏️  Using DB name for ${zone}: "${stored}" (OCR said: "${ocrName}")`);
    } else {
      console.log(`  ✅ DB name matches OCR for ${zone}: "${stored}"`);
    }
    return stored;
  } catch (e) {
    console.warn(`  ⚠️  Supabase lookup failed for ${zone} — falling back to OCR name. Error: ${e.message}`);
    return ocrName;
  }
}

async function extractEventInfo(flyerPath) {
  console.log('📸 Reading flyer with Claude OCR...');
  // Compress image to JPEG under 4MB before sending to Claude API (5MB limit)
  const MAX_BYTES = 4 * 1024 * 1024;
  let imageBuffer = fs.readFileSync(flyerPath);
  // Detect actual media type from magic bytes, not file extension
  const isPng = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47;
  let mediaType = isPng ? 'image/png' : 'image/jpeg';
  // Always normalize to JPEG for Claude API (handles PNG-saved-as-jpg and large files)
  if (isPng || imageBuffer.length > MAX_BYTES) {
    if (imageBuffer.length > MAX_BYTES) {
      console.log(`⚠️  Flyer is ${Math.round(imageBuffer.length/1024/1024*10)/10}MB — compressing for OCR...`);
    } else if (isPng) {
      console.log(`⚠️  Flyer is PNG — converting to JPEG for OCR...`);
    }
    imageBuffer = await sharp(imageBuffer)
      .resize({ width: 1800, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    mediaType = 'image/jpeg';
    console.log(`✅ Converted to ${Math.round(imageBuffer.length/1024)}KB JPEG for OCR`);
  }
  const base64Image = imageBuffer.toString('base64');
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
  const tabLogoPath = path.join(REPO_ROOT, 'images', 'tab-logo.png');
  const tabLogoBase64 = fs.existsSync(tabLogoPath)
    ? fs.readFileSync(tabLogoPath).toString('base64')
    : bapsLogoBase64;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${eventInfo.eventName} — ${zoneLabel} Zone</title>
  ${tabLogoBase64 ? `<link rel="icon" type="image/png" href="data:image/png;base64,${tabLogoBase64}" />` : ''}
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
  <a href="https://screvents.com" style="display:block;text-align:right;padding:8px 16px;background:rgba(92,45,10,0.06);border-bottom:1px solid rgba(200,134,10,0.12);text-decoration:none;">
    <span style="font-size:12px;font-weight:500;color:#8B4513;letter-spacing:0.04em;">← Change Zone</span>
  </a>
  <div class="header">
    <div class="zone-label">BAPS ${zone === 'satsang-sabha' ? 'Satsang Sabha Events' : zoneName(zone) + ' Zone'}</div>
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
      var cutoff = new Date(deadline + 'T00:00:00');
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
        body: JSON.stringify({ name: name, guests: guests, zone: '${zone}', eventName: '${eventInfo.eventName}' })
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


function buildMandirPage(eventInfo, slot, flyerPath, embedUrl, formUrl, noPreview = false, overrideUrl = null) {
  const pageUrl = overrideUrl || `https://screvents.com/mandir/${slot.replace('mandir-', '')}`;
  const flyerUrl = `${pageUrl}/flyer.jpg`;
  const logoPath = path.join(REPO_ROOT, 'images', 'baps-logo.png');
  const bapsLogoBase64 = fs.existsSync(logoPath) ? fs.readFileSync(logoPath).toString('base64') : '';
  const tabLogoPath = path.join(REPO_ROOT, 'images', 'tab-logo.png');
  const tabLogoBase64 = fs.existsSync(tabLogoPath) ? fs.readFileSync(tabLogoPath).toString('base64') : bapsLogoBase64;
  const hasRsvp = !!eventInfo.rsvpDeadline;
  const embedSrc = hasRsvp && embedUrl ? embedUrl : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${eventInfo.eventName} — BAPS Scranton Mandir</title>
  ${tabLogoBase64 ? `<link rel="icon" type="image/png" href="data:image/png;base64,${tabLogoBase64}" />` : ''}
  ${noPreview ? '' : `<meta property="og:title" content="${eventInfo.eventName} — BAPS Scranton Mandir" />
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
      --maroon: #7A1F2E; --maroon-mid: #A0304A; --maroon-light: #E8A0B0;
      --cream: #FDF6EC; --cream-dark: #F5E6CC;
      --text: #3D1A00; --text-muted: #8B6040;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', sans-serif; background: var(--cream); color: var(--text); min-height: 100vh; overflow-x: hidden; }
    .top-border { height: 5px; background: linear-gradient(90deg, var(--maroon) 0%, var(--maroon-mid) 30%, var(--maroon-light) 50%, var(--maroon-mid) 70%, var(--maroon) 100%); }
    .change-zone { display:block; text-align:right; padding:8px 16px; background:rgba(122,31,46,0.06); border-bottom:1px solid rgba(122,31,46,0.12); text-decoration:none; }
    .change-zone span { font-size:12px; font-weight:500; color:var(--maroon-mid); letter-spacing:0.04em; }
    .header { background: linear-gradient(160deg, var(--maroon) 0%, #4A0F1A 100%); padding: 20px 20px 28px; text-align: center; position: relative; overflow: hidden; }
    .header::before { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 0%, rgba(232,160,176,0.2) 0%, transparent 70%); pointer-events: none; }
    .mandir-label { display: inline-block; background: rgba(232,160,176,0.15); border: 1px solid rgba(232,160,176,0.4); color: var(--maroon-light); font-size: 11px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; padding: 5px 14px; border-radius: 40px; margin-bottom: 12px; }
    .header h1 { font-family: 'Cormorant Garamond', serif; font-size: clamp(28px, 8vw, 40px); font-weight: 700; color: #fff; line-height: 1.15; margin-bottom: 6px; }
    .flyer-wrap { background: var(--maroon); display: flex; justify-content: center; }
    .flyer-wrap img { width: 100%; max-width: 480px; display: block; object-fit: contain; }
    .details-card { margin: 0 16px; background: #fff; border-radius: 0 0 20px 20px; box-shadow: 0 4px 24px rgba(122,31,46,0.10); padding: 20px 20px 24px; display: flex; flex-direction: column; gap: 12px; }
    .detail-row { display: flex; align-items: flex-start; gap: 12px; }
    .detail-icon { width: 36px; height: 36px; background: #fdf0f3; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 17px; flex-shrink: 0; }
    .detail-label { font-size: 10px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px; }
    .detail-value { font-size: 15px; font-weight: 500; color: var(--text); line-height: 1.4; }
    .section-divider { display: flex; align-items: center; gap: 12px; padding: 24px 16px 8px; }
    .section-divider::before, .section-divider::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, rgba(122,31,46,0.2), transparent); }
    .section-divider span { font-family: 'Cormorant Garamond', serif; font-size: 18px; font-weight: 600; color: var(--maroon-mid); white-space: nowrap; }
    .rsvp-section { padding: 0 16px 40px; }
    .rsvp-note { font-size: 13px; color: var(--text-muted); text-align: center; margin-bottom: 16px; line-height: 1.5; }
    .form-container { background: #fff; border-radius: 20px; box-shadow: 0 4px 24px rgba(122,31,46,0.10); overflow: hidden; }
    iframe { width: 100%; border: none; height: 900px; display: block; }
    .open-form-link { text-align: center; padding: 14px; border-top: 1px solid var(--cream-dark); }
    .open-form-link a { font-size: 13px; color: var(--maroon-mid); text-decoration: none; font-weight: 500; }
    .footer { text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted); letter-spacing: 0.08em; text-transform: uppercase; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    .header { animation: fadeUp 0.5s ease both; }
    .flyer-wrap { animation: fadeUp 0.5s 0.1s ease both; }
    .details-card { animation: fadeUp 0.5s 0.2s ease both; }
    .rsvp-section { animation: fadeUp 0.5s 0.3s ease both; }
  </style>
</head>
<body>
  <div class="top-border"></div>
  <a href="https://screvents.com" class="change-zone">
    <span>← Back to Events</span>
  </a>
  <div class="header">
    <div class="mandir-label">BAPS Scranton Mandir Event</div>
    <h1>${eventInfo.eventName}</h1>
  </div>
  <div class="flyer-wrap"><img src="${flyerUrl}" alt="${eventInfo.eventName} flyer" /></div>
  <div class="details-card">
    ${eventInfo.date ? `<div class="detail-row"><div class="detail-icon">📅</div><div class="detail-content"><div class="detail-label">Date</div><div class="detail-value">${eventInfo.date}${eventInfo.time ? ' at ' + eventInfo.time : ''}</div></div></div>` : ''}
    ${eventInfo.location ? `<div class="detail-row"><div class="detail-icon">📍</div><div class="detail-content"><div class="detail-label">Location</div><div class="detail-value">${eventInfo.location}</div></div></div>` : ''}
    ${hasRsvp ? `<div class="detail-row"><div class="detail-icon">⏳</div><div class="detail-content"><div class="detail-label">RSVP By</div><div class="detail-value">${new Date(eventInfo.rsvpDeadline + 'T12:00:00').toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'})}</div></div></div>` : ''}
  </div>
  ${hasRsvp && embedSrc ? `
  <div class="section-divider"><span>RSVP</span></div>
  <div class="rsvp-section">
    <p class="rsvp-note">Please fill out the form below to confirm your attendance.</p>
    <div class="form-container" style="position:relative;">
      <div id="form-loader" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#fff;z-index:1;min-height:200px;">
        <div style="width:36px;height:36px;border:3px solid #e0d5c8;border-top-color:#A0304A;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
        <span style="font-size:13px;color:#8B6040;">Loading form...</span>
      </div>
      <iframe src="${embedSrc}" title="RSVP Form" onload="document.getElementById('form-loader').style.display='none'">Loading…</iframe>
      <div class="open-form-link"><a href="${formUrl}" target="_blank">Open form in browser ↗</a></div>
    </div>
  </div>` : ''}
  <div class="footer">screvents.com &nbsp;·&nbsp; BAPS Scranton Mandir</div>
</body>
</html>`;
}

async function buildOgImage(flyerPath, invitationYPercent) {
  const metadata = await sharp(flyerPath).metadata();
  const { width: w, height: h } = metadata;
  const aspectRatio = w / h;
  const TARGET_RATIO = 1.9;
  const VARIATION = 0.20;

  if (aspectRatio >= TARGET_RATIO * (1 - VARIATION) && aspectRatio <= TARGET_RATIO * (1 + VARIATION)) {
    console.log(`🖼️  Flyer ratio ${aspectRatio.toFixed(2)} is close to 1.9:1 — using directly`);
    return sharp(flyerPath)
      .resize(1200, 630, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  console.log(`🖼️  Flyer ratio ${aspectRatio.toFixed(2)} — using 50/50 split`);
  const cutY = Math.round(h * 0.50);

  async function makePanel(top, width, height) {
    const blurred = await sharp(flyerPath)
      .resize(600, 630, { fit: 'fill' })
      .blur(40)
      .toBuffer();

    const contained = await sharp(flyerPath)
      .extract({ left: 0, top, width, height })
      .resize(600, 630, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    return sharp(blurred)
      .composite([{ input: contained, blend: 'over' }])
      .toBuffer();
  }

  const leftPanel = await makePanel(0, w, cutY);
  const rightPanel = await makePanel(cutY, w, h - cutY);

  const { dominant } = await sharp(flyerPath).stats();
  return sharp({ create: { width: 1200, height: 630, channels: 3, background: dominant } })
    .composite([
      { input: leftPanel, left: 0, top: 0 },
      { input: rightPanel, left: 600, top: 0 }
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function buildHubPage(allFlyers, deadlines) {
  const logoPath = path.join(REPO_ROOT, 'images', 'baps-logo.png');
  const bapsLogoBase64 = fs.existsSync(logoPath) ? fs.readFileSync(logoPath).toString('base64') : '';
  const tabLogoPath = path.join(REPO_ROOT, 'images', 'tab-logo.png');
  const tabLogoBase64 = fs.existsSync(tabLogoPath) ? fs.readFileSync(tabLogoPath).toString('base64') : bapsLogoBase64;
  const sansthaLogoPath = path.join(REPO_ROOT, 'images', 'baps-sanstha.png');
  const bapsSansthaBase64 = fs.existsSync(sansthaLogoPath) ? fs.readFileSync(sansthaLogoPath).toString('base64') : '';

  const zoneLabels = {
    'mountain-top': 'Mountain Top',
    'scranton': 'Scranton',
    'satsang-sabha': 'Satsang Sabha',
    'moosic': 'Moosic',
    'bloomsburg': 'Bloomsburg'
  };

  const today = new Date().toISOString().split('T')[0];

  const isActive = (zone) => {
    const info = deadlines[zone];
    if (!info) return false;
    if (info.eventDate && info.eventDate < today) return false;
    return true;
  };

  const activeParasabha = allFlyers.filter(({ zone }) => PARASABHA_ZONES.includes(zone) && isActive(zone));
  const activeMandir = allFlyers.filter(({ zone }) => MANDIR_ZONES.includes(zone) && isActive(zone));

  const makeCard = (zone, href, labelText, accentClass, idx) => {
    const info = deadlines[zone] || {};
    const eventName = info.eventName || 'Upcoming Event';
    const date = info.date || '';
    const time = info.time || '';
    const deadline = info.deadline ? new Date(info.deadline + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
    return `
    <a href="${href}" class="card ${accentClass}" style="animation-delay: ${idx}00ms">
      <div class="card-inner">
        <div class="card-zone">${labelText}</div>
        <div class="card-event">${eventName}</div>
        ${date ? `<div class="card-detail">📅 ${date}${time ? ' at ' + time : ''}</div>` : ''}
        ${deadline ? `<div class="card-detail">⏳ RSVP by ${deadline}</div>` : ''}
        <div class="card-cta">View Details →</div>
      </div>
    </a>`;
  };

  const parasabhaCards = activeParasabha
    .slice()
    .sort((a, b) => {
      const dateA = (deadlines[a.zone] || {}).eventDate || '';
      const dateB = (deadlines[b.zone] || {}).eventDate || '';
      return dateA.localeCompare(dateB);
    })
    .map(({ zone }, idx) => makeCard(zone, `/${zone}`, zoneLabels[zone] + ' Zone', 'card-parasabha', idx))
    .join('');

  const mandirCards = activeMandir.map(({ zone }, idx) => {
    const href = MANDIR_SLOTS.includes(zone) ? `/mandir/${zone.replace('mandir-', '')}` : `/${zone}`;
    const label = zone === 'satsang-sabha' ? 'Satsang Sabha' : 'Mandir Event';
    return makeCard(zone, href, label, 'card-mandir', idx);
  }).join('');

  const noEvents = (activeParasabha.length + activeMandir.length) === 0 ? `
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
  ${tabLogoBase64 ? `<link rel="icon" type="image/png" href="data:image/png;base64,${tabLogoBase64}" />` : ''}
  <meta name="description" content="RSVP for upcoming BAPS events in the Scranton region." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --saffron: #C8860A; --gold: #E8A020; --cream: #FDF6EC;
      --brown: #3D1F0A; --light-brown: #7A4520; --card-bg: #FFFAF3;
    }
    body { background-color: var(--cream); color: var(--brown); font-family: 'DM Sans', sans-serif; min-height: 100vh; }
    .top-border { height: 5px; background: linear-gradient(90deg, var(--saffron), var(--gold), var(--saffron)); }
    header { text-align: center; padding: 56px 24px 40px; background: linear-gradient(180deg, #FDF0D8 0%, var(--cream) 100%); border-bottom: 1px solid rgba(200,134,10,0.15); }
    .baps-logo { width: 90px; height: 90px; margin: 0 auto 20px; }
    header h1 { font-family: 'Cormorant Garamond', serif; font-size: clamp(34px, 7vw, 48px); font-weight: 700; color: var(--brown); line-height: 1.15; letter-spacing: -0.02em; }
    header h1 span { color: var(--saffron); font-style: italic; }
    header p { margin-top: 12px; font-size: 17px; color: var(--light-brown); font-weight: 300; letter-spacing: 0.04em; }
    .divider { width: 48px; height: 2px; background: linear-gradient(90deg, transparent, var(--gold), transparent); margin: 20px auto 0; }
    main { max-width: 900px; margin: 0 auto; padding: 48px 20px 80px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 20px; }
    .card { text-decoration: none; display: block; opacity: 0; animation: fadeUp 0.5s ease forwards; }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    .card-inner { border-radius: 16px; padding: 28px 24px; height: 100%; transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease; position: relative; overflow: hidden; }
    .card-inner::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; opacity: 0; transition: opacity 0.2s ease; }
    .card:hover .card-inner { transform: translateY(-4px); }
    .card:hover .card-inner::before { opacity: 1; }
    .card-parasabha .card-inner { background: var(--card-bg); border: 1px solid rgba(200,134,10,0.2); }
    .card-parasabha .card-inner::before { background: linear-gradient(90deg, var(--saffron), var(--gold)); }
    .card-parasabha:hover .card-inner { box-shadow: 0 12px 32px rgba(200,134,10,0.12); border-color: rgba(200,134,10,0.4); }
    .card-parasabha .card-zone { color: var(--saffron); }
    .card-parasabha .card-cta { color: var(--saffron); }
    .card-mandir .card-inner { background: #FFF8F9; border: 1px solid rgba(122,31,46,0.18); }
    .card-mandir .card-inner::before { background: linear-gradient(90deg, #7A1F2E, #C0405A); }
    .card-mandir:hover .card-inner { box-shadow: 0 12px 32px rgba(122,31,46,0.12); border-color: rgba(122,31,46,0.35); }
    .card-mandir .card-zone { color: #A0304A; }
    .card-mandir .card-cta { color: #A0304A; }
    .card-zone { font-size: 17px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px; }
    .card-event { font-family: 'Cormorant Garamond', serif; font-size: 30px; font-weight: 700; color: var(--brown); line-height: 1.2; margin-bottom: 14px; }
    .card-detail { font-size: 15px; color: var(--light-brown); margin-bottom: 6px; font-weight: 300; }
    .card-cta { margin-top: 20px; font-size: 15px; font-weight: 500; letter-spacing: 0.02em; }
    .section-header { font-size: 11px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 20px; margin-top: 48px; padding-bottom: 10px; border-bottom: 1px solid rgba(200,134,10,0.15); }
    .section-header.parasabha { color: var(--saffron); border-color: rgba(200,134,10,0.2); }
    .section-header.mandir { color: #A0304A; border-color: rgba(122,31,46,0.15); margin-top: 48px; }
    .section-header:first-child { margin-top: 0; }
    .no-events { text-align: center; padding: 60px 20px; color: var(--light-brown); font-family: 'Cormorant Garamond', serif; font-size: 20px; line-height: 1.8; }
    footer { text-align: center; padding: 24px; font-size: 12px; color: rgba(122,69,32,0.5); letter-spacing: 0.04em; border-top: 1px solid rgba(200,134,10,0.1); }
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
    ${activeParasabha.length > 0 ? '<div class="section-header parasabha">Parasabha Events</div>' : ''}
    ${activeParasabha.length > 0 ? `<div class="grid">${parasabhaCards}</div>` : ''}
    ${activeMandir.length > 0 ? '<div class="section-header mandir">Mandir Events</div>' : ''}
    ${activeMandir.length > 0 ? `<div class="grid">${mandirCards}</div>` : ''}
    ${noEvents}
  </main>
  <footer>
    ${bapsSansthaBase64
      ? `<img src="data:image/png;base64,${bapsSansthaBase64}" style="max-width:200px;width:100%;display:block;margin:0 auto 8px;" alt="BAPS Swaminarayan Sanstha" />`
      : `<span style="font-family:'Cormorant Garamond',serif;font-size:15px;font-weight:600;color:#8B4513;display:block;margin-bottom:4px;">BAPS Swaminarayan Sanstha</span>`}
    <a href="https://www.baps.org/Scranton" target="_blank" style="color:rgba(122,69,32,0.6);text-decoration:none;font-size:12px;letter-spacing:0.04em;">www.baps.org/Scranton</a>
    <div style="margin-top:16px;"><a href="/admin" style="font-size:11px;color:rgba(122,69,32,0.35);text-decoration:none;letter-spacing:0.06em;border:1px solid rgba(122,69,32,0.15);padding:4px 12px;border-radius:20px;">Admin Portal</a></div>
  </footer>
</body>
</html>`;
}

async function deployAllToNetlify(pages, deadlines = {}, eventInfoMap = {}) {
  console.log(`🚀 Deploying ${pages.length} page(s) to Netlify in one deploy...`);

  const files = {};
  const fileContents = {};

  // Add hub page at root
  const hubHtml = buildHubPage(pages, deadlines || {});
  const hubContent = Buffer.from(hubHtml);
  const hubSha1 = crypto.createHash('sha1').update(hubContent).digest('hex');
  files['/index.html'] = hubSha1;
  fileContents[hubSha1] = { filePath: '/index.html', content: hubContent };

  // Add static pages: VIP pass, login, admin
  const staticPages = [
    { filePath: '/vip/index.html',           diskPath: path.join(__dirname, '..', 'public', 'vip',           'index.html') },
    { filePath: '/login/index.html',         diskPath: path.join(__dirname, '..', 'public', 'login',         'index.html') },
    { filePath: '/admin/index.html',         diskPath: path.join(__dirname, '..', 'public', 'admin',         'index.html') },
    { filePath: '/flyer-builder/index.html',              diskPath: path.join(__dirname, '..', 'public', 'flyer-builder', 'index.html') },
    { filePath: '/flyer-builder/review-sent/index.html', diskPath: path.join(__dirname, '..', 'public', 'flyer-builder', 'review-sent', 'index.html') },
  ];
  const tabLogoPath = path.join(REPO_ROOT, 'images', 'tab-logo.png');
  const tabLogoBase64 = fs.existsSync(tabLogoPath) ? fs.readFileSync(tabLogoPath).toString('base64') : '';
  const faviconTag = tabLogoBase64 ? `<link rel="icon" type="image/png" href="data:image/png;base64,${tabLogoBase64}" />` : '';

  for (const { filePath, diskPath } of staticPages) {
    if (fs.existsSync(diskPath)) {
      let html = fs.readFileSync(diskPath, 'utf8');
      if (faviconTag) {
        html = html.replace(/<link rel="icon"[^>]*\/>/g, '');
        html = html.replace('</head>', `  ${faviconTag}\n</head>`);
      }
      const content = Buffer.from(html);
      const sha1 = crypto.createHash('sha1').update(content).digest('hex');
      files[filePath] = sha1;
      fileContents[sha1] = { filePath, content };
      console.log(`📄 Added static page: ${filePath}`);
    } else {
      console.warn(`⚠️  Static page not found, skipping: ${diskPath}`);
    }
  }

  for (const { zone, html, flyerPath } of pages) {
    const isMandirSlot  = MANDIR_SLOTS.includes(zone);
    const isMandirStyle = isMandirSlot || zone === 'satsang-sabha';
    const basePath      = isMandirSlot ? `/mandir/${zone.replace('mandir-', '')}` : `/${zone}`;

    // HTML page
    const htmlFilePath = `${basePath}/index.html`;
    const htmlContent  = Buffer.from(html);
    const htmlSha1     = crypto.createHash('sha1').update(htmlContent).digest('hex');
    files[htmlFilePath] = htmlSha1;
    fileContents[htmlSha1] = { filePath: htmlFilePath, content: htmlContent };

    // No-preview version
    const pageData = pages.find(p => p.zone === zone);
    if (pageData) {
      const zoneOverrideUrl = (zone === 'satsang-sabha') ? `https://screvents.com/${zone}` : null;
      const npHtml = isMandirStyle
        ? buildMandirPage(eventInfoMap[zone], zone, flyerPath, pageData.embedUrl, pageData.formUrl, true, zoneOverrideUrl)
        : buildHtmlPage(eventInfoMap[zone], zone, flyerPath, pageData.embedUrl, pageData.formUrl, true);
      const npFilePath = `/np${basePath}/index.html`;
      const npContent  = Buffer.from(npHtml);
      const npSha1     = crypto.createHash('sha1').update(npContent).digest('hex');
      files[npFilePath] = npSha1;
      fileContents[npSha1] = { filePath: npFilePath, content: npContent };
    }

    // OG image
    const zoneDir    = path.dirname(flyerPath);
    const previewPath = ['preview.png', 'preview.jpg', 'preview.jpeg']
      .map(f => path.join(zoneDir, f))
      .find(f => fs.existsSync(f)) || flyerPath;
    console.log(`🖼️  OG source: ${path.basename(previewPath)}`);
    const ogFilePath = `${basePath}/og.jpg`;
    const ogContent  = await buildOgImage(previewPath, eventInfoMap[zone]?.invitationYPercent);
    const ogSha1     = crypto.createHash('sha1').update(ogContent).digest('hex');
    files[ogFilePath] = ogSha1;
    fileContents[ogSha1] = { filePath: ogFilePath, content: ogContent };
    console.log(`🖼️  OG image: ${Math.round(ogContent.length / 1024)}KB`);

    // Flyer image
    const imgFilePath = `${basePath}/flyer.jpg`;
    const imgContent  = await sharp(flyerPath)
      .resize({ width: 1080, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    console.log(`🗜️ Compressed flyer: ${Math.round(imgContent.length / 1024)}KB`);
    const imgSha1 = crypto.createHash('sha1').update(imgContent).digest('hex');
    files[imgFilePath] = imgSha1;
    fileContents[imgSha1] = { filePath: imgFilePath, content: imgContent };
  }

  // Write all files to dist/ for Netlify CI build
  const repoRoot = path.join(__dirname, '..');
  const distDir  = path.join(repoRoot, 'dist');

  fs.mkdirSync(distDir, { recursive: true });

  // Only write files that changed (compare SHA1 of existing file)
  let writtenCount = 0;
  let skippedCount = 0;
  for (const [filePath, sha1] of Object.entries(files)) {
    const { content } = fileContents[sha1];
    const fullPath = path.join(distDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // Skip if file already exists with same content
    if (fs.existsSync(fullPath)) {
      const existingHash = crypto.createHash('sha1').update(fs.readFileSync(fullPath)).digest('hex');
      if (existingHash === sha1) {
        skippedCount++;
        continue;
      }
    }
    fs.writeFileSync(fullPath, content);
    console.log(`📄 Written: ${filePath}`);
    writtenCount++;
  }
  console.log(`📊 dist/ update: ${writtenCount} written, ${skippedCount} unchanged (skipped)`);

  // Copy images folder to dist/
  const imagesDir = path.join(repoRoot, 'images');
  if (fs.existsSync(imagesDir)) {
    const distImagesDir = path.join(distDir, 'images');
    fs.mkdirSync(distImagesDir, { recursive: true });
    for (const file of fs.readdirSync(imagesDir)) {
      fs.copyFileSync(path.join(imagesDir, file), path.join(distImagesDir, file));
      console.log(`📁 Copied images/${file} to dist/images/`);
    }
  }

  // Commit and push dist/
  const { execSync } = require('child_process');
  const run = cmd => execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
  run('git config user.email "actions@github.com"');
  run('git config user.name "GitHub Actions"');
  run('git add dist/');
  try {
    run('git commit -m "deploy: update dist"');
    const remote = `https://x-access-token:${process.env.GITHUB_PAT}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
    run(`git push "${remote}" HEAD:main`);
    console.log('✅ dist/ committed and pushed — Netlify CI deploying...');
  } catch (e) {
    console.log('ℹ️  No changes to dist/, skipping commit');
  }

  return pages.map(({ zone }) => `https://screvents.com/${zone}`);
}

async function main() {
  const flyerPathsRaw = process.env.FLYER_PATHS || process.env.FLYER_PATH || '';
  const changedFlyers = flyerPathsRaw.split(',').map(s => s.trim()).filter(Boolean);

  if (changedFlyers.length) {
    console.log(`\n🎉 Changed flyers: ${changedFlyers.join(', ')}`);
  } else {
    console.log('\n♻️ No changed flyers detected — redeploying all zones...');
  }

  // Init Supabase client
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const REPO_ROOT_PATH = path.join(__dirname, '..');
  const zones = ['satsang-sabha', 'mountain-top', 'scranton', 'moosic', 'bloomsburg', ...MANDIR_SLOTS];
  const allFlyers = [];

  // Track which zones have NO flyer — their DB name should be cleared
  const zonesWithFlyer = new Set();

  for (const zone of zones) {
    const zoneDir = path.join(REPO_ROOT_PATH, 'flyers', zone);
    if (!fs.existsSync(zoneDir)) continue;
    const files = fs.readdirSync(zoneDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
    if (files.length > 0) {
      zonesWithFlyer.add(zone);
      // Only use the first flyer file per zone — prevents duplicate cards
      const file = files[0];
      allFlyers.push({ zone, flyerRelPath: `flyers/${zone}/${file}`, flyerPath: path.join(zoneDir, file) });
    }
  }

  // Clear DB name for any zone whose flyer has been removed
  // This ensures the next upload gets a fresh OCR-based name rather than stale data
  const zonesWithoutFlyer = zones.filter(z => !zonesWithFlyer.has(z));
  if (zonesWithoutFlyer.length) {
    console.log(`\n🗑️  Clearing event names for zones with no flyer: ${zonesWithoutFlyer.join(', ')}`);
    const { error: clearErr } = await supabase
      .from('zone_events')
      .update({ event_name: '', updated_at: new Date().toISOString() })
      .in('zone', zonesWithoutFlyer);
    if (clearErr) {
      console.warn(`⚠️  Could not clear zone_events for empty zones: ${clearErr.message}`);
    } else {
      console.log(`✅ Cleared DB names for: ${zonesWithoutFlyer.join(', ')}`);
    }
  }

  if (!allFlyers.length) {
    console.log('ℹ️ No flyers found in any zone folder.');
    process.exit(0);
  }

  console.log(`📦 Deploying all ${allFlyers.length} flyer(s) across all zones...\n`);

  const pages        = [];
  const eventInfoMap = {};
  const deadlines    = {};

  const forceAll     = process.env.FORCE_ALL === 'true';
  const zoneOverride = process.env.ZONE_OVERRIDE?.trim() || '';

  // Load deadlines.json cache for skipping unchanged zones
  const deadlinesPath = path.join(REPO_ROOT, 'deadlines.json');
  let cachedDeadlines = {};
  if (fs.existsSync(deadlinesPath)) {
    try { cachedDeadlines = JSON.parse(fs.readFileSync(deadlinesPath, 'utf8')); } catch(e) {}
  }

  for (const { zone, flyerRelPath, flyerPath } of allFlyers) {
    const isChanged = changedFlyers.includes(flyerRelPath);
    const hasCached = !!cachedDeadlines[zone]?.deadline !== undefined && !!cachedDeadlines[zone]?.date;
    const skipOcr   = !forceAll && !isChanged && hasCached && zone !== zoneOverride;

    console.log(`\n❓ Zone: ${zone} — ${isChanged ? '🆕 NEW' : skipOcr ? '⏭️ skipping OCR (cached)' : '♻️ existing'}`);

    let eventInfo;
    if (skipOcr) {
      // Reuse cached data — no OCR needed
      const cached = cachedDeadlines[zone];
      eventInfo = {
        eventName:          cached.eventName || '',
        date:               cached.date || '',
        time:               cached.time || '',
        location:           '',
        rsvpDeadline:       cached.deadline || '',
        invitationYPercent: 0.55,
      };
      console.log(`  ✅ Using cached data for ${zone}: "${cached.eventName}"`);
    } else {
      // 1. OCR extracts raw info from flyer
      eventInfo = await extractEventInfo(flyerPath);
    }

    // 2. Resolve canonical event name from Supabase
    //    If a name has been set by admin, use it. Otherwise save OCR name as initial value.
    eventInfo.eventName = await resolveEventName(supabase, zone, eventInfo.eventName);

    eventInfoMap[zone] = eventInfo;

    const isMandirSlot   = MANDIR_SLOTS.includes(zone);
    const isSatsangSabha = zone === 'satsang-sabha';

    let html, embedUrl = '', formUrl = '';
    if (isMandirSlot) {
      html = buildMandirPage(eventInfo, zone, flyerPath, embedUrl, formUrl);
    } else if (isSatsangSabha) {
      const forms = getGoogleForm(zone);
      embedUrl = forms.embedUrl;
      formUrl  = forms.formUrl;
      html = buildMandirPage(eventInfo, zone, flyerPath, embedUrl, formUrl, false, `https://screvents.com/${zone}`);
    } else {
      const forms = getGoogleForm(zone);
      embedUrl = forms.embedUrl;
      formUrl  = forms.formUrl;
      html = buildHtmlPage(eventInfo, zone, flyerPath, embedUrl, formUrl);
    }
    pages.push({ zone, html, flyerPath, embedUrl, formUrl });
    console.log(`✅ Page ready for ${zone}`);

    let eventDateISO = '';
    if (eventInfo.date) {
      try {
        const parsed = new Date(eventInfo.date + ', 2026');
        if (!isNaN(parsed)) eventDateISO = parsed.toISOString().split('T')[0];
      } catch(e) {}
    }
    deadlines[zone] = {
      deadline:  eventInfo.rsvpDeadline || '',
      eventName: eventInfo.eventName || (isMandirSlot ? 'Mandir Event' : 'Para Satsang Sabha'),
      date:      eventInfo.date || '',
      eventDate: eventDateISO,
      time:      eventInfo.time || ''
    };
  }

  // Save deadlines.json
  let existing = {};
  if (fs.existsSync(deadlinesPath)) {
    try { existing = JSON.parse(fs.readFileSync(deadlinesPath, 'utf8')); } catch(e) {}
  }
  const merged = { ...existing, ...deadlines };
  fs.writeFileSync(deadlinesPath, JSON.stringify(merged, null, 2));
  console.log('📅 deadlines.json updated:', merged);

  const deployedUrls = await deployAllToNetlify(pages, merged, eventInfoMap);

  console.log('\n✨ All done!');
  for (const url of deployedUrls) console.log(`🔗 ${url}`);
  console.log('📲 Share these links on WhatsApp/Telegram!');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
