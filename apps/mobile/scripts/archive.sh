#!/usr/bin/env bash
# Archives the Release configuration and exports a signed .ipa for TestFlight, using the App
# Store Connect API key for automatic signing (no Apple ID sign-in, no manual provisioning
# profiles). Run on the Mac EC2, after scripts/prebuild.sh with BOOKCLUB_APS_ENVIRONMENT=production
# (so the entitlement matches a real APNs environment) and BOOKCLUB_SERVER_URL pointing at the
# real server (defaults to https://books.badland.ai, app.config.ts default, if unset).
#
# A lone apostrophe in a bash comment opens an unterminated quote that swallows every line
# after it until another lone one closes it: every comment in this file avoids them on purpose.
#
# Required env (never printed; see README.md "TestFlight"):
#   ASC_KEY_ID        the API key id
#   ASC_ISSUER_ID     the API key issuer id
#   ASC_PRIVATE_KEY_PATH   path to the downloaded AuthKey_<ASC_KEY_ID>.p8
#   DEVELOPMENT_TEAM  the Apple Developer Team ID (10 characters, developer.apple.com
#                     membership page -- not the same as ASC_ISSUER_ID, which is an App Store
#                     Connect API concept). -allowProvisioningUpdates lets the ASC key manage
#                     signing automatically, but Xcode still needs to be told which team
#                     provisioning to ask for; expo prebuild sets none by default.
#
# Manual signing (the default when BOOKCLUB_SIGNING_PROFILE is set, as it is for TestFlight):
#   BOOKCLUB_SIGNING_PROFILE  the App Store provisioning profile name ("Book Club App Store"),
#                             installed under ~/Library/MobileDevice/Provisioning Profiles, with
#                             its Apple Distribution identity in the unlocked build.keychain.
#   The app target signs with exactly those (plugins/with-manual-signing.ts, applied by
#   scripts/prebuild.sh when the same variables are set); nothing asks the portal for a
#   development certificate, which on this shared Mac belongs to another project (D137 addendum).
#   Without BOOKCLUB_SIGNING_PROFILE, the automatic path below it is used, as before.
#   BOOKCLUB_SIGNING_WIDGETS_PROFILE  the widget extension's App Store profile (D189), for
#                             ai.badland.books.widgets; required once the extension is in the build.
#   BOOKCLUB_SIGNING_MESSAGES_PROFILE  the Messages extension's App Store profile (D220), for
#                             ai.badland.books.messages; required once that extension is in the build.
#
# Not this script's job: the ai.badland.books app record must already exist in App Store
# Connect (the API cannot create one; see README.md).
set -euo pipefail
# A store build's targets are app.config.ts's STORE_TARGETS (D220), never the environment: the
# runtime version its updates must match is computed from the config on other machines too (D180).
if [ -n "${BOOKCLUB_MESSAGES:-}" ]; then
  echo "archive: BOOKCLUB_MESSAGES is for simulator builds only; a store build's targets are STORE_TARGETS in app.config.ts" >&2
  exit 1
fi

# Over SSH, with nobody logged in at the console, codesign fails with errSecInternalComponent
# ("unable to build chain to self-signed root") however the keychain is set up: an SSH session is
# its own security session, apart from the user one the keychain and trust services answer in.
# Running the whole script in the user session (launchctl asuser) is what lets it sign; the
# build.keychain is unlocked there too. Needs passwordless sudo, as the Mac EC2 has.
if [ -n "${SSH_CONNECTION:-}" ] && [ -z "${BOOKCLUB_IN_USER_SESSION:-}" ]; then
  KEYCHAIN_PW="$(cat "$HOME/bookclub/.keychain-pw")"
  # Only the variables this script reads cross over, each as its own argument (values may hold spaces).
  pass=()
  # The app config is evaluated again during the archive (the embedded config, and the runtime
  # version D180 hashes), so whatever prebuild.sh was given crosses over too.
  for name in ASC_KEY_ID ASC_ISSUER_ID ASC_PRIVATE_KEY_PATH DEVELOPMENT_TEAM BOOKCLUB_SIGNING_PROFILE BOOKCLUB_SIGNING_TEAM BOOKCLUB_APS_ENVIRONMENT BOOKCLUB_SERVER_URL BOOKCLUB_UPDATE_CHANNEL EAS_PROJECT_ID PATH HOME BOOKCLUB_SIGNING_WIDGETS_PROFILE BOOKCLUB_SIGNING_MESSAGES_PROFILE; do
    [ -n "${!name:-}" ] && pass+=("$name=${!name}")
  done
  # The keychain password goes in on stdin, never as an argument any user of the box could read in ps.
  exec sudo -n launchctl asuser "$(id -u)" sudo -n -u "$(id -un)" env "${pass[@]}" BOOKCLUB_IN_USER_SESSION=1 \
    bash -c 'read -r pw && security unlock-keychain -p "$pw" build.keychain && unset pw && exec bash "$@" </dev/null' _ "$0" "$@" <<<"$KEYCHAIN_PW"
fi

cd "$(dirname "$0")/.."
source scripts/lib.sh
add_local_node_to_path

: "${ASC_KEY_ID:?set ASC_KEY_ID (apps/mobile/README.md, TestFlight)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"
: "${ASC_PRIVATE_KEY_PATH:?set ASC_PRIVATE_KEY_PATH to the .p8 file}"
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to the Apple Developer Team ID (see this script header)}"
[ -f "$ASC_PRIVATE_KEY_PATH" ] || { echo "archive: $ASC_PRIVATE_KEY_PATH does not exist" >&2; exit 1; }

[ -d ios ] || { echo "archive: apps/mobile/ios does not exist; run scripts/prebuild.sh first" >&2; exit 1; }
WORKSPACE="$(find ios -maxdepth 1 -name '*.xcworkspace' | head -1)"
[ -n "$WORKSPACE" ] || { echo "archive: no .xcworkspace under ios/" >&2; exit 1; }
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"

# The APNs environment comes from what prebuild.sh generated, not from this shell: Xcode evaluates
# app.config.ts again during the archive to compute the runtime version (D180), and the
# expo-notifications mode is part of it. An archive whose shell lacked the variable would hash as
# a development build, and no production update would ever reach it. An App Store archive needs
# the production entitlement anyway, so anything else stops here.
ENTITLEMENTS="$(find ios -maxdepth 2 -name '*.entitlements' | head -1)"
APS="$( [ -n "$ENTITLEMENTS" ] && /usr/libexec/PlistBuddy -c 'Print :aps-environment' "$ENTITLEMENTS" 2>/dev/null || true)"
if [ "$APS" != production ]; then
  echo "archive: ios/ was generated with aps-environment \"${APS:-none}\"; rerun scripts/prebuild.sh with BOOKCLUB_APS_ENVIRONMENT=production" >&2
  exit 1
fi
export BOOKCLUB_APS_ENVIRONMENT=production

BUILD_DIR="build/archive"
ARCHIVE_PATH="$BUILD_DIR/$SCHEME.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
mkdir -p "$BUILD_DIR"

PROFILE="${BOOKCLUB_SIGNING_PROFILE:-}"
if [ -n "$PROFILE" ]; then
  grep -q "PROVISIONING_PROFILE_SPECIFIER = \"$PROFILE\"" ios/*.xcodeproj/project.pbxproj ||
    { echo "archive: the Xcode project does not sign with \"$PROFILE\"; rerun scripts/prebuild.sh with BOOKCLUB_SIGNING_TEAM and BOOKCLUB_SIGNING_PROFILE set" >&2; exit 1; }
fi

# build.keychain (scripts/setup-mac-ec2.sh) joins the user search list only while this runs, so that
# Xcode finds its identity; the list is put back exactly as it was, however the archive ends. This
# Mac is shared: the default keychain and the search list are never left changed (D137 addendum).
KC="$HOME/Library/Keychains/build.keychain-db"
if [ -f "$KC" ]; then
  SEARCH_BEFORE=()
  while IFS= read -r k; do k="${k#"${k%%[![:space:]]*}"}"; k="${k%\"}"; k="${k#\"}"; [ -n "$k" ] && SEARCH_BEFORE+=("$k"); done < <(security list-keychains -d user)
  restore_search_list() { security list-keychains -d user -s ${SEARCH_BEFORE[@]+"${SEARCH_BEFORE[@]}"}; echo "archive: user keychain search list restored"; }
  trap restore_search_list EXIT
  security list-keychains -d user -s "$KC" ${SEARCH_BEFORE[@]+"${SEARCH_BEFORE[@]}"}
fi

wait_for_xcodebuild_gate
echo "archive: archiving $SCHEME ($WORKSPACE)${PROFILE:+, signing with the profile \"$PROFILE\"}"
if [ -n "$PROFILE" ]; then
  xcodebuild \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    archive
else
  xcodebuild \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$ASC_PRIVATE_KEY_PATH" \
    -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    archive
fi

if [ -n "$PROFILE" ]; then
  BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleIdentifier' "$ARCHIVE_PATH/Info.plist")"
  cat > "$BUILD_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>$DEVELOPMENT_TEAM</string>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$BUNDLE_ID</key>
    <string>$PROFILE</string>${BOOKCLUB_SIGNING_WIDGETS_PROFILE:+
    <key>$BUNDLE_ID.widgets</key>
    <string>$BOOKCLUB_SIGNING_WIDGETS_PROFILE</string>}${BOOKCLUB_SIGNING_MESSAGES_PROFILE:+
    <key>$BUNDLE_ID.messages</key>
    <string>$BOOKCLUB_SIGNING_MESSAGES_PROFILE</string>}
  </dict>
  <key>destination</key>
  <string>export</string>
</dict>
</plist>
PLIST
  echo "archive: exporting a signed .ipa"
  wait_for_xcodebuild_gate
  xcodebuild -exportArchive -archivePath "$ARCHIVE_PATH" -exportPath "$EXPORT_DIR" -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist"
  IPA="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' | head -1)"
  echo "archive: done. $IPA"
  echo "archive: next, scripts/upload.sh \"$IPA\""
  exit 0
fi

cat > "$BUILD_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>destination</key>
  <string>export</string>
</dict>
</plist>
PLIST

echo "archive: exporting a signed .ipa"
wait_for_xcodebuild_gate
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_PRIVATE_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"

IPA="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' | head -1)"
echo "archive: done. $IPA"
echo "archive: next, scripts/upload.sh \"$IPA\""
