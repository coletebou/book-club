#!/usr/bin/env bash
# Every workspace project plus tools, sequentially without a resident package manager.
set -euo pipefail
cd "$(dirname "$0")/.."
# tsrs (D230) is native code, so there is no V8 heap to cap. The largest program, apps/server, peaks
# at about 300 MB RSS against 850 MB for tsc 6 (measured 2026-11-26), well under the runner's
# 1 GiB MemoryHigh.
for config in packages/*/tsconfig.json apps/*/tsconfig.json apps/mobile/test/tsconfig.json e2e/tsconfig.json tools/tsconfig.json; do
  echo "typecheck: $config"
  node_modules/.bin/tsrs --noEmit -p "$config"
done
