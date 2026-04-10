#!/bin/bash
# Sync public/ into dist/
cp -r public/flyer-builder/templates/ dist/flyer-builder/templates/
cp -r public/flyer-builder/preview-templates/ dist/flyer-builder/preview-templates/
cp -r public/flyer-builder/fonts/ dist/flyer-builder/fonts/
cp public/flyer-builder/index.html dist/flyer-builder/index.html
echo "✅ dist synced"
