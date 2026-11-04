#!/usr/bin/env bash
# Publishes this app's own JavaScript as an over-the-air update to one EAS Update channel (D180):
#   scripts/publish-update.sh development|preview|production [message]
# (or `pnpm --filter @bookclub/mobile update:<channel>`). Runs anywhere Node runs, no Xcode needed.
#
# An update reaches only the builds whose runtime version (a fingerprint of their native code,
# fingerprint.config.js) is the same as the one computed here, so this sets up the environment
# the builds on that channel were made with: preview and production builds are archives
# (BOOKCLUB_APS_ENVIRONMENT=production) for the production server; a development build is
# whatever it was built with, so pass the same BOOKCLUB_SERVER_URL its prebuild had (the
# simulator builds of scripts/run-simulator.sh use http://127.0.0.1:47140).
#
# Needs: `eas login` once on this machine, or EXPO_TOKEN (an Expo access token; never print it).
# The EAS project is app.config.ts's KNOWN_EAS_PROJECT_ID (EAS_PROJECT_ID overrides it).
# The message defaults to the last commit subject.
set -euo pipefail
cd "$(dirname "$0")/.."

PRODUCTION_SERVER_URL=https://books.badland.ai
EAS_CLI_VERSION=27.2.0

# pnpm 11 passes a `--` through to the script as it is: `update:production -- "message"` means the same.
[ "${1:-}" = -- ] && shift
channel="${1:-}"
[ "${2:-}" = -- ] && set -- "$1" "${@:3}"
case "$channel" in
  development) ;;
  preview|production)
    if [ -n "${BOOKCLUB_SERVER_URL:-}" ] && [ "$BOOKCLUB_SERVER_URL" != "$PRODUCTION_SERVER_URL" ]; then
      echo "publish-update: $channel builds use $PRODUCTION_SERVER_URL; unset BOOKCLUB_SERVER_URL (now $BOOKCLUB_SERVER_URL)" >&2
      exit 2
    fi
    export BOOKCLUB_SERVER_URL="$PRODUCTION_SERVER_URL" BOOKCLUB_APS_ENVIRONMENT=production
    ;;
  *)
    echo "usage: scripts/publish-update.sh development|preview|production [message]" >&2
    exit 2
    ;;
esac
export BOOKCLUB_UPDATE_CHANNEL="$channel"
message="${2:-$(git log -1 --format=%s)}"

if [ "$(npx expo config --type public --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).updates?.enabled===true))')" != true ]; then
  echo "publish-update: updates are off: set EAS_PROJECT_ID (or KNOWN_EAS_PROJECT_ID in app.config.ts) to the id \`eas init\` gave" >&2
  exit 2
fi

runtime="$(npx expo-updates runtimeversion:resolve --platform ios | tail -1 | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).runtimeVersion))')"
echo "publish-update: channel $channel, runtime version $runtime"
echo "publish-update: only builds with this runtime version get it (a build's own is in its .app, EXUpdates.bundle/fingerprint)"

if command -v eas >/dev/null 2>&1; then eas=(eas); else eas=(npx --yes "eas-cli@$EAS_CLI_VERSION"); fi
"${eas[@]}" update \
  --channel "$channel" \
  --environment "$channel" \
  --platform ios \
  --message "$message" \
  --non-interactive
