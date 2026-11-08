#!/usr/bin/env bash
# Builds the Release configuration for the simulator and runs it, against a dev stack. Release,
# not Debug: Debug's JS bundle is served by a Metro packager this script does not start, and
# without one the app only ever shows RN's "No script URL provided" (seen once, 2026-10-28); a
# Release build bundles the JS into the app, so it runs standalone. Run on the Mac EC2 after
# scripts/prebuild.sh. Takes a screenshot at the end (xcrun simctl io); pass `--no-boot` to reuse
# an already-booted simulator instead of picking/booting one.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh
add_local_node_to_path

DEVICE_NAME="${BOOKCLUB_SIM_DEVICE:-iPhone 17}"
SKIP_BOOT=0
SCREENSHOT="/tmp/bookclub-simulator.png"
for arg in "$@"; do
  if [ "$arg" = "--no-boot" ]; then
    SKIP_BOOT=1
  else
    SCREENSHOT="$arg"
  fi
done

[ -d ios ] || {
  echo "run-simulator: apps/mobile/ios does not exist; run scripts/prebuild.sh first" >&2
  exit 1
}

# The Xcode project/scheme name is derived by `expo prebuild` from app.config.ts's `name`
# ("Book Club" -> sanitised to some ASCII identifier); read it back rather than guess it.
WORKSPACE="$(find ios -maxdepth 1 -name '*.xcworkspace' | head -1)"
[ -n "$WORKSPACE" ] || { echo "run-simulator: no .xcworkspace under ios/; run scripts/prebuild.sh" >&2; exit 1; }
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
echo "run-simulator: workspace $WORKSPACE, scheme $SCHEME"

UDID="$(xcrun simctl list devices available | grep "$DEVICE_NAME (" | head -1 | grep -oE '[0-9A-F-]{36}' || true)"
if [ -z "$UDID" ]; then
  echo "run-simulator: no '$DEVICE_NAME' simulator found; available devices:" >&2
  xcrun simctl list devices available >&2
  exit 1
fi

if [ "$SKIP_BOOT" -eq 0 ]; then
  echo "run-simulator: booting $DEVICE_NAME ($UDID)"
  xcrun simctl boot "$UDID" 2>/dev/null || true
  # This box runs headless (no GUI session: `who` is empty, no Simulator.app shipped, only the
  # CoreSimulator CLI) — `simctl` alone boots, installs, launches and screenshots it fine, with
  # no visible window; skip `open -a Simulator`, which has no GUI session to open into here.
  xcrun simctl bootstatus "$UDID" -b
fi
# xcodebuild wants the real UDID (simctl's own "booted" shorthand is not one of its destination
# specifiers), so this resolves it above regardless of --no-boot.

# Xcode's bundle phase evaluates app.config.ts again and bakes its server into the JavaScript, so
# the server is set here too, with prebuild.sh's own default: without it, a simulator build's page
# is the production site, whatever prebuild.sh was given (it happened once, 2026-11-07).
: "${BOOKCLUB_SERVER_URL:=http://127.0.0.1:47140}"
export BOOKCLUB_SERVER_URL

wait_for_xcodebuild_gate
echo "run-simulator: building $SCHEME for the simulator, against $BOOKCLUB_SERVER_URL"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "id=$UDID" \
  -derivedDataPath build/DerivedData \
  build

APP_PATH="$(find build/DerivedData/Build/Products -maxdepth 2 -name "$SCHEME.app" -path '*iphonesimulator*' | head -1)"
[ -n "$APP_PATH" ] || { echo "run-simulator: build succeeded but $SCHEME.app was not found under build/DerivedData" >&2; exit 1; }

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Info.plist")"
echo "run-simulator: installing $APP_PATH ($BUNDLE_ID)"
xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl launch "$UDID" "$BUNDLE_ID"

sleep 5
xcrun simctl io "$UDID" screenshot "$SCREENSHOT"
echo "run-simulator: screenshot saved to $SCREENSHOT"
