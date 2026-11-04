#!/usr/bin/env bash
# Every workspace project plus tools, sequentially without a resident package manager.
set -euo pipefail
cd "$(dirname "$0")/.."
# These flags apply only to TypeScript, never to test forks or application Workers.
# apps/server needs about 604 MB of heap since the Anthropic SDK 1.1 types (680 MB RSS, measured
# 2026-10-30 with --extendedDiagnostics); 768 MiB stays under the runner's 1 GiB MemoryHigh.
export MALLOC_ARENA_MAX=2 NODE_OPTIONS=--max-semi-space-size=2
for config in packages/*/tsconfig.json apps/*/tsconfig.json apps/mobile/test/tsconfig.json e2e/tsconfig.json tools/tsconfig.json; do
  echo "typecheck: $config"
  node --max-old-space-size=768 node_modules/typescript/bin/tsc --noEmit -p "$config"
done
