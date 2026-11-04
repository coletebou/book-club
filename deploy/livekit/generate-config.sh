#!/bin/sh
# Generates deploy/livekit/livekit.yaml from livekit.yaml.template and the environment (D159).
# Run after `cp deploy/.env.example deploy/.env` and filling in the LIVEKIT_* lines, and again
# whenever one of them changes:
#   set -a; . deploy/.env; set +a; deploy/livekit/generate-config.sh
# Needs envsubst (Debian/Ubuntu: apt-get install gettext-base).
set -eu
cd "$(dirname "$0")"

: "${BOOKCLUB_LIVEKIT_API_KEY:?set BOOKCLUB_LIVEKIT_API_KEY in deploy/.env (docs/DEPLOY.md)}"
: "${BOOKCLUB_LIVEKIT_API_SECRET:?set BOOKCLUB_LIVEKIT_API_SECRET in deploy/.env (docs/DEPLOY.md)}"
: "${BOOKCLUB_LIVEKIT_NODE_IP:?set BOOKCLUB_LIVEKIT_NODE_IP to this host's public IP (docs/DEPLOY.md)}"
: "${BOOKCLUB_LIVEKIT_UDP_PORT:=7882}"
: "${BOOKCLUB_LIVEKIT_WEBHOOK_URL:=http://app:8080/api/livekit/webhook}"

export LIVEKIT_API_KEY="$BOOKCLUB_LIVEKIT_API_KEY"
export LIVEKIT_API_SECRET="$BOOKCLUB_LIVEKIT_API_SECRET"
export LIVEKIT_NODE_IP="$BOOKCLUB_LIVEKIT_NODE_IP"
export LIVEKIT_UDP_PORT="$BOOKCLUB_LIVEKIT_UDP_PORT"
export LIVEKIT_WEBHOOK_URL="$BOOKCLUB_LIVEKIT_WEBHOOK_URL"
envsubst < livekit.yaml.template > livekit.yaml
chmod 600 livekit.yaml
echo "wrote $(pwd)/livekit.yaml (udp_port=$LIVEKIT_UDP_PORT, node_ip=$LIVEKIT_NODE_IP)"
