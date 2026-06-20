#!/usr/bin/env node
/**
 * One-time / re-runnable dev tool (not part of the deploy pipeline).
 *
 * Reads a folder of Mahant Swami Maharaj photos, copies each into
 * public/flyer-builder/swami-photos/<id>.jpg (preserving original quality —
 * JPEGs are byte-copied, PNGs are converted to JPEG via `sips`), and writes/merges
 * public/flyer-builder/swami-photos.json — the manifest the flyer builder and the
 * vetting tool both consume.
 *
 * IDs are derived from the source filename (stable, so re-runs are idempotent).
 * Existing per-photo vetting (bgColor / placement / fade / footer) is PRESERVED
 * on re-run; only brand-new photos get the defaults below.
 *
 * Usage:
 *   node tools/build-swami-photos.js "/absolute/path/to/source photos"
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.error('Usage: node tools/build-swami-photos.js "<source photos dir>"');
  console.error('Source dir not found:', SRC);
  process.exit(1);
}

const REPO = path.join(__dirname, '..');
const OUT_DIR = path.join(REPO, 'public', 'flyer-builder', 'swami-photos');
const MANIFEST = path.join(REPO, 'public', 'flyer-builder', 'swami-photos.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

// Per-photo defaults (the vetting tool overrides these). Photo is centred,
// near the top, full width; the bottom ~28% feathers into the background.
const DEFAULTS = () => ({
  bgColor: '#F4C9D6',
  textColor: '#85381c',
  photo: { focusX: 0.5, focusY: 0.5, zoom: 1.0 },
  fade: { topPct: 0.05, startPct: 0.80, endPct: 1.0 },
  footer: 'black',
});

function slugId(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// Load existing manifest so re-runs keep prior vetting.
let prior = { canvas: { width: 1125, height: 2436 }, photos: [] };
if (fs.existsSync(MANIFEST)) {
  try { prior = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) {}
}
const priorById = Object.fromEntries((prior.photos || []).map((p) => [p.id, p]));

const files = fs.readdirSync(SRC)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort();

const seen = new Set();
const photos = [];

for (const f of files) {
  let id = slugId(f);
  while (seen.has(id)) id += '-x';
  seen.add(id);

  const src = path.join(SRC, f);
  const dest = path.join(OUT_DIR, id + '.jpg');

  if (/\.png$/i.test(f)) {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', src, '--out', dest], { stdio: 'ignore' });
  } else {
    fs.copyFileSync(src, dest); // preserve original JPEG bytes (no recompression)
  }

  const entry = priorById[id] || { id, file: `swami-photos/${id}.jpg`, ...DEFAULTS() };
  entry.id = id;
  entry.file = `swami-photos/${id}.jpg`;
  photos.push(entry);
  console.log(`${priorById[id] ? 'kept ' : 'added'}  ${f}  ->  swami-photos/${id}.jpg`);
}

const manifest = { canvas: prior.canvas || { width: 1125, height: 2436 }, photos };
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.log(`\nWrote ${photos.length} photos to swami-photos/ and updated swami-photos.json`);
