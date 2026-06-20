#!/bin/bash
# Sync public/ into dist/
cp -r public/flyer-builder/templates/ dist/flyer-builder/templates/
cp -r public/flyer-builder/preview-templates/ dist/flyer-builder/preview-templates/
cp -r public/flyer-builder/fonts/ dist/flyer-builder/fonts/
cp -r public/flyer-builder/base/ dist/flyer-builder/base/
cp -r public/flyer-builder/swami-photos/ dist/flyer-builder/swami-photos/
cp public/flyer-builder/swami-photos.json dist/flyer-builder/swami-photos.json
cp public/flyer-builder/flyer-layout.json dist/flyer-builder/flyer-layout.json 2>/dev/null || true
cp public/flyer-builder/flyer-render.js dist/flyer-builder/flyer-render.js
cp public/flyer-builder/index.html dist/flyer-builder/index.html
echo "✅ dist synced"
