#!/usr/bin/env bash
# Prints the runtime version (D180) app.config.ts gives in this environment: what a build made now
# would have, and what an update published now would need. Compare it with a build's own (inside
# its .app: EXUpdates.bundle/fingerprint) when an update does not arrive.
#   BOOKCLUB_APS_ENVIRONMENT=production scripts/runtime-version.sh   # a TestFlight archive's
#   scripts/runtime-version.sh --debug                                # and every source hashed
set -euo pipefail
cd "$(dirname "$0")/.."

[ "${1:-}" = -- ] && shift   # pnpm 11 passes `runtime-version -- --debug` through as it is
resolved="$(npx expo-updates runtimeversion:resolve --platform ios "$@" | tail -1)"
if [ "${1:-}" = --debug ]; then
  echo "$resolved"
else
  node -e 'console.log(JSON.parse(process.argv[1]).runtimeVersion)' "$resolved"
fi
