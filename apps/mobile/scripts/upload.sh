#!/usr/bin/env bash
# Uploads an exported .ipa (scripts/archive.sh) to App Store Connect for TestFlight, using the
# same API key (no Apple ID sign-in). Requires the ai.badland.books app record to already exist
# in App Store Connect — this uploads a build to it; it cannot create the record (README.md).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ASC_KEY_ID:?set ASC_KEY_ID}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"
: "${ASC_PRIVATE_KEY_PATH:?set ASC_PRIVATE_KEY_PATH to the .p8 file}"
[ -f "$ASC_PRIVATE_KEY_PATH" ] || { echo "upload: $ASC_PRIVATE_KEY_PATH does not exist" >&2; exit 1; }

IPA="${1:-}"
if [ -z "$IPA" ]; then
  IPA="$(find build/archive/export -maxdepth 1 -name '*.ipa' 2>/dev/null | head -1)"
fi
[ -n "$IPA" ] && [ -f "$IPA" ] || { echo "upload: usage: scripts/upload.sh <path-to.ipa> (or run scripts/archive.sh first)" >&2; exit 1; }

# `altool` wants the key under ~/private_keys/AuthKey_<id>.p8 (or one of a few fixed locations);
# a symlink there is simpler than relying on it discovering ASC_PRIVATE_KEY_PATH on its own.
KEYS_DIR="$HOME/private_keys"
mkdir -p "$KEYS_DIR"
KEY_LINK="$KEYS_DIR/AuthKey_${ASC_KEY_ID}.p8"
[ -e "$KEY_LINK" ] || ln -s "$(cd "$(dirname "$ASC_PRIVATE_KEY_PATH")" && pwd)/$(basename "$ASC_PRIVATE_KEY_PATH")" "$KEY_LINK"

echo "upload: uploading $IPA"
xcrun altool --upload-app \
  --type ios \
  --file "$IPA" \
  --apiKey "$ASC_KEY_ID" \
  --apiIssuer "$ASC_ISSUER_ID"

echo "upload: done. It will show up in App Store Connect > TestFlight once Apple finishes processing (usually a few minutes)."
