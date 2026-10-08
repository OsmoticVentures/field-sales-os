#!/bin/zsh
# Build ClientOS for this Mac ("Designed for iPad" on Apple silicon) and install it
# to /Applications/ClientOS.app with a Desktop link. Re-run to update.
set -euo pipefail
ROOT="${0:A:h:h}"
DD="${TMPDIR:-/tmp}/clientos-mac-dd"
APP="$DD/Build/Products/Release-iphoneos/App.app"

xcodebuild -project "$ROOT/ios/App/App.xcodeproj" -scheme App -configuration Release \
  -destination 'platform=macOS,arch=arm64,variant=Designed for iPad' \
  -derivedDataPath "$DD" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -quiet build

# An iOS app on macOS runs from a wrapper bundle: Wrapper/<name>.app plus a WrappedBundle link.
osascript -e 'tell application "ClientOS" to quit' 2>/dev/null || true
rm -rf /Applications/ClientOS.app
mkdir -p /Applications/ClientOS.app/Wrapper
ditto "$APP" /Applications/ClientOS.app/Wrapper/ClientOS.app
ln -s Wrapper/ClientOS.app /Applications/ClientOS.app/WrappedBundle
ln -sf /Applications/ClientOS.app "$HOME/Desktop/ClientOS"
echo "Installed /Applications/ClientOS.app"
