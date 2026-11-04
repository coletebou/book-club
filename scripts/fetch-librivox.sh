#!/usr/bin/env bash
# The E2E suite uploads the real LibriVox recording of Alice (12 MP3s, public domain). The demo
# image already holds them, fetched by checksum when it was built (see the Dockerfile), so they
# are copied out of the running demo container instead of being downloaded again.
#   scripts/fetch-librivox.sh            -> .cache/downloads/librivox-alice
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.cache/downloads/librivox-alice"
if [[ -d "$DEST" && $(find "$DEST" -name '*.mp3' | wc -l) -ge 12 ]]; then
  echo "LibriVox tracks already in $DEST"
  exit 0
fi
mkdir -p "$ROOT/.cache/downloads"
cd "$ROOT"
docker compose cp app:/demo/audio/librivox-alice "$ROOT/.cache/downloads/" >/dev/null
echo "copied $(find "$DEST" -name '*.mp3' | wc -l) LibriVox tracks to $DEST"
