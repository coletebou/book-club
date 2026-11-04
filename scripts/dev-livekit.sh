#!/usr/bin/env bash
# A local LiveKit dev server (D153), for manual testing and the E2E suite's voice/party specs: no
# TLS, a fixed demo key and secret, dev mode. Pairs with scripts/dev-stack.sh, which picks it up
# automatically through the environment (it inherits the shell's, not just what it exports
# itself) — set these before calling it, or before running `pnpm e2e`:
#   export LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=bookclubdev \
#          LIVEKIT_API_SECRET=bookclubdev-secret-not-for-real-use
#
#   scripts/dev-livekit.sh [wsPort] [tcpPort] [udpPort]   start (default 7880 7881 50000)
#   scripts/dev-livekit.sh stop
#
# Needs Docker (on a host where it is a group, not sudo: `sg docker -c scripts/dev-livekit.sh`).
set -euo pipefail
NAME=bookclub-dev-livekit
IMAGE="livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20"
DEV_KEY=bookclubdev
DEV_SECRET=bookclubdev-secret-not-for-real-use

if [[ "${1:-}" == "stop" ]]; then
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped $NAME" || echo "not running"
  exit 0
fi

WS_PORT="${1:-7880}"
TCP_PORT="${2:-7881}"
UDP_PORT="${3:-50000}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -p "127.0.0.1:$WS_PORT:7880" \
  -p "$TCP_PORT:$TCP_PORT" \
  -p "$UDP_PORT:$UDP_PORT/udp" \
  -e LIVEKIT_KEYS="$DEV_KEY: $DEV_SECRET" \
  -e LIVEKIT_RTC_NODE_IP=127.0.0.1 \
  -e LIVEKIT_RTC_TCP_PORT="$TCP_PORT" \
  -e LIVEKIT_RTC_UDP_PORT="$UDP_PORT" \
  "$IMAGE" --dev --bind 0.0.0.0 >/dev/null

echo "LiveKit dev server on ws://127.0.0.1:$WS_PORT (key $DEV_KEY)"
echo "export LIVEKIT_URL=ws://127.0.0.1:$WS_PORT LIVEKIT_API_KEY=$DEV_KEY LIVEKIT_API_SECRET=$DEV_SECRET"
