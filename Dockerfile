# syntax=docker/dockerfile:1.7
# Book Club v2: one image, one process, one data volume.
#   docker compose up -d --build --wait      (demo target, seeded demo club; see README.md)

# A speech recogniser in the `runtime` image, for reading along (docs/RUNBOOK.md): the Whisper model
# it carries, base.en or small.en (pinned in tools/align/fetch_model.py), with TRANSCRIBER_THREADS
# (below) the threads it uses. The deploy kit sets base.en (deploy/compose.yaml); empty, the
# default, leaves it out and the image is the one it was without it, layer for layer.
ARG TRANSCRIBER_MODEL=

FROM node:24-bookworm-slim AS base
RUN npm install -g pnpm@11.18.0 && apt-get update && apt-get install -y --no-install-recommends tar ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/chat-core/package.json packages/chat-core/
COPY packages/epub/package.json packages/epub/
COPY e2e/package.json e2e/
# The iOS app (D130) is in the workspace, so its manifest is too, or the lockfile would not match
# the workspace; like the E2E suite, it is never installed or built into the server's image.
COPY apps/mobile/package.json apps/mobile/
# Patched dependencies (the iOS app's expo-audio, D195): a frozen install reads every patch the
# workspace names, even one for a package it is told not to install, and fails without its file.
COPY patches patches/
RUN --mount=type=cache,id=bookclubv2-pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=bookclubv2-pnpm-cache,target=/root/.cache/pnpm \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter '!@bookclub/e2e' --filter '!@bookclub/mobile'
COPY packages packages
COPY apps apps
RUN --mount=type=cache,id=bookclubv2-pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=bookclubv2-pnpm-cache,target=/root/.cache/pnpm \
    pnpm --filter @bookclub/web run build \
 && pnpm --filter @bookclub/server run build \
 && pnpm --filter @bookclub/server deploy --prod --legacy --prefer-offline --store-dir /pnpm-store /out

# The recogniser (tools/align/transcribe.py): faster-whisper and the packages locked with their
# hashes in tools/align/requirements.txt, in a venv on Debian's Python, and the model's files,
# each checked against its SHA-256 as it is fetched. Built only when TRANSCRIBER_MODEL is set.
FROM node:24-bookworm-slim AS recogniser-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY tools/align/requirements.txt /opt/align/requirements.txt
RUN --mount=type=cache,id=bookclubv2-pip-cache,target=/root/.cache/pip \
    python3 -m venv /opt/align/venv \
 && /opt/align/venv/bin/pip install --no-deps --only-binary :all: --require-hashes -r /opt/align/requirements.txt \
 && /opt/align/venv/bin/pip uninstall -y pip setuptools \
 && /opt/align/venv/bin/python -I -c 'import faster_whisper'
COPY tools/align/fetch_model.py /opt/align/fetch_model.py
ARG TRANSCRIBER_MODEL
RUN /opt/align/venv/bin/python -I /opt/align/fetch_model.py "$TRANSCRIBER_MODEL" "/opt/align/models/$TRANSCRIBER_MODEL"

# What `runtime` is built on: the Node image alone, or with the recogniser beside it, run by the
# server on each new audiobook (TRANSCRIBE_COMMAND) under nice, offline, as the server's own user.
FROM node:24-bookworm-slim AS runtime-base
FROM runtime-base AS runtime-base-with-recogniser
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY --from=recogniser-build /opt/align/venv /opt/align/venv
COPY --from=recogniser-build /opt/align/models /opt/align/models
COPY tools/align/progress.py tools/align/transcribe.py tools/align/transcribe_remote.py /opt/align/
ARG TRANSCRIBER_MODEL
ARG TRANSCRIBER_THREADS=2
# In front of it, transcribe_remote.py: with TRANSCRIBE_REMOTE_URL set, a GPU recogniser elsewhere
# transcribes when it answers, and this one when it does not (docs/GPU-TRANSCRIPTION.md); unset,
# it simply becomes the local command.
ENV TRANSCRIBE_COMMAND="/opt/align/venv/bin/python -I /opt/align/transcribe_remote.py nice -n 19 /opt/align/venv/bin/python -I /opt/align/transcribe.py --model /opt/align/models/${TRANSCRIBER_MODEL} --offline --threads ${TRANSCRIBER_THREADS}"

FROM runtime-base${TRANSCRIBER_MODEL:+-with-recogniser} AS runtime
ARG BOOKCLUB_REVISION=unknown
LABEL org.opencontainers.image.revision=$BOOKCLUB_REVISION
# ffmpeg (D141): media notes make a voice recording and a video web-safe (AAC/m4a; H.264/AAC mp4
# plus a poster frame) and read their true duration and dimensions, never trusting the upload's
# own claim. Without it, a voice note still plays (served as its own bytes, which the browser that
# made it always plays) but a video note is refused outright: there is no safe way to read an
# unknown container's dimensions or cut a frame from it without a decoder.
RUN apt-get update && apt-get install -y --no-install-recommends tar ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data WEB_DIST=/app/web
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data && printf '#!/bin/sh\nexec node /app/dist/cli.mjs "$@"\n' > /usr/local/bin/bookclub && chmod +x /usr/local/bin/bookclub
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.mjs"]

# The upstream's stand-in of the demo stack (tools/fake-upstream, D116): one file, no dependencies.
FROM node:24-bookworm-slim AS fake-upstream
WORKDIR /upstream
COPY tools/fake-upstream/server.mjs ./
USER node
ENV HOST=0.0.0.0 PORT=8081
EXPOSE 8081
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

# The Google stand-in of the demo stack (tools/fake-google, D178): one file, no dependencies.
FROM node:24-bookworm-slim AS fake-google
WORKDIR /google
COPY tools/fake-google/server.mjs ./
USER node
ENV HOST=0.0.0.0 PORT=8082
EXPOSE 8082
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8082/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

# An agent's stand-in of the demo stack (tools/fake-agent, D205): one file, no dependencies.
FROM node:24-bookworm-slim AS fake-agent
WORKDIR /agent
COPY tools/fake-agent/server.mjs ./
USER node
ENV HOST=0.0.0.0 PORT=8083
EXPOSE 8083
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8083/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

# The demo image: public-domain books baked in (verified by checksum) and seeded on first start.
FROM runtime AS demo
COPY --chown=node:node fixtures/books /demo/books
COPY --chown=node:node fixtures/audio/alice-tiny /demo/audio/alice-tiny
COPY --chown=node:node fixtures/align /demo/align
ADD --chown=node:node --checksum=sha256:fca40613cd198eb2b3e3b36e087b6cbaf22be8d143951d744670973a3c26d0d1 https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_01_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:b9925b8397aa6d2a60f24c73ebca8a6a865b575a7695619bff752a7dd6e58e57 https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_02_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:7be5be9ce9c68ecf24f57c14d4c4f4065e5ff78017c2513415c311b3f50b6405 https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_03_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:af6b966655ef47979289568a602d8dd5bad5c34fa720553076336787a48d293a https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_04_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:acf4832422211f6219d45d4079c14f2835babfc318ea1651cd31ace6fec90435 https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_05_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:44ae62f6024e5eede7173bf03d7a06bcd52ffe923ec3d4d70768ffb6db1f774e https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_06_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:ff8b10e41b89fd131cf6b02e189ad52197eada17db1e8dbdc2afc1538e5b536d https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_07_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:4b73f2a544177b55456bf3349a60baf12029a2996e6ad5552a9748812d89c573 https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_08_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:f60567b49c5140c324006d434b144a017843a2129dfe40b90b82305d9c0f5b68 https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_09_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:3b10c05f19efe2bf35ac148acc70e81ccf91de02f36938802dcd08c807d736ae https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_10_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:d80d1b74b625d754a7b065ca3827c0afe141c7c7d9081f5fbaccc4f309904a50 https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_11_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:63d55510466a58f8622381418f22dfc1e68779471ae1e8c7b06e81e437510f3e https://archive.org/download/alice_in_wonderland_librivox/wonderland_ch_12_64kb.mp3 /demo/audio/librivox-alice/
ADD --chown=node:node --checksum=sha256:8adf6ab30d4e279cb4efead8a966c4666674c9752ea4e6455f11c2725b82956a https://archive.org/download/alice_in_wonderland_librivox/Alice_in_Wonderland.jpg /demo/audio/librivox-alice/
ENV SEED_DEMO=1 DEMO_ASSETS=/demo
