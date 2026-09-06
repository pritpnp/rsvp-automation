#!/bin/bash
# Sync public/ into dist/ (dist is the Netlify publish dir — netlify.toml).
#
# set -e matters here: the /flyer-builder/* rule in netlify.toml is a status-200
# REWRITE, not a redirect, so a page missing from dist/ is served the builder's
# index.html instead of a 404. Without -e a failed cp printed to stderr, the
# script still exited 0, and the deploy went green with a missing page that
# looked like a working one. Fail loudly instead.
set -euo pipefail

mkdir -p dist/flyer-builder

cp -r public/flyer-builder/templates/ dist/flyer-builder/templates/
cp -r public/flyer-builder/preview-templates/ dist/flyer-builder/preview-templates/
cp -r public/flyer-builder/fonts/ dist/flyer-builder/fonts/
cp -r public/flyer-builder/base/ dist/flyer-builder/base/
cp -r public/flyer-builder/swami-photos/ dist/flyer-builder/swami-photos/
cp public/flyer-builder/swami-photos.json dist/flyer-builder/swami-photos.json
cp public/flyer-builder/flyer-layout.json dist/flyer-builder/flyer-layout.json 2>/dev/null || true
cp public/flyer-builder/flyer-render.js dist/flyer-builder/flyer-render.js

# Deployed pages. vetter.html / og-vetter.html are deliberately NOT copied —
# they are unauthenticated local tuning tools ("Local tool — not deployed").
cp public/flyer-builder/index.html dist/flyer-builder/index.html
cp public/flyer-builder/photo-positioner.html dist/flyer-builder/photo-positioner.html

echo "✅ dist synced"
