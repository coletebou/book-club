#!/usr/bin/env bash
# Generates apps/mobile/ios from app.config.ts (`expo prebuild`). Needs Xcode: run on the build Mac
# (scripts/setup-mac-ec2.sh first, once). `npm install` here, not `pnpm`:
# this script runs against this one app's own checkout on the build box, not the monorepo's.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh
add_local_node_to_path

: "${BOOKCLUB_SERVER_URL:=http://127.0.0.1:47140}"
export BOOKCLUB_SERVER_URL
echo "prebuild: BOOKCLUB_SERVER_URL=$BOOKCLUB_SERVER_URL, BOOKCLUB_APS_ENVIRONMENT=${BOOKCLUB_APS_ENVIRONMENT:-development}"

if [ ! -d node_modules ]; then
  echo "prebuild: installing dependencies"
  npm install
fi

# Over-the-air updates (D180) are on only with the EAS project id (EAS_PROJECT_ID, or
# KNOWN_EAS_PROJECT_ID in app.config.ts): say which channel this build listens on, and warn when a
# TestFlight archive is about to be made that could never receive an update.
channel="$(npx expo config --type public --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const u=JSON.parse(s).updates;console.log(u?.enabled?u.requestHeaders["expo-channel-name"]:"")})')"
if [ -n "$channel" ]; then
  echo "prebuild: over-the-air updates on, channel $channel"
elif [ "${BOOKCLUB_APS_ENVIRONMENT:-}" = production ]; then
  echo "prebuild: WARNING: no EAS project id, so this archive will never receive an over-the-air update (README.md, Over-the-air updates)" >&2
else
  echo "prebuild: over-the-air updates off (no EAS project id)"
fi

wait_for_xcodebuild_gate
npx expo prebuild --platform ios --clean --non-interactive

echo "prebuild: done. apps/mobile/ios is generated and gitignored; re-run this script after changing app.config.ts or plugins/, never edit ios/ by hand."
