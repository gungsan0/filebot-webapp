#!/bin/bash
# Build a self-contained macOS .pkg installer for FileBot WebApp.
#
# The installer drops "FileBot WebApp.app" into /Applications. The app bundles
# a universal (Intel + Apple Silicon) Node.js binary and all dependencies, so
# the target Mac needs nothing preinstalled. Launching the app starts the local
# server and opens the browser; the "서버 종료" button (or Activity Monitor)
# stops it.
#
# Output: dist/FileBotWebApp-<version>.pkg
#
# Note: the pkg is NOT notarized. On first launch Gatekeeper may block it —
# right-click the app → Open, or allow it in System Settings → Privacy & Security.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

APPNAME="FileBot WebApp"
BUNDLE_ID="com.github.gungsan0.filebotwebapp"
VERSION="$(node -p "require('./package.json').version")"

DIST="$ROOT/dist"
PAYLOAD="$DIST/payload"          # staging root mapped onto /Applications
APP="$PAYLOAD/$APPNAME.app"
RES="$APP/Contents/Resources"
MACOS="$APP/Contents/MacOS"
PKG="$DIST/FileBotWebApp-$VERSION.pkg"

echo "==> Cleaning $DIST"
rm -rf "$DIST"
mkdir -p "$MACOS" "$RES/app"

echo "==> Installing production dependencies"
npm install --omit=dev --no-audit --no-fund >/dev/null

echo "==> Copying application files"
cp -R server.js lib public presets.json package.json "$RES/app/"
cp -R node_modules "$RES/app/node_modules"

echo "==> Bundling Node.js runtime ($(node -p "process.version"))"
cp "$(command -v node)" "$RES/node"
# Apple Silicon-native: strip any Intel (x86_64) slice so the app contains no
# Intel code and won't trip macOS's "Intel app support ending" warning.
if lipo -archs "$RES/node" 2>/dev/null | grep -q x86_64; then
  echo "==> Thinning Node to arm64 (Apple Silicon native)"
  lipo "$RES/node" -thin arm64 -output "$RES/node.arm64"
  mv "$RES/node.arm64" "$RES/node"
fi
chmod +x "$RES/node"
echo "    node arch: $(lipo -archs "$RES/node")"

echo "==> Writing launcher"
cat > "$MACOS/launcher" <<'LAUNCH'
#!/bin/bash
# On every launch: stop any server already running on the port, start a fresh
# one DETACHED, then open the browser — and exit. Exiting is key: the app never
# stays "running", so macOS re-runs this launcher each time the user opens the
# app. (With the old exec-based launcher, closing the browser window left the
# server running and a relaunch just re-activated the live process without
# re-running the launcher, so no new window ever opened.)
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
export PORT="${PORT:-7420}"
URL="http://localhost:$PORT"
LOG="$HOME/Library/Logs/FileBot WebApp.log"
mkdir -p "$HOME/Library/Logs" 2>/dev/null

# Stop any server currently listening on the port (e.g. a stale instance left
# after the browser window was closed).
PIDS=$(/usr/sbin/lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  for _ in $(seq 1 25); do
    /usr/sbin/lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.2
  done
fi

# Start the server fully detached (subshell + nohup) so it survives this
# launcher exiting and is reparented to launchd.
( nohup "$DIR/node" "$DIR/app/server.js" >"$LOG" 2>&1 & )

# Open the browser once the server is accepting connections.
for _ in $(seq 1 40); do
  /usr/bin/curl -s -o /dev/null --max-time 1 "$URL" && break
  sleep 0.25
done
/usr/bin/open "$URL"
LAUNCH
chmod +x "$MACOS/launcher"

echo "==> Writing Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APPNAME</string>
  <key>CFBundleDisplayName</key><string>$APPNAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "==> Ad-hoc code signing the app bundle"
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "   (codesign skipped)"

echo "==> Building installer package"
pkgbuild \
  --root "$PAYLOAD" \
  --identifier "$BUNDLE_ID" \
  --version "$VERSION" \
  --install-location /Applications \
  "$PKG"

echo "==> Done: $PKG"
du -h "$PKG" | cut -f1 | xargs echo "    size:"
