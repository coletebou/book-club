#!/usr/bin/env bash
# Exercise the real Git/forced-command path in scratch repos. Docker and HTTPS are fake: these
# tests never reach production, a daemon, or live data.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_LOG"
if [[ "$1" == inspect ]]; then
  case "$*" in
    *org.opencontainers.image.revision*)
      [[ "${TEST_FAILURE:-}" != inspect-label ]] || exit 1
      # Before the first start the running (old) image answers; after it, the new one.
      if [[ ! -f "$TEST_COUNT" ]]; then echo "${TEST_RUNNING_REVISION:-$TEST_PREV}"; else echo "${TEST_REVISION:-$TEST_SHA}"; fi ;;
    *Config.Image*) echo bookclub:runtime ;;
    *) echo sha256:old ;;
  esac
elif [[ "$1" == info ]]; then
  echo /var/lib/docker
elif [[ "$1 $2" == 'image ls' ]]; then
  [[ ! -f "${TEST_IMAGES:-}" ]] || cat "$TEST_IMAGES"
elif [[ "$1 $2" == 'image rm' ]]; then
  shift 2
  for tag in "$@"; do
    grep -v -e "	$tag	" -e "	$tag\$" "$TEST_IMAGES" > "$TEST_IMAGES.new" || true
    mv "$TEST_IMAGES.new" "$TEST_IMAGES"
  done
elif [[ "$*" == 'builder prune -f' ]]; then
  # Dropping the whole unused cache frees TEST_CACHE_KB.
  [[ -z "${TEST_CACHE_KB:-}" ]] || echo $(( ${TEST_FREE_KB:-20971520} + TEST_CACHE_KB )) > "$TEST_COUNT.free"
elif [[ "$1 $2" == 'image tag' || "$1 $2" == 'image prune' || "$1 $2" == 'builder prune' ]]; then
  :
elif [[ "$1 $2" == 'buildx bake' ]]; then
  [[ "$*" == *'--allow=network.host'* && "$*" != *'security.insecure'* ]] || exit 1
  cat >/dev/null
  [[ "${TEST_FAILURE:-}" != bake ]]
else
  while [[ "$1" != ps && "$1" != build && "$1" != up && "$1" != logs ]]; do shift; done
  case "$1" in
    ps)
      if [[ "${TEST_FAILURE:-}" == ps-after-start && -f "$TEST_COUNT" ]]; then exit 1; fi
      echo old-container ;;
    build) [[ "${TEST_FAILURE:-}" != build ]] ;;
    up)
      n=0; [[ ! -f "$TEST_COUNT" ]] || n=$(cat "$TEST_COUNT")
      n=$((n+1)); echo "$n" > "$TEST_COUNT"
      [[ "${TEST_FAILURE:-}" != up || "$n" -gt 1 ]]
      ;;
    logs) echo fake-app-log ;;
  esac
fi
MOCK
cat > "$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$TEST_LOG"
[[ "${TEST_FAILURE:-}" != health || $(cat "$TEST_COUNT") -gt 1 ]]
MOCK
cat > "$TMP/bin/df" <<'MOCK'
#!/usr/bin/env bash
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
free=$(cat "$TEST_COUNT.free" 2>/dev/null || echo "${TEST_FREE_KB:-20971520}")
echo "/dev/sda1 157286400 1 $free 1% /"
MOCK
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/sleep"
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Test GIT_COMMITTER_NAME=Test
export GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_EMAIL=test@example.invalid
unset SSH_ORIGINAL_COMMAND

setup() {
  local name=$1
  mkdir -p "$TMP/$name"
  git init -q --bare "$TMP/$name/remote"
  git init -q -b master "$TMP/$name/seed"
  mkdir -p "$TMP/$name/seed/deploy"
  : > "$TMP/$name/seed/deploy/compose.yaml"
  : > "$TMP/$name/seed/deploy/compose.host-proxy.yaml"
  git -C "$TMP/$name/seed" add deploy
  git -C "$TMP/$name/seed" commit -q -m first
  PREV=$(git -C "$TMP/$name/seed" rev-parse HEAD)
  export TEST_PREV=$PREV
  git -C "$TMP/$name/seed" remote add origin "$TMP/$name/remote"
  git -C "$TMP/$name/seed" push -q origin master
  git --git-dir="$TMP/$name/remote" symbolic-ref HEAD refs/heads/master
  git clone -q "$TMP/$name/remote" "$TMP/$name/live"
  git -C "$TMP/$name/seed" commit -q --allow-empty -m second
  export TEST_SHA
  TEST_SHA=$(git -C "$TMP/$name/seed" rev-parse HEAD)
  git -C "$TMP/$name/seed" push -q origin master
  export BOOKCLUB_DEPLOY_DIR="$TMP/$name/live"
  export BOOKCLUB_DEPLOY_LOCK="$TMP/$name/lock"
  export BOOKCLUB_DEPLOY_CONFIG="$TMP/$name/auto-deploy.env"
  export BOOKCLUB_DEPLOY_URL=https://books.example.org
  export TEST_LOG="$TMP/$name/docker.log" TEST_COUNT="$TMP/$name/count"
  unset TEST_FAILURE TEST_REVISION TEST_FREE_KB TEST_IMAGES BOOKCLUB_COMPOSE_FILES TEST_RUNNING_REVISION TEST_CACHE_KB
}
expect_rc() {
  local expected=$1; shift
  local rc=0
  bash "$ROOT/deploy/auto-deploy.sh" "$@" > "$TMP/output" 2>&1 || rc=$?
  if [[ "$rc" != "$expected" ]]; then cat "$TMP/output"; echo "expected rc=$expected, got $rc" >&2; exit 1; fi
}
head_is() { [[ $(git -C "$BOOKCLUB_DEPLOY_DIR" rev-parse HEAD) == "$1" ]]; }
setup invalid
expect_rc 64 'deploy bad'
expect_rc 64 "deploy $TEST_SHA extra"
expect_rc 1 "deploy 0000000000000000000000000000000000000000"
[[ ! -f "$TEST_LOG" ]]
setup success
expect_rc 0 "deploy $TEST_SHA"
head_is "$TEST_SHA"
grep -q "BOOKCLUB_REVISION=$TEST_SHA" "$TEST_LOG"
grep -q 'up -d --no-build' "$TEST_LOG"
grep -q 'build --print' "$TEST_LOG"
grep -q 'buildx bake --file - --allow=network.host --progress=quiet' "$TEST_LOG"
grep -q 'compose -f deploy/compose.yaml -f deploy/compose.host-proxy.yaml --env-file deploy/.env' "$TEST_LOG"
grep -q 'curl .*https://books.example.org/healthz' "$TEST_LOG"
# An older queued run must not undo a newer deployment.
size=$(wc -l < "$TEST_LOG")
expect_rc 0 "deploy $PREV"
head_is "$TEST_SHA"
[[ $(wc -l < "$TEST_LOG") == "$size" ]]
setup dirty
printf tracked > "$BOOKCLUB_DEPLOY_DIR/dirty"
git -C "$BOOKCLUB_DEPLOY_DIR" add dirty
expect_rc 1 "deploy $TEST_SHA"
[[ ! -f "$TEST_LOG" ]]
for failure in build bake up health; do
  setup "$failure"
  export TEST_FAILURE="$failure"
  expect_rc 1 "deploy $TEST_SHA"
  head_is "$PREV"
  if [[ "$failure" == build || "$failure" == bake ]]; then
    if grep -q 'up -d' "$TEST_LOG"; then echo "a failed build still restarted the stack" >&2; exit 1; fi
  else
    grep -q "image tag bookclub:rollback-$PREV bookclub:runtime" "$TEST_LOG"
    [[ $(cat "$TEST_COUNT") == 2 ]]
  fi
done
setup label
export TEST_REVISION=wrong
expect_rc 1 "deploy $TEST_SHA"
head_is "$PREV"
[[ $(cat "$TEST_COUNT") == 2 ]]
for failure in inspect-label ps-after-start; do
  setup "$failure"
  export TEST_FAILURE="$failure"
  expect_rc 1 "deploy $TEST_SHA"
  head_is "$PREV"
  grep -q "image tag bookclub:rollback-$PREV bookclub:runtime" "$TEST_LOG"
  [[ $(cat "$TEST_COUNT") == 2 ]]
done
# Retention. Five rollback images (created out of order), the running image, a hand-made tag and
# another project's lookalike: only the oldest rollback tags past BOOKCLUB_KEEP_ROLLBACKS go.
images() {
  export TEST_IMAGES="$TMP/images"
  printf '%s\t%s\t%s\n' \
    '2026-11-03 13:28:02 +0000 UTC' 'bookclub:runtime' aaaaaaaaaaaa \
    '2026-11-01 09:00:00 +0000 UTC' 'bookclub:rollback-1111111111111111111111111111111111111111' 111111111111 \
    '2026-11-03 12:46:28 +0000 UTC' 'bookclub:rollback-5555555555555555555555555555555555555555' 555555555555 \
    '2026-10-30 09:00:00 +0000 UTC' 'bookclub:rollback-0000000000000000000000000000000000000000' 000000000000 \
    '2026-11-02 09:00:00 +0000 UTC' 'bookclub:rollback-3333333333333333333333333333333333333333' 333333333333 \
    '2026-11-03 08:00:00 +0000 UTC' 'bookclub:rollback-4444444444444444444444444444444444444444' 444444444444 \
    '2026-10-01 09:00:00 +0000 UTC' 'bookclub:keep-by-hand' 999999999999 \
    '2026-10-01 09:00:00 +0000 UTC' 'bookclubber:rollback-9999999999999999999999999999999999999999' 999999999998 \
    > "$TEST_IMAGES"
}
removed() { grep '^image rm ' "$TEST_LOG" | sed 's/^image rm //' | sort | tr '\n' ' '; }
old3='bookclub:rollback-0000000000000000000000000000000000000000 bookclub:rollback-1111111111111111111111111111111111111111 bookclub:rollback-3333333333333333333333333333333333333333 '
setup retention-report
images
expect_rc 0 retention
grep -q 'keep	bookclub:rollback-5555' "$TMP/output"
grep -q 'keep	bookclub:rollback-4444' "$TMP/output"
[[ $(grep -c 'remove	bookclub:rollback-' "$TMP/output") == 3 ]]
! grep -q 'runtime\|keep-by-hand\|bookclubber' "$TMP/output"
grep -q 'free on /var/lib/docker: 20 GB (deploys need 8 GB)' "$TMP/output"
if grep -qv '^image ls\|^info' "$TEST_LOG"; then echo "retention report changed something" >&2; exit 1; fi
expect_rc 64 'retention now'
setup retention-deploy
images
expect_rc 0 "deploy $TEST_SHA"
head_is "$TEST_SHA"
[[ "$(removed)" == "$old3" ]] || { echo "removed: $(removed)" >&2; exit 1; }
grep -q 'removed old rollback image bookclub:rollback-0000' "$TMP/output"
grep -q '^image prune -f --filter dangling=true --filter label=com.docker.compose.project=bookclub$' "$TEST_LOG"
grep -q '^builder prune -f --max-used-space 8gb$' "$TEST_LOG"
if grep -q 'system prune\|volume\|prune -a\|prune --all\|image rm bookclub:runtime\|keep-by-hand\|bookclubber' "$TEST_LOG"; then
  echo "cleanup reached beyond Book Club's old rollback images" >&2; exit 1
fi
setup retention-keep-one
images
BOOKCLUB_KEEP_ROLLBACKS=1 expect_rc 0 retention
[[ $(grep -c 'remove	bookclub:rollback-' "$TMP/output") == 4 ]]
BOOKCLUB_KEEP_ROLLBACKS=x expect_rc 1 retention
# Too little space even after cleanup: fail before touching the clone, the tags or the stack.
setup low-disk
images
export TEST_FREE_KB=$((5 * 1048576))
expect_rc 1 "deploy $TEST_SHA"
head_is "$PREV"
grep -q 'only 5 GB free on /var/lib/docker, the deploy needs 8 GB' "$TMP/output"
grep -q 'nothing was changed' "$TMP/output"
grep -q 'dropping the unused build cache to make room' "$TMP/output"
grep -q '^builder prune -f$' "$TEST_LOG"
[[ "$(removed)" == "$old3" ]]
if grep -q 'image tag\|buildx bake\|up -d' "$TEST_LOG"; then echo "a deploy without disk space went ahead" >&2; exit 1; fi
BOOKCLUB_MIN_FREE_GB=4 expect_rc 0 "deploy $TEST_SHA"
head_is "$TEST_SHA"
# Short of space, but the build cache holds enough: drop it and deploy (a cold build).
setup low-disk-cache
images
export TEST_FREE_KB=$((6 * 1048576)) TEST_CACHE_KB=$((4 * 1048576))
expect_rc 0 "deploy $TEST_SHA"
head_is "$TEST_SHA"
grep -q 'only 6 GB free on /var/lib/docker; dropping the unused build cache' "$TMP/output"
# Tags that share an image (the host on 2026-11-04: two tags, one image) or sit on the running
# image take no keep slot: two distinct older images are still kept.
setup shared-images
export TEST_IMAGES="$TMP/images"
printf '%s\t%s\t%s\n' \
  '2026-11-04 16:36:40 +0000 UTC' 'bookclub:runtime' aaaaaaaaaaaa \
  '2026-11-04 16:36:40 +0000 UTC' 'bookclub:rollback-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' aaaaaaaaaaaa \
  '2026-11-03 13:28:02 +0000 UTC' 'bookclub:rollback-9ac5a07a1ac1acfaa2c77b2b1180e1245eb20873' c504b9a2b0e9 \
  '2026-11-03 13:28:02 +0000 UTC' 'bookclub:rollback-01cc15e7a4b90700e73857882c1e9734e3f3cf79' c504b9a2b0e9 \
  '2026-11-03 12:46:28 +0000 UTC' 'bookclub:rollback-4a0ea2dbbeedffa068c520ef60c0f58e354a8c87' 4a0ea2dbbeed \
  '2026-11-02 09:00:00 +0000 UTC' 'bookclub:rollback-b3efe27000000000000000000000000000000000' b3efe2700000 \
  > "$TEST_IMAGES"
expect_rc 0 retention
[[ $(grep -c 'keep	bookclub:rollback-' "$TMP/output") == 4 ]]
grep -q 'keep	bookclub:rollback-4a0ea2d' "$TMP/output"
[[ $(grep -c 'remove	bookclub:rollback-' "$TMP/output") == 1 ]]
grep -q 'remove	bookclub:rollback-b3efe27' "$TMP/output"
# The rollback tag names the revision the running image holds, even when the clone was moved
# by hand to another commit.
setup moved-clone
export TEST_RUNNING_REVISION=cccccccccccccccccccccccccccccccccccccccc
expect_rc 0 "deploy $TEST_SHA"
grep -q '^image tag sha256:old bookclub:rollback-cccccccccccccccccccccccccccccccccccccccc$' "$TEST_LOG"
grep -q "the running image was built from cccc.*but the clone is at $PREV" "$TMP/output"
# A failed deploy's image is untagged by the rollback; it is pruned once the old one is healthy.
setup rollback-prune
export TEST_FAILURE=health
expect_rc 1 "deploy $TEST_SHA"
tail -n 4 "$TEST_LOG" | grep -q '^image prune -f --filter dangling=true --filter label=com.docker.compose.project=bookclub$'
# Host-only settings (BOOKCLUB_DEPLOY_CONFIG): this host's own compose override and address come
# from a file outside the clone, read only where the environment says nothing.
setup host-config
unset BOOKCLUB_DEPLOY_URL
printf 'services: {}\n' > "$TMP/host-config/compose.host.yaml"
cat > "$BOOKCLUB_DEPLOY_CONFIG" <<EOF
# this host
BOOKCLUB_DEPLOY_URL='https://books.host.example'
BOOKCLUB_COMPOSE_FILES="deploy/compose.yaml deploy/compose.host-proxy.yaml $TMP/host-config/compose.host.yaml"
BOOKCLUB_DEPLOY_DIR=$TMP/nowhere
EOF
chmod 600 "$BOOKCLUB_DEPLOY_CONFIG"
expect_rc 0 "deploy $TEST_SHA"
head_is "$TEST_SHA"
grep -q "compose -f deploy/compose.yaml -f deploy/compose.host-proxy.yaml -f $TMP/host-config/compose.host.yaml --env-file deploy/.env" "$TEST_LOG"
grep -q 'curl .*https://books.host.example/healthz' "$TEST_LOG"
# Without BOOKCLUB_DEPLOY_URL anywhere, the address is the one deploy/.env serves.
setup derived-url
unset BOOKCLUB_DEPLOY_URL
printf 'BOOKCLUB_HOST="books.derived.example"\nBOOKCLUB_PUBLIC_PORT=8443\n' > "$BOOKCLUB_DEPLOY_DIR/deploy/.env"
expect_rc 0 "deploy $TEST_SHA"
grep -q 'curl .*https://books.derived.example:8443/healthz' "$TEST_LOG"
setup no-url
unset BOOKCLUB_DEPLOY_URL
expect_rc 1 "deploy $TEST_SHA"
head_is "$PREV"
[[ ! -f "$TEST_LOG" ]]
# A settings file it cannot trust or read changes nothing.
setup bad-config
printf 'BOOKCLUB_SOMETHING=1\n' > "$BOOKCLUB_DEPLOY_CONFIG"
chmod 600 "$BOOKCLUB_DEPLOY_CONFIG"
expect_rc 1 "deploy $TEST_SHA"
grep -q 'unknown setting BOOKCLUB_SOMETHING' "$TMP/output"
printf 'BOOKCLUB_DEPLOY_URL=https://books.example.org\n' > "$BOOKCLUB_DEPLOY_CONFIG"
chmod 666 "$BOOKCLUB_DEPLOY_CONFIG"
expect_rc 1 "deploy $TEST_SHA"
grep -q 'writable by others' "$TMP/output"
head_is "$PREV"
[[ ! -f "$TEST_LOG" ]]
# A compose file named but missing: nothing is built or restarted.
setup missing-compose
export BOOKCLUB_COMPOSE_FILES="deploy/compose.yaml $TMP/missing-compose/absent.yaml"
expect_rc 1 "deploy $TEST_SHA"
grep -q 'absent.yaml is missing' "$TMP/output"
head_is "$PREV"
[[ ! -f "$TEST_LOG" ]]
echo 'auto-deploy: 26 scenarios passed (cache drop on low disk, shared-image keep slots, rollback tag from the running revision, invalid requests, success, stale run, dirty clone, build/start/health failure, wrong revision, failed label/container lookup, retention report, rollback pruning, keep-one, low disk, prune after rollback, host settings, derived/missing address, untrusted settings, missing compose file)'

