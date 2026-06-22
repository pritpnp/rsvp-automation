/* ============================================================================
 * flyer-render.js — shared flyer compositor for the SCREvents flyer builder.
 *
 * Single source of truth used by BOTH:
 *   - index.html  (the builder: live preview + full-res capture for review)
 *   - vetter.html (the photo-vetting tool: tune placement/color/fade/footer)
 *
 * The flyer is composited on a 2D <canvas> at any target width (the LAYOUT is
 * authored at the native canvas width and everything scales from it), so the
 * live preview and the final full-resolution export are pixel-identical.
 *
 * Layer order (bottom -> top):
 *   1. recolored watercolor background (tinted to the per-photo bgColor)
 *   2. Mahant Swami Maharaj photo, placed + bottom-feathered into the background
 *   3. header (baps-logo two-sadhu illustration), top-centre
 *   4. footer (BAPS branding, black or white variant), bottom
 *   5. text (Invitation block, title, date/time, RSVP, location, host, address,
 *      mahaprasad)
 * ==========================================================================*/
(function (global) {
  'use strict';

  // Native authoring resolution. Every LAYOUT number is relative to this
  // (positions as 0..1 fractions, font sizes as px at this width).
  const LAYOUT = {
    canvas: { width: 1125, height: 2436 },

    // Header: baps-logo illustration, centred near the top.
    // topPct kept LOW (well below the original 0.018) so the header clears the
    // iPhone Dynamic Island / notch when the flyer is viewed full-screen
    // (e.g. Instagram stories). Tunable live via the vetter / builder "Hdr Y"
    // slider; this is the locked default — keep it low.
    // shadow: soft drop-shadow under the header emblem. size = blur as a
    // fraction of canvas width; opacity 0..1; offset auto-derives from size.
    // Fully tunable via the vetter / builder "Hdr shadow" controls.
    header: { widthPct: 0.205, topPct: 0.054, shadow: { color: '#000000', size: 0.012, opacity: 0.9 } },

    // Footer: brand bar anchored to the bottom.
    footer: { widthPct: 0.50, bottomPct: 0.012 },

    // Fixed region the swami photo cover-fills — matched to the live template's
    // photo area so per-photo crops are "universal". Manifest: { focusX, focusY, zoom }.
    photoBox: { topPct: 0.085, bottomPct: 0.575, offsetY: 0 },
    photo: { focusX: 0.5, focusY: 0.5, zoom: 1.0 },
    fade: { topPct: 0.04, startPct: 0.86, endPct: 1.0 },

    // Brown + grey used throughout (match the existing baked design).
    colors: { brown: '#85381c', grey: '#4c4c4b', title: '#8a3a18' },

    // Text effect — soft bevel/emboss (light highlight up-left + dark shadow
    // down-right peeking around each glyph, crisp fill on top). Subtle, like the
    // PSD's Bevel & Emboss. offset/blur are px at 1125 authoring width; 0..1 alphas.
    // Per-element embossHl / embossSh can override the opacities; emboss:false off.
    emboss: { offset: 1.5, blur: 3, highlight: '#ffffff', shadow: '#08271a', hlOpacity: 0.35, shOpacity: 0.30 },

    // Text — matched to the live flyer. datetime/rsvp/host/address/mahaprasad
    // yPcts are the LIVE builder's exact calibrated values; the rest are sized
    // to the live's baked title block.
    // Fonts/weights/tracking match the source PSD: only TWO faces are used —
    // AddingtonCF (= AddingtonCF-Medium, rendered at natural weight, NOT bold)
    // for the serif blocks, and GothamRegular (= Gotham-Book) for the sans ones.
    // tracking is Photoshop's value in 1/1000 em (negative = tighter).
    // Sizes + yPcts are the EXACT geometry from the source PSD (Bloomsburg
    // Parasabha Template.psd), transform-corrected: effective size = base FontSize
    // × layer scale; yPct = layer bbox top / 2436.
    text: [
      // tint  → follows the per-photo PRIMARY text color (textColor)
      // tint2 → follows the per-photo SECONDARY text color (textColor2)
      { key: 'invitation', yPct: 0.5575, font: 'AddingtonCF',       sizePx: 79,  weight: 400, color: '#85381c', align: 'center', maxWidthPct: 0.9,  lineHeight: 1.1,   tracking: -25, tint: true },
      { key: 'zoneLine',   yPct: 0.5907, font: 'AddingtonCF',       sizePx: 50,  weight: 400, color: '#85381c', align: 'center', maxWidthPct: 0.94, lineHeight: 1.1,   tracking: -40, tint: true },
      { key: 'cordially',  yPct: 0.6162, font: 'GothamRegular',     sizePx: 33,  weight: 400, color: '#4b4b4a', align: 'center', maxWidthPct: 0.92, lineHeight: 1.2,   tracking: -40, tint2: true },
      { key: 'title',      yPct: 0.6367, font: 'AddingtonCF',       sizePx: 167, weight: 400, color: '#85381c', align: 'center', maxWidthPct: 0.96, lineHeight: 0.814, wrap: true, tracking: -25, tint: true },
      // santos ("In the presence of Pujya Swamis") — Satsang only, gated by the
      // toggle in buildFields (empty string = skipped). Fixed purple.
      { key: 'santos',     yPct: 0.7300, font: 'GothamRegular',     sizePx: 42,  weight: 400, color: '#4a4882', align: 'center', maxWidthPct: 0.92, lineHeight: 1.3,   tracking: -40 },
      { key: 'datetime',   yPct: 0.7545, font: 'AddingtonCF',       sizePx: 86,  weight: 400, color: '#85381c', align: 'center', maxWidthPct: 0.96, lineHeight: 1.4,   tracking: -25, tint: true },
      { key: 'rsvp',       yPct: 0.7964, font: 'AppleSDGothicNeoH', sizePx: 52,  weight: 400, color: '#4c4c4b', align: 'center', maxWidthPct: 0.9,  lineHeight: 1.4,   tracking: -50, tint2: true },
      { key: 'locationLabel', yPct: 0.8202, font: 'AddingtonCF',    sizePx: 33, weight: 400, color: '#4b4b4a', align: 'center', maxWidthPct: 0.9, lineHeight: 1.3,   tracking: -25, tint2: true },
      { key: 'host',       yPct: 0.8374, font: 'GothamRegular',     sizePx: 52,  weight: 400, color: '#4c4c4b', align: 'center', maxWidthPct: 0.9,  lineHeight: 1.4,   tracking: -50, tint2: true },
      { key: 'address',    yPct: 0.8654, font: 'AddingtonCF',       sizePx: 63,  weight: 400, color: '#85381c', align: 'center', maxWidthPct: 0.9,  lineHeight: 1.06,  tracking: -25, tint: true },
      { key: 'mahaprasad', yPct: 0.9216, font: 'AddingtonCF',       sizePx: 33,  weight: 400, color: '#4b4b4a', align: 'center', maxWidthPct: 0.9,  lineHeight: 1.4,   tracking: -25, tint2: true },
    ],

    // Satsang Sabha zone overrides (from the live flyer-positions.json — px ×3.125).
    // Satsang flyers have no host/RSVP; datetime + address sit lower than parasabha.
    // Satsang Sabha overrides — matched to the staggered reference flyer. No
    // host / RSVP (buildFields blanks them). Title is STAGGERED via lineCxPct
    // ("Satsang" left, "Sabha" right). santos shows only when the toggle is on.
    satsang: {
      invitation:    { yPct: 0.5644, sizePx: 79 },
      cordially:     { yPct: 0.5998, sizePx: 33 },
      title:         { yPct: 0.606, sizePx: 209, lineHeight: 0.92, lineCxPct: [0.06, 0.94], lineAlign: ['left', 'right'] },
      santos:        { yPct: 0.771, sizePx: 42 },
      datetime:      { yPct: 0.789, sizePx: 102 },
      locationLabel: { yPct: 0.841, sizePx: 33 },
      address:       { yPct: 0.862, sizePx: 63, lineHeight: 1.06 },
      mahaprasad:    { yPct: 0.921, sizePx: 33 },
    },

    // ── Landscape social / OG card (1200×630) — same design language as the
    // flyer, rearranged wide: Swami photo panel on the LEFT (feathered into the
    // watercolor), text column on the RIGHT (centred at cxPct). Authored at
    // 1200px width; sizes are px at that width, positions are fractions.
    og: {
      canvas: { width: 1200, height: 630 },
      photoPanel: { leftPct: 0, widthPct: 0.44, topPct: 0, bottomPct: 1.0 },
      photoFeatherPct: 0.22, // right-edge fade of the photo panel into the bg
      header: { widthPct: 0.072, cxPct: 0.72, topPct: 0.035 },
      text: [
        { key: 'invitation',    cxPct: 0.72, yPct: 0.115, font: 'AddingtonCF',   sizePx: 30, weight: 400, color: '#85381c', maxWidthPct: 0.50, lineHeight: 1.1, tracking: -25, tint: true },
        { key: 'zoneLine',      cxPct: 0.72, yPct: 0.180, font: 'AddingtonCF',   sizePx: 23, weight: 400, color: '#85381c', maxWidthPct: 0.54, lineHeight: 1.1, tracking: -40, tint: true },
        { key: 'cordially',     cxPct: 0.72, yPct: 0.242, font: 'GothamRegular',     sizePx: 15, weight: 400, color: '#4b4b4a', maxWidthPct: 0.50, lineHeight: 1.2, tracking: -40, tint2: true },
        { key: 'title',         cxPct: 0.72, yPct: 0.300, font: 'AddingtonCF',       sizePx: 66, weight: 400, color: '#85381c', maxWidthPct: 0.54, lineHeight: 0.85, wrap: true, tracking: -25, tint: true },
        { key: 'santos',        cxPct: 0.72, yPct: 0.540, font: 'GothamRegular',     sizePx: 18, weight: 400, color: '#4a4882', maxWidthPct: 0.54, lineHeight: 1.3, tracking: -40 },
        { key: 'datetime',      cxPct: 0.72, yPct: 0.585, font: 'AddingtonCF',       sizePx: 36, weight: 400, color: '#85381c', maxWidthPct: 0.54, lineHeight: 1.3, tracking: -25, tint: true },
        { key: 'rsvp',          cxPct: 0.72, yPct: 0.655, font: 'AppleSDGothicNeoH', sizePx: 18, weight: 400, color: '#4c4c4b', maxWidthPct: 0.50, lineHeight: 1.3, tracking: -50, tint2: true },
        { key: 'locationLabel', cxPct: 0.72, yPct: 0.700, font: 'AddingtonCF',       sizePx: 16, weight: 400, color: '#4b4b4a', maxWidthPct: 0.50, lineHeight: 1.3, tracking: -25, tint2: true },
        { key: 'host',          cxPct: 0.72, yPct: 0.735, font: 'GothamRegular',     sizePx: 22, weight: 400, color: '#4c4c4b', maxWidthPct: 0.50, lineHeight: 1.3, tracking: -50, tint2: true },
        { key: 'address',       cxPct: 0.72, yPct: 0.778, font: 'AddingtonCF',       sizePx: 20, weight: 400, color: '#85381c', maxWidthPct: 0.50, lineHeight: 1.12, tracking: -25, tint: true },
        { key: 'mahaprasad',    cxPct: 0.72, yPct: 0.880, font: 'AddingtonCF',       sizePx: 16, weight: 400, color: '#4b4b4a', maxWidthPct: 0.50, lineHeight: 1.3, tracking: -25, tint2: true },
      ],
      satsang: {
        title:         { yPct: 0.228, sizePx: 117 },
        santos:        { yPct: 0.560 },
        datetime:      { yPct: 0.600, sizePx: 49 },
        locationLabel: { yPct: 0.702, sizePx: 24 },
        address:       { yPct: 0.754, sizePx: 33, lineHeight: 1.12 },
        mahaprasad:    { yPct: 0.880 },
      },
    },
  };

  // ── helpers ────────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    const h = (hex || '#ffffff').replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return { r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16) };
  }

  /**
   * Recolor the watercolor to an arbitrary target hue while preserving its
   * paper texture and the floral accents. We draw the watercolor, then paint
   * the target color over it with the 'color' blend mode, which keeps the
   * backdrop's LUMINANCE (the washes / texture / florals) and adopts the
   * target's HUE + SATURATION. So the texture stays fully visible and pink ->
   * green -> any picked color works. Returns an offscreen canvas at w x h.
   */
  function recolorWatercolor(srcImg, targetHex, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcImg, 0, 0, w, h);
    ctx.globalCompositeOperation = 'color';
    ctx.fillStyle = targetHex || '#F4C9D6';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    return c;
  }

  /**
   * Draw the photo into its box (centred at xPct, top at topPct, scaled to
   * widthPct of the canvas, aspect preserved), then feather its bottom band
   * (fade.startPct..endPct of the photo's own height) to transparent so it
   * melts into the recolored background.
   */
  function drawPhotoInBox(ctx, photoImg, box, photoCfg, fade, W, H) {
    photoCfg = photoCfg || {};
    // offsetY (GLOBAL — lives on photoBox, like the header position) shifts the
    // ENTIRE photo block (image + its top/bottom fades) up/down as one unit,
    // independent of focusY (crop pan) and the fade sliders. Neg = up, pos = down.
    const bTop = ((box.topPct ?? 0.075) + (box.offsetY || 0)) * H;
    const bh = ((box.bottomPct ?? 0.595) - (box.topPct ?? 0.075)) * H;
    if (bh <= 0) return;

    // Render into a box-sized layer so the fade mask doesn't punch the bg.
    const layer = document.createElement('canvas');
    layer.width = Math.max(1, Math.round(W));
    layer.height = Math.max(1, Math.round(bh));
    const lctx = layer.getContext('2d');

    // Cover-fit (fill the box, crop overflow) with optional zoom + vertical focus.
    // zoom 1 = cover-fit (fills the box); >1 zooms in; <1 zooms out (photo
    // floats on the background). focusX/focusY (0..1) pan the visible window.
    const zoom = photoCfg.zoom ?? 1.0;
    const focusX = photoCfg.focusX ?? 0.5;
    const focusY = photoCfg.focusY ?? 0.5;
    const scale = Math.max(layer.width / photoImg.naturalWidth, layer.height / photoImg.naturalHeight) * zoom;
    const dw = photoImg.naturalWidth * scale;
    const dh = photoImg.naturalHeight * scale;
    lctx.drawImage(photoImg, (layer.width - dw) * focusX, (layer.height - dh) * focusY, dw, dh);

    lctx.globalCompositeOperation = 'destination-out';

    // Bottom feather: erase from startPct (opaque) to endPct (gone).
    const gy0 = (fade.startPct ?? 0.72) * layer.height;
    const gy1 = (fade.endPct ?? 1.0) * layer.height;
    if (gy1 > gy0) {
      const grad = lctx.createLinearGradient(0, gy0, 0, gy1);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,1)');
      lctx.fillStyle = grad;
      lctx.fillRect(0, gy0, layer.width, layer.height - gy0);
    }

    // Top feather: erase from the very top (gone) down to topPct (opaque) so
    // the photo melts into the background under the header instead of a hard line.
    const topPct = fade.topPct ?? 0.08;
    if (topPct > 0) {
      const ty = topPct * layer.height;
      const tgrad = lctx.createLinearGradient(0, 0, 0, ty);
      tgrad.addColorStop(0, 'rgba(0,0,0,1)');
      tgrad.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = tgrad;
      lctx.fillRect(0, 0, layer.width, ty);
    }

    lctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(layer, 0, bTop);
  }

  function drawContain(ctx, img, boxX, boxY, boxW, boxH) {
    const ar = img.naturalWidth / img.naturalHeight;
    let w = boxW, h = boxW / ar;
    if (h > boxH) { h = boxH; w = boxH * ar; }
    ctx.drawImage(img, boxX + (boxW - w) / 2, boxY + (boxH - h) / 2, w, h);
  }

  function wrapLines(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = word; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function drawTextEl(ctx, el, value, W, H, scale, textColor, textColor2) {
    if (value === undefined || value === null || value === '') return;
    // tint → per-photo PRIMARY color; tint2 → per-photo SECONDARY color; else fixed.
    const fill = (el.tint && textColor) ? textColor
               : (el.tint2 && textColor2) ? textColor2
               : el.color;
    const size = el.sizePx * scale;
    const fontStr = (el.weight >= 600 ? '700 ' : '400 ') + size + 'px "' + el.font + '"';
    const ls = (el.tracking ? (el.tracking / 1000) * size : 0) + 'px';  // PS tracking = 1/1000 em
    const maxW = (el.maxWidthPct || 0.9) * W;
    const cx = (el.cxPct != null ? el.cxPct : 0.5) * W;  // center column (OG uses an off-centre text column)
    // lineCxPct: optional per-line horizontal centre (used to STAGGER a title,
    // e.g. Satsang upper-left + Sabha lower-right). Falls back to cx.
    const cxFor = (i) => ((el.lineCxPct && el.lineCxPct[i] != null) ? el.lineCxPct[i] * W : cx);
    // lineAlign: optional per-line text-align ('left'|'right'|'center'). With cxFor
    // as the anchor: left → anchor is the left edge, right → the right edge. Used to
    // stagger the Satsang title (Satsang left-aligned, Sabha right-aligned).
    const alignFor = (i) => ((el.lineAlign && el.lineAlign[i]) ? el.lineAlign[i] : (el.align || 'center'));
    const yTop = el.yPct * H;                            // yPct is the TOP of the first line
    const lineH = size * (el.lineHeight || 1.3);

    ctx.font = fontStr; ctx.letterSpacing = ls; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    let lines = String(value).split('\n');
    if (el.wrap) lines = lines.flatMap((ln) => wrapLines(ctx, ln, maxW));

    // Bevel/emboss = two soft edge-halos peeking out around each glyph — a light
    // highlight (up-left) + a dark shadow (down-right) — with a CRISP fill drawn
    // on TOP so the letter colour itself stays clean (no muddying). Subtle.
    const emb = (el.emboss === false) ? null : LAYOUT.emboss;
    const hlA = emb ? (el.embossHl != null ? el.embossHl : emb.hlOpacity) : 0;
    const shA = emb ? (el.embossSh != null ? el.embossSh : emb.shOpacity) : 0;
    const d = emb ? emb.offset * scale : 0;
    const blur = emb ? emb.blur * scale : 0;
    const hlC = emb ? hexToRgb(emb.highlight) : null;
    const shC = emb ? hexToRgb(emb.shadow) : null;
    const rgba = (c, a) => 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';

    lines.forEach((line, i) => {
      const x = cxFor(i), y = yTop + i * lineH;
      ctx.textAlign = alignFor(i);
      if (emb) {
        ctx.save();
        ctx.fillStyle = fill;
        if (shA > 0) {  // dark halo, down-right
          ctx.shadowColor = rgba(shC, shA); ctx.shadowBlur = blur; ctx.shadowOffsetX = d; ctx.shadowOffsetY = d;
          ctx.fillText(line, x, y);
        }
        if (hlA > 0) {  // light halo, up-left
          ctx.shadowColor = rgba(hlC, hlA); ctx.shadowBlur = blur; ctx.shadowOffsetX = -d; ctx.shadowOffsetY = -d;
          ctx.fillText(line, x, y);
        }
        ctx.restore();
      }
      ctx.fillStyle = fill;
      ctx.fillText(line, x, y);  // crisp letter on top
    });
    ctx.letterSpacing = '0px';
  }

  /**
   * Composite a full flyer onto ctx at width W (height follows the LAYOUT
   * aspect). All images must be already loaded (HTMLImageElement).
   *
   * opts = {
   *   watercolorImg, bgColor,
   *   photoImg, placement:{xPct,topPct,widthPct}, fade:{startPct,endPct},
   *   headerImg, footerImg,
   *   fields: { invitation, zoneLine, cordially, title, datetime, rsvp,
   *             locationLabel, host, address, mahaprasad }
   * }
   */
  function compositeFlyer(ctx, W, opts) {
    const aspect = LAYOUT.canvas.height / LAYOUT.canvas.width;
    const H = Math.round(W * aspect);
    const scale = W / LAYOUT.canvas.width;
    ctx.canvas.width = W; ctx.canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    // 1. background (recolored watercolor)
    if (opts.watercolorImg) {
      const bg = recolorWatercolor(opts.watercolorImg, opts.bgColor || '#F4C9D6', W, H);
      ctx.drawImage(bg, 0, 0);
    }

    // 2. photo (cover-fits the fixed box) + top/bottom feather
    if (opts.photoImg && opts.photoImg.naturalWidth) {
      drawPhotoInBox(ctx, opts.photoImg, LAYOUT.photoBox, opts.photo || LAYOUT.photo, opts.fade || LAYOUT.fade, W, H);
    }

    // 3. header (top-centre) + optional opacity + soft drop-shadow
    if (opts.headerImg && opts.headerImg.naturalWidth) {
      const hw = LAYOUT.header.widthPct * W;
      const hh = hw * (opts.headerImg.naturalHeight / opts.headerImg.naturalWidth);
      const hx = (W - hw) / 2, hy = LAYOUT.header.topPct * H;
      const sh = LAYOUT.header.shadow;
      ctx.save();
      if (sh && sh.opacity > 0 && sh.size > 0) {
        const c = hexToRgb(sh.color || '#000000');
        ctx.shadowColor = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + sh.opacity + ')';
        ctx.shadowBlur = sh.size * W;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = sh.size * 0.35 * W; // gentle downward drop, scales with blur
      }
      drawContain(ctx, opts.headerImg, hx, hy, hw, hh);
      ctx.restore();
    }

    // 4. footer (bottom)
    if (opts.footerImg && opts.footerImg.naturalWidth) {
      const fw = LAYOUT.footer.widthPct * W;
      const fh = fw * (opts.footerImg.naturalHeight / opts.footerImg.naturalWidth);
      drawContain(ctx, opts.footerImg, (W - fw) / 2, H - fh - LAYOUT.footer.bottomPct * H, fw, fh);
    }

    // 5. text
    const fields = opts.fields || {};
    const ov = opts.variant === 'satsang' ? LAYOUT.satsang : null;
    for (const baseEl of LAYOUT.text) {
      const el = (ov && ov[baseEl.key]) ? { ...baseEl, ...ov[baseEl.key] } : baseEl;
      drawTextEl(ctx, el, fields[el.key], W, H, scale, opts.textColor, opts.textColor2);
    }

    return { W, H };
  }

  // Photo as a left-hand panel for the landscape OG card; cover-fit + a soft
  // right-edge feather so it melts into the recolored watercolor background.
  function drawPhotoPanelOG(ctx, photoImg, panel, featherPct, photoCfg, W, H) {
    const px = (panel.leftPct || 0) * W;
    const pw = (panel.widthPct || 0.44) * W;
    const py = (panel.topPct || 0) * H;
    const ph = ((panel.bottomPct ?? 1) - (panel.topPct || 0)) * H;
    if (pw <= 0 || ph <= 0) return;
    const layer = document.createElement('canvas');
    layer.width = Math.max(1, Math.round(pw));
    layer.height = Math.max(1, Math.round(ph));
    const lctx = layer.getContext('2d');
    photoCfg = photoCfg || {};
    const zoom = photoCfg.zoom ?? 1.0, fx = photoCfg.focusX ?? 0.5, fy = photoCfg.focusY ?? 0.5;
    const scl = Math.max(layer.width / photoImg.naturalWidth, layer.height / photoImg.naturalHeight) * zoom;
    const dw = photoImg.naturalWidth * scl, dh = photoImg.naturalHeight * scl;
    lctx.drawImage(photoImg, (layer.width - dw) * fx, (layer.height - dh) * fy, dw, dh);
    const fw = (featherPct || 0) * layer.width;
    if (fw > 0) {
      lctx.globalCompositeOperation = 'destination-out';
      const g = lctx.createLinearGradient(layer.width - fw, 0, layer.width, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
      lctx.fillStyle = g; lctx.fillRect(layer.width - fw, 0, fw, layer.height);
      lctx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(layer, px, py);
  }

  // Landscape social/OG card (1200×630) — same elements as the flyer, wide.
  function compositeOG(ctx, W, opts) {
    const L = LAYOUT.og;
    const H = Math.round(W * (L.canvas.height / L.canvas.width));
    ctx.canvas.width = W; ctx.canvas.height = H;
    const scale = W / L.canvas.width;

    // 1. recolored watercolor across the whole card
    if (opts.watercolorImg && opts.watercolorImg.naturalWidth) {
      ctx.drawImage(recolorWatercolor(opts.watercolorImg, opts.bgColor, W, H), 0, 0);
    } else {
      ctx.fillStyle = opts.bgColor || '#F4C9D6'; ctx.fillRect(0, 0, W, H);
    }

    // 2. photo panel (left) feathered into the bg
    if (opts.photoImg && opts.photoImg.naturalWidth) {
      drawPhotoPanelOG(ctx, opts.photoImg, L.photoPanel, L.photoFeatherPct, opts.photo || LAYOUT.photo, W, H);
    }

    // (no header emblem on the OG card — flyer only)

    // 3. text column (right)
    const fields = opts.fields || {};
    const ov = opts.variant === 'satsang' ? L.satsang : null;
    for (const baseEl of L.text) {
      const el = (ov && ov[baseEl.key]) ? { ...baseEl, ...ov[baseEl.key] } : baseEl;
      drawTextEl(ctx, el, fields[el.key], W, H, scale, opts.textColor, opts.textColor2);
    }
    return { W, H };
  }

  function loadImage(src, crossOrigin) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (crossOrigin !== false) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load ' + src));
      img.src = src;
    });
  }

  // Merge a saved layout override (from the Advanced panel's "Save layout")
  // over the built-in defaults, so tuning persists via flyer-layout.json.
  function applyLayout(o) {
    if (!o || typeof o !== 'object') return;
    if (o.photoBox) Object.assign(LAYOUT.photoBox, o.photoBox);
    if (o.fade) Object.assign(LAYOUT.fade, o.fade);
    if (o.footer) Object.assign(LAYOUT.footer, o.footer);
    if (o.header) Object.assign(LAYOUT.header, o.header);
    if (o.satsang) for (const k in o.satsang) LAYOUT.satsang[k] = Object.assign(LAYOUT.satsang[k] || {}, o.satsang[k]);
    if (Array.isArray(o.text)) for (const t of o.text) { const e = LAYOUT.text.find((x) => x.key === t.key); if (e) Object.assign(e, t); }
    if (o.og) {
      const G = o.og;
      if (G.photoPanel) Object.assign(LAYOUT.og.photoPanel, G.photoPanel);
      if (G.photoFeatherPct != null) LAYOUT.og.photoFeatherPct = G.photoFeatherPct;
      if (Array.isArray(G.text)) for (const t of G.text) { const e = LAYOUT.og.text.find((x) => x.key === t.key); if (e) Object.assign(e, t); }
      if (G.satsang) for (const k in G.satsang) LAYOUT.og.satsang[k] = Object.assign(LAYOUT.og.satsang[k] || {}, G.satsang[k]);
    }
  }
  // Snapshot the current LAYOUT for export (what the Advanced panel saves).
  function serializeLayout() {
    return { header: LAYOUT.header, footer: LAYOUT.footer, photoBox: LAYOUT.photoBox, fade: LAYOUT.fade, satsang: LAYOUT.satsang, text: LAYOUT.text, og: LAYOUT.og };
  }

  global.FlyerRender = { LAYOUT, recolorWatercolor, drawPhotoInBox, compositeFlyer, compositeOG, loadImage, hexToRgb, applyLayout, serializeLayout };
})(window);
