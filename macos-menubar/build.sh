#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Paperclip"
APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"
BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
PLIST="$APP_BUNDLE/Contents/Info.plist"

echo "Building $APP_NAME.app..."

# Compile
swiftc \
  -O \
  -sdk "$(xcrun --show-sdk-path)" \
  -target arm64-apple-macosx13.0 \
  -framework AppKit \
  -framework Foundation \
  "$SCRIPT_DIR/Sources/main.swift" \
  -o "$SCRIPT_DIR/PaperclipBin"

# Create app bundle structure
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# Move binary
mv "$SCRIPT_DIR/PaperclipBin" "$BINARY"
chmod +x "$BINARY"

# Write Info.plist
cat > "$PLIST" << 'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Paperclip</string>
    <key>CFBundleIdentifier</key>
    <string>ing.paperclip.menubar</string>
    <key>CFBundleName</key>
    <string>Paperclip</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST_EOF

echo "Built: $APP_BUNDLE"
echo ""
echo "To install in Applications:"
echo "  cp -R '$APP_BUNDLE' /Applications/"
echo ""
echo "To add to Login Items:"
echo "  System Settings > General > Login Items > Add '$APP_BUNDLE'"
echo ""
echo "Opening now..."
open "$APP_BUNDLE"
