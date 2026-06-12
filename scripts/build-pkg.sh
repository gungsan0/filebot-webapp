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

echo "==> Bundling Node.js runtime ($(node -p "process.version"), universal)"
cp "$(command -v node)" "$RES/node"
chmod +x "$RES/node"

echo "==> Writing launcher"
cat > "$MACOS/launcher" <<'LAUNCH'
#!/bin/bash
# Start the bundled server and open the browser. If it's already running,
# just focus the browser instead of starting a second instance.
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
export PORT="${PORT:-7420}"
URL="http://localhost:$PORT"

if /usr/bin/curl -s -o /dev/null --max-time 1 "$URL"; then
  open "$URL"
  exit 0
fi

# Open the browser once the server is accepting connections.
(
  for _ in $(seq 1 40); do
    /usr/bin/curl -s -o /dev/null --max-time 1 "$URL" && break
    sleep 0.25
  done
  open "$URL"
) &

exec "$DIR/node" "$DIR/app/server.js"
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
