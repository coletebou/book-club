#!/usr/bin/env bash
# The deploy kit, rehearsed on this machine (docs/DEPLOY.md): the production compose file behind
# Caddy with HTTPS (Caddy's own certificate authority, on 127.0.0.1:47443), an owner, a book
# uploaded over HTTPS, an audiobook of it transcribed by the recogniser in the image and lined up
# with it, a backup, the data destroyed, the backup restored, and the book read back byte for
# byte. Prints each step; exits non-zero at the first that fails. Cleans up after itself.
#   scripts/deploy-drill.sh
# Needs ffmpeg and the LibriVox Alice in .cache/downloads/librivox-alice (scripts/fetch-librivox.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/.data"
WORK="$(mktemp -d "$ROOT/.data/drill-XXXXXX")"
export BOOKCLUB_PROJECT=bookclubv2-drill
export BOOKCLUB_HOST=books.localhost BOOKCLUB_PUBLIC_PORT=47443 BOOKCLUB_TLS=internal
export BOOKCLUB_HTTP=127.0.0.1:47480 BOOKCLUB_HTTPS=127.0.0.1:47443 BOOKCLUB_BACKUPS="$WORK/backups"
# An image of its own: a real deployment's bookclub:runtime on this host is left as it is.
export BOOKCLUB_IMAGE=bookclubv2-drill:runtime
# Not made here: on a fresh host Docker creates it, as root, and the backup service must cope.
URL="https://$BOOKCLUB_HOST:$BOOKCLUB_PUBLIC_PORT"
EPUB="$ROOT/fixtures/books/alice-gutenberg-11.epub"
LIBRIVOX="$ROOT/.cache/downloads/librivox-alice"
# The kit as it comes, with the drill's settings only: a deploy/.env beside it is not read.
compose() { docker compose -f "$ROOT/deploy/compose.yaml" -p "$BOOKCLUB_PROJECT" --env-file /dev/null "$@"; }
# The backup directory may still be root's (Docker made it) if the drill stopped early.
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  [[ -d "$WORK/backups" ]] && docker run --rm --user 0:0 -v "$WORK:/w" --entrypoint rm "$BOOKCLUB_IMAGE" -rf /w/backups >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$1"; }
fail() { echo "DRILL FAILED: $1" >&2; exit 1; }
# curl against the drill's own certificate authority, with books.localhost on this machine.
https() { curl -sS --fail-with-body --cacert "$WORK/root.crt" --resolve "$BOOKCLUB_HOST:$BOOKCLUB_PUBLIC_PORT:127.0.0.1" -b "$WORK/cookies" -c "$WORK/cookies" -H "origin: $URL" "$@"; }
OWNER_EMAIL=owner@drill.test OWNER_PASSWORD='a-long-drill-password'
# Pull one field out of the JSON on stdin: json '.editions[0].id'.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=new Function("d","return d"+process.argv[1])(JSON.parse(s));console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
command -v ffmpeg >/dev/null || fail "no ffmpeg on this machine (it cuts the drill's audiobook)"
[[ $(ls "$LIBRIVOX"/wonderland_ch_*_64kb.mp3 2>/dev/null | wc -l) == 12 ]] || fail "no LibriVox recording in ${LIBRIVOX#"$ROOT/"} (scripts/fetch-librivox.sh)"

step "Start: app, Caddy (HTTPS) and the backup service"
T0=$(date +%s)
compose build 2>&1 | tail -2
echo "built after $(( $(date +%s) - T0 ))s: $BOOKCLUB_IMAGE, $(docker image ls "$BOOKCLUB_IMAGE" --format '{{.Size}}')"
compose up -d --wait 2>&1 | tail -3
echo "up after $(( $(date +%s) - T0 ))s"
for _ in $(seq 1 30); do compose cp proxy:/data/caddy/pki/authorities/local/root.crt "$WORK/root.crt" >/dev/null 2>&1 && break; sleep 1; done
[[ -s "$WORK/root.crt" ]] || fail "no certificate authority from Caddy"

step "HTTPS with a valid certificate and HSTS"
headers=$(https -D - -o /dev/null "$URL/healthz")
echo "$headers" | grep -iE '^(HTTP|strict-transport-security|content-security-policy)' | cut -c1-110
echo "$headers" | grep -qi '^strict-transport-security: max-age=31536000' || fail "no HSTS"
https "$URL/healthz" | grep -q '"ok":true' || fail "healthz"
# Without the drill's authority, curl refuses the certificate (it really is checked).
if curl -s --resolve "$BOOKCLUB_HOST:$BOOKCLUB_PUBLIC_PORT:127.0.0.1" -o /dev/null "$URL/healthz"; then fail "an unknown certificate was accepted"; fi

step "Nobody can claim the empty instance from the browser; the first owner, then a Secure session cookie over HTTPS"
https "$URL/api/session" | grep -q '"setupRequired":false' || fail "the empty instance offers setup to the world"
CLAIM=$(https -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"displayName":"Mallory","email":"m@example.org","password":"mallory-takes-it","clubName":"Mine"}' "$URL/api/setup" || true)
echo "setup from the browser: HTTP $CLAIM"
[[ "$CLAIM" == "403" ]] || fail "the browser could set up the instance"
# The password piped in, as docs/DEPLOY.md does it: never on a command line.
printf '%s\n' "$OWNER_PASSWORD" | compose exec -T app bookclub create-owner --email "$OWNER_EMAIL" --name Owner --password-stdin --club 'Drill club'
https -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" "$URL/api/auth/signin" >/dev/null
# Over HTTPS the session cookie is __Host- prefixed: only this host can set it (docs/REVIEW.md SA29).
grep -q $'\t__Host-bc_session\t' "$WORK/cookies" || fail "no __Host-bc_session cookie"
grep $'\t__Host-bc_session\t' "$WORK/cookies" | awk '{ print "cookie:", $6, "secure flag:", $4 }'
[[ "$(grep $'\t__Host-bc_session\t' "$WORK/cookies" | awk '{ print $4 }')" == "TRUE" ]] || fail "the session cookie is not Secure"
# Live presence goes through the proxy too: a WebSocket over TLS says hello.
SESSION=$(grep $'\t__Host-bc_session\t' "$WORK/cookies" | awk '{ print $7 }')
WS_HELLO=$(cd "$ROOT/apps/server" && node -e '
  const fs = require("node:fs");
  const WebSocket = require("ws");
  const [url, ca, cookie, origin] = process.argv.slice(1);
  const ws = new WebSocket(url.replace(/^https/, "wss") + "/ws", { ca: fs.readFileSync(ca), headers: { cookie: "__Host-bc_session=" + cookie, origin }, lookup: (_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]) });
  const timer = setTimeout(() => { console.log("no hello"); process.exit(1); }, 5000);
  ws.on("message", (data) => { const m = JSON.parse(String(data)); if (m.type === "hello") { console.log("hello for " + m.userId); clearTimeout(timer); ws.close(); } });
  ws.on("error", (err) => { console.log("websocket error: " + err.message); process.exit(1); });
' "$URL" "$WORK/root.crt" "$SESSION" "$URL") || fail "no WebSocket through the proxy: $WS_HELLO"
echo "websocket over TLS: $WS_HELLO"
CLUB=$(https "$URL/api/clubs" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))')
echo "club $CLUB"

step "Upload a book over HTTPS (tus), and wait until it is ready"
SIZE=$(stat -c %s "$EPUB")
IMPORT=$(https -H 'content-type: application/json' -d "{\"kind\":\"epub\",\"files\":[{\"name\":\"alice.epub\",\"size\":$SIZE,\"type\":\"application/epub+zip\",\"role\":\"main\"}]}" "$URL/api/clubs/$CLUB/imports" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
b64() { printf '%s' "$1" | base64 -w0; }
LOCATION=$(https -D - -o /dev/null -X POST -H 'tus-resumable: 1.0.0' -H "upload-length: $SIZE" -H "upload-metadata: importId $(b64 "$IMPORT"),fileIndex $(b64 0),filename $(b64 alice.epub),filetype $(b64 application/epub+zip)" "$URL/api/uploads" | awk -F': ' 'tolower($1)=="location"{ print $2 }' | tr -d '\r')
[[ -n "$LOCATION" ]] || fail "no upload location"
https -X PATCH -H 'tus-resumable: 1.0.0' -H 'upload-offset: 0' -H 'content-type: application/offset+octet-stream' --data-binary "@$EPUB" "$URL${LOCATION#"$URL"}" -o /dev/null
BOOK=$(https -H 'content-type: application/json' -d '{"title":"Alice in the drill","author":"Lewis Carroll"}' "$URL/api/imports/$IMPORT/finalize" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).bookId))')
for _ in $(seq 1 60); do
  STATUS=$(https "$URL/api/books/$BOOK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).editions[0].status))')
  [[ "$STATUS" == ready ]] && break
  sleep 1
done
[[ "$STATUS" == ready ]] || fail "the book did not become ready ($STATUS)"
EDITION=$(https "$URL/api/books/$BOOK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).editions[0].id))')
ORIGINAL=$(sha256sum "$EPUB" | cut -c1-64)
SERVED=$(https "$URL/media/editions/$EDITION/file" | sha256sum | cut -c1-64)
echo "book $BOOK ready; the file served over HTTPS is the uploaded one: $([[ "$SERVED" == "$ORIGINAL" ]] && echo yes || echo NO)"
[[ "$SERVED" == "$ORIGINAL" ]] || fail "served file differs"
https -X PUT -H 'content-type: application/json' -d "{\"editionId\":\"$EDITION\",\"locator\":{\"kind\":\"epub\",\"section\":4,\"offset\":120},\"readSpans\":[{\"from\":{\"kind\":\"epub\",\"section\":2,\"offset\":0},\"to\":{\"kind\":\"epub\",\"section\":4,\"offset\":120}}],\"at\":$(date +%s)000}" "$URL/api/books/$BOOK/progress" -o /dev/null

step "An audiobook of it over HTTPS, transcribed by the recogniser in the image and lined up with it"
RECOGNISER=$(compose exec -T app printenv TRANSCRIBE_COMMAND || true)
echo "recogniser: ${RECOGNISER:-none}"
[[ -n "$RECOGNISER" ]] || fail "the image runs no recogniser (BOOKCLUB_TRANSCRIBER_MODEL or BOOKCLUB_TRANSCRIBE_COMMAND is empty)"
# A real recording, cut short: ten seconds of each chapter of the LibriVox Alice, from 0:45 (past
# its spoken preamble), as files named like LibriVox's, so that the server matches them to the
# book's chapters and lines them up by itself, as it would the whole recording. (A transcript is
# trusted where its sentences stay within a chapter of where the edition's map puts them, and one
# file alone is matched to no chapter: its map is a straight line over the whole book, which a
# short cut of one chapter is far from.)
mkdir "$WORK/cuts"
FILES=""
for f in "$LIBRIVOX"/wonderland_ch_*_64kb.mp3; do
  ffmpeg -nostdin -v error -ss 45 -t 10 -i "$f" -c copy "$WORK/cuts/$(basename "$f")"
  FILES+="${FILES:+,}{\"name\":\"$(basename "$f")\",\"size\":$(stat -c %s "$WORK/cuts/$(basename "$f")"),\"type\":\"audio/mpeg\",\"role\":\"track\"}"
done
AUDIO_IMPORT=$(https -H 'content-type: application/json' -d "{\"kind\":\"audio\",\"files\":[$FILES]}" "$URL/api/clubs/$CLUB/imports" | json .id)
TRACK=0
for f in "$WORK"/cuts/*.mp3; do
  LOCATION=$(https -D - -o /dev/null -X POST -H 'tus-resumable: 1.0.0' -H "upload-length: $(stat -c %s "$f")" -H "upload-metadata: importId $(b64 "$AUDIO_IMPORT"),fileIndex $(b64 "$TRACK"),filename $(b64 "$(basename "$f")"),filetype $(b64 audio/mpeg)" "$URL/api/uploads" | awk -F': ' 'tolower($1)=="location"{ print $2 }' | tr -d '\r')
  [[ -n "$LOCATION" ]] || fail "no upload location for $(basename "$f")"
  https -X PATCH -H 'tus-resumable: 1.0.0' -H 'upload-offset: 0' -H 'content-type: application/offset+octet-stream' --data-binary "@$f" "$URL${LOCATION#"$URL"}" -o /dev/null
  TRACK=$((TRACK + 1))
done
# The recogniser is caught as it runs, inside the app's container: whose it is, and how nice.
cat >"$WORK/watch.sh" <<'EOF'
for _ in $(seq 1 1200); do
  for p in /proc/[0-9]*; do
    if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q 'transcribe\.py'; then
      echo "uid $(awk '/^Uid:/ { print $2 }' "$p/status") nice $(cut -d' ' -f19 "$p/stat")"
      exit 0
    fi
  done
  sleep 0.5
done
exit 1
EOF
compose exec -T app sh <"$WORK/watch.sh" >"$WORK/recogniser" 2>&1 &
WATCH=$!
T1=$(date +%s)
AUDIO=$(https -H 'content-type: application/json' -d '{"title":"Alice in the drill","author":"Lewis Carroll","bookId":"'"$BOOK"'"}' "$URL/api/imports/$AUDIO_IMPORT/finalize" | json .editionId)
READY_AT="" READALONG=null
for _ in $(seq 1 300); do
  DETAIL=$(https "$URL/api/books/$BOOK")
  AUDIO_STATUS=$(json ".editions.find(e => e.id === '$AUDIO').status" <<<"$DETAIL")
  [[ "$AUDIO_STATUS" == failed ]] && fail "the audiobook could not be read: $(json ".editions.find(e => e.id === '$AUDIO').error" <<<"$DETAIL")"
  [[ "$AUDIO_STATUS" == ready && -z "$READY_AT" ]] && READY_AT=$(date +%s)
  READALONG=$(json ".editions.find(e => e.id === '$AUDIO').readAlong" <<<"$DETAIL")
  [[ "$READALONG" != null ]] && break
  sleep 2
done
DONE_AT=$(date +%s)
[[ -n "$READY_AT" ]] || fail "the audiobook did not become ready ($AUDIO_STATUS)"
HEARD_S=$(printf '%.1f' "$(json ".editions.find(e => e.id === '$AUDIO').durationMs / 1000" <<<"$DETAIL")")
echo "audiobook $AUDIO: $TRACK tracks, $HEARD_S s of the LibriVox recording, ready after $(( READY_AT - T1 ))s"
if [[ "$READALONG" == null ]]; then
  compose logs --no-log-prefix --tail 20 app >&2
  fail "the audiobook was not transcribed and lined up within 10 minutes"
fi
SENTENCES=$(json .sentences <<<"$READALONG")
echo "transcribed and lined up after $(( DONE_AT - T1 ))s: $SENTENCES sentences, $(printf '%.2f' "$(json '.coverage * 100' <<<"$READALONG")") % of the book's words heard and matched"
# The server's own account: the recogniser's job (its run, then the lining up) and what it heard.
LOGS=$(compose logs --no-log-prefix app)
JOB_MS=$(grep -F "\"job\":\"transcribe:$AUDIO\"" <<<"$LOGS" | tail -1 | json .ms)
ALIGNED=$(grep -F '"msg":"audiobook aligned with its text"' <<<"$LOGS" | grep -F "\"audio\":\"$AUDIO\"" | tail -1)
LINED=$(json .alignedTracks <<<"$ALIGNED")
echo "the server's job took $(printf '%.1f' "${JOB_MS}e-3")s for $HEARD_S s of audio; heard $(json .spokenWords <<<"$ALIGNED") words, matched $(json .matchedWords <<<"$ALIGNED"), tracks lined up $LINED of $TRACK"
if (( LINED < TRACK )); then echo "  (a track is trusted from 20 words matched: ten seconds of a slow reader hold fewer)"; fi
wait "$WATCH" || fail "the recogniser was not seen running"
echo "recogniser seen running: $(cat "$WORK/recogniser")"
[[ "$(cat "$WORK/recogniser")" == "uid $(compose exec -T app sh -c 'awk "/^Uid:/ { print \$2 }" /proc/1/status') nice 19" ]] || fail "the recogniser does not run as the server's user, at the lowest priority"

step "Back up: an incremental set (D125, the daily service's own kind) and a portable single file (D127)"
compose exec -T --user node backup sh -c 'umask 077 && bookclub backup --set /backups --keep 2'
SNAP=$(ls -t "$BOOKCLUB_BACKUPS"/db/bookclub-*.db.gz 2>/dev/null | head -1)
[[ -n "$SNAP" ]] || fail "no incremental snapshot"
echo "incremental snapshot: $(basename "$SNAP"), mode $(stat -c %a "$SNAP")"
[[ "$(stat -c %a "$SNAP")" == "600" ]] || fail "the snapshot is readable by others"
du -sh "$BOOKCLUB_BACKUPS/files/blobs" "$BOOKCLUB_BACKUPS/files/pubs" 2>/dev/null
[[ "$(compose ps --format '{{.Health}}' backup)" == "healthy" ]] || fail "the backup service is not healthy"
# Its loop runs as the app's user, under no-new-privileges: dropping from root to it is not a gain.
LOOP=$(compose exec -T backup sh -c 'grep -E "^(Uid|NoNewPrivs):" /proc/1/status' | tr -s '\t ' ' ' | paste -sd ';' -)
echo "backup loop: $LOOP"
[[ "$LOOP" == *"NoNewPrivs: 1"* ]] || fail "the backup service may gain privileges"
[[ "$LOOP" == *"Uid: $(compose exec -T --user node backup id -u) "* ]] || fail "the backup loop does not run as the app's user"
# The one-file command still works too, beside the set: a drill's own archive, or one to carry to
# a new host (D127). Restored into a scratch directory here, not DATA_DIR, so it never touches the
# app's real data; the disaster below is recovered from the incremental set, as production is.
compose exec -T --user node backup sh -c 'umask 077 && bookclub backup --out /backups/drill.tar.gz'
[[ -s "$BOOKCLUB_BACKUPS/drill.tar.gz" ]] || fail "no single-file backup"
compose exec -T --user node backup sh -c 'DATA_DIR=/tmp/single-file-check bookclub restore --from /backups/drill.tar.gz && test -f /tmp/single-file-check/bookclub.db' >/dev/null || fail "the single-file backup did not restore"
compose exec -T --user node backup rm -rf /tmp/single-file-check

step "Prune the incremental set to its newest snapshot"
compose exec -T --user node backup sh -c 'bookclub prune --set /backups --keep 1'
KEPT=$(ls "$BOOKCLUB_BACKUPS"/db/bookclub-*.db.gz 2>/dev/null)
[[ $(wc -l <<<"$KEPT") == 1 ]] || fail "prune did not reduce the set to one snapshot"
# Its own timestamp, to restore exactly this one below: the live service's loop starts again the
# moment the app it backs up is healthy again, and would otherwise make the drill restore its own
# (empty) snapshot of the just-recreated, not-yet-restored app instead of the real data below.
KEPT_TS=$(basename "$KEPT" | sed -E 's/^bookclub-(.+)\.db\.gz$/\1/')
echo "pruned to one snapshot: $(basename "$KEPT") ($KEPT_TS)"

step "Disaster: every volume deleted"
compose down -v 2>&1 | tail -2
compose up -d --wait 2>&1 | tail -1
for _ in $(seq 1 30); do compose cp proxy:/data/caddy/pki/authorities/local/root.crt "$WORK/root.crt" >/dev/null 2>&1 && break; sleep 1; done
rm -f "$WORK/cookies"
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$WORK/root.crt" --resolve "$BOOKCLUB_HOST:$BOOKCLUB_PUBLIC_PORT:127.0.0.1" -H "origin: $URL" -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" "$URL/api/auth/signin")
echo "sign-in on the empty server: HTTP $code"
[[ "$code" == 401 ]] || fail "the data was not gone ($code)"
# The bind-mounted backup directory is not a volume: `down -v` left the pruned snapshot exactly as
# it was (the live service may already have made another, empty one of the fresh, not-yet-restored
# app the moment it came back healthy — itself a sign the daily loop keeps working through this).
[[ -f "$BOOKCLUB_BACKUPS/db/$(basename "$KEPT")" ]] || fail "the incremental set's own snapshot did not survive the volume wipe"

step "Restore --from-set into the stopped app's fresh volume, then start it"
compose stop app 2>&1 | tail -1
compose run --rm --no-deps --user node backup "bookclub restore --from-set /backups --at $KEPT_TS --force"
compose start app 2>&1 | tail -1
for _ in $(seq 1 60); do https "$URL/healthz" >/dev/null 2>&1 && break; sleep 1; done

step "Everything is back"
https -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" "$URL/api/auth/signin" >/dev/null || fail "sign-in after the restore"
TITLE=$(https "$URL/api/books/$BOOK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).title))')
PLACE=$(https "$URL/api/books/$BOOK/progress" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).mine.label))')
RESTORED=$(https "$URL/media/editions/$EDITION/file" | sha256sum | cut -c1-64)
echo "book: $TITLE; my place: $PLACE; file identical: $([[ "$RESTORED" == "$ORIGINAL" ]] && echo yes || echo NO)"
[[ "$TITLE" == "Alice in the drill" && "$RESTORED" == "$ORIGINAL" && -n "$PLACE" ]] || fail "something did not come back"
BACK=$(https "$URL/api/books/$BOOK" | json ".editions.find(e => e.id === '$AUDIO').readAlong")
echo "the audiobook's read-along: $([[ "$BACK" != null ]] && json .sentences <<<"$BACK") sentences"
[[ "$BACK" != null && "$(json .sentences <<<"$BACK")" == "$SENTENCES" ]] || fail "the read-along did not come back"
echo
echo "DRILL PASSED in $(( $(date +%s) - T0 ))s"
