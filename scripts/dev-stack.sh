#!/usr/bin/env bash
# A local stack for fast iteration (no Docker): the server from source with a snapshot of the
# built SPA and a seeded demo club. The real acceptance runs use the Docker stack instead.
#   scripts/dev-stack.sh [port]          start (default 47120; data in .data/dev-stack[-port])
#   scripts/dev-stack.sh stop [port]     stop
# Each stack serves its own copy of the build, so rebuilding never breaks a running stack.
# With the recogniser on this host (docs/ALIGNMENT.md: the venv in .cache/tools/align-venv, the
# model in .cache/tools/hf), the server transcribes each new audiobook itself, as the deploy image
# does (docs/RUNBOOK.md); DEV_TRANSCRIBE=0 turns that off, DEV_TRANSCRIBE_MODEL=small.en picks
# another model, and a TRANSCRIBE_COMMAND of your own is used as it is.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" == "stop" ]]; then
  pid=$(ss -ltnp 2>/dev/null | grep "127.0.0.1:${2:-47120} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
  [[ -n "$pid" ]] && kill "$pid" && echo "stopped $pid" || echo "not running"
  exit 0
fi
PORT="${1:-47120}"
SUFFIX=""
[[ "$PORT" != "47120" ]] && SUFFIX="-$PORT"
DATA="$ROOT/.data/dev-stack$SUFFIX"
DIST="$ROOT/.data/web-dist$SUFFIX"
ASSETS="$ROOT/.data/dev-assets"
LOG="$ROOT/.data/dev-stack$SUFFIX.log"
mkdir -p "$ASSETS/audio" "$DATA"
ln -sfn "$ROOT/fixtures/books" "$ASSETS/books"
ln -sfn "$ROOT/fixtures/align" "$ASSETS/align"
[[ -d "$ROOT/.cache/downloads/librivox-alice" ]] && ln -sfn "$ROOT/.cache/downloads/librivox-alice" "$ASSETS/audio/librivox-alice"
(cd "$ROOT/apps/web" && nice pnpm run build >/dev/null)
rm -rf "$DIST" && cp -r "$ROOT/apps/web/dist" "$DIST"

PYTHON="$ROOT/.cache/tools/align-venv/bin/python"
MODEL="${DEV_TRANSCRIBE_MODEL:-base.en}"
export HF_HOME="$ROOT/.cache/tools/hf"
TRANSCRIBE=""
if [[ "${DEV_TRANSCRIBE:-1}" == 0 ]]; then
  :
elif [[ -n "${TRANSCRIBE_COMMAND+set}" ]]; then
  TRANSCRIBE="$TRANSCRIBE_COMMAND"
elif [[ -x "$PYTHON" ]] && compgen -G "$HF_HOME/hub/models--Systran--faster-whisper-$MODEL/snapshots/*/model.bin" >/dev/null \
  && "$PYTHON" -I -c 'import faster_whisper' 2>/dev/null; then
  # Quoted, for the server splits it on spaces outside quotes (no shell is involved).
  TRANSCRIBE="nice -n 19 \"$PYTHON\" -I \"$ROOT/tools/align/transcribe.py\" --model $MODEL --offline --threads 4"
fi

cd "$ROOT/apps/server"
export DATA_DIR="$DATA" PORT HOST=127.0.0.1 WEB_DIST="$DIST" SEED_DEMO=1 DEMO_ASSETS="$ASSETS" LOG_LEVEL=warn
: >"$LOG"
if [[ -n "$TRANSCRIBE" && ! -e "$DATA/bookclub.db" ]]; then
  # The demo club is seeded first, without the recogniser: its audiobook comes with its transcript,
  # which the seed adds once the audiobook is ready, and a recogniser started then would spend a
  # quarter of an hour making it again, to be set aside, holding up every audiobook uploaded meanwhile.
  env -u TRANSCRIBE_COMMAND nice pnpm exec tsx src/cli/index.ts seed >>"$LOG" 2>&1
fi
TRANSCRIBE_COMMAND="$TRANSCRIBE" nohup nice pnpm exec tsx src/main.ts >>"$LOG" 2>&1 &
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.5; done
echo "dev stack on http://127.0.0.1:$PORT (data: ${DATA#$ROOT/}, log: ${LOG#$ROOT/})"
if [[ -n "$TRANSCRIBE" ]]; then
  echo "new audiobooks are transcribed by the server: $TRANSCRIBE"
else
  echo "new audiobooks are not transcribed (DEV_TRANSCRIBE=0, or no recogniser on this host: docs/ALIGNMENT.md)"
fi
