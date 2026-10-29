#!/usr/bin/env bash
# Regenerates the README images from docs/assets/src/*.html with headless Chrome.
# The dashboard shots come from the demo server: pnpm --filter @flare-ota/server demo
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
shot() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --allow-file-access-from-files "$@" 2>/dev/null; }

if curl -sf -o /dev/null http://localhost:8799/; then
  shot --window-size=1600,1040 --blink-settings=preferredColorScheme=0 --screenshot=dashboard-dark.png http://localhost:8799/
else
  echo "demo server not running: keeping the existing dashboard shots"
fi
shot --window-size=1280,400 --screenshot=banner.png "file://$PWD/src/banner.html"
shot --window-size=1280,780 --screenshot=hero.png "file://$PWD/src/hero.html"
shot --window-size=1280,520 --screenshot=architecture-light.png "file://$PWD/src/architecture.html"
shot --window-size=1280,520 --screenshot=architecture-dark.png "file://$PWD/src/architecture.html#dark"
ls -la *.png
