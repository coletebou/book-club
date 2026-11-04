#!/usr/bin/env bash
# The automatic deploy (docs/DEPLOY.md, "Checks and automatic deploys"): the one command the CI
# deploy key may run on the host. A copy lives outside the clone it updates, so a commit cannot
# change what the key does before it has been reviewed and installed by hand:
#
#   install -m 755 deploy/auto-deploy.sh ~/bin/book-club-auto-deploy
#
# and in the deploy account's ~/.ssh/authorized_keys (from the host itself only, no shell, no
# forwarding; the path is that account's own home):
#
#   restrict,from="127.0.0.1,::1",command="/home/<user>/bin/book-club-auto-deploy" ssh-ed25519 AAAA... book-club-auto-deploy
#
# It takes one request, "deploy <commit>", a full 40-character commit that is on origin/master
# (over SSH as the forced command's SSH_ORIGINAL_COMMAND, or as arguments by hand), or
# "retention", which only reports what a cleanup would keep and remove. It fast-forwards the clone to it, builds, restarts the stack and waits until the app is healthy and
# answers through the public address. A failed build changes nothing that runs. A failed start puts
# the previous commit and saved runtime image back and starts that again (never restores/deletes
# live data). Schema-changing deploys still need a compatibility review. Deploys take turns (a
# lock), and a commit older than the one running is skipped, so a slow run never undoes a newer one.
#
# What is particular to this host lives outside the repository, in one optional file a commit
# cannot change: BOOKCLUB_DEPLOY_CONFIG (default ~/.config/book-club/auto-deploy.env), plain
# KEY=value lines (a value may be quoted; nothing in it is run), each read only when the
# environment does not already set it (a run by hand, the tests):
#
#   BOOKCLUB_DEPLOY_DIR=/opt/book-club        # the clone (the default)
#   BOOKCLUB_DEPLOY_URL=https://books.example.org   # default: https:// + BOOKCLUB_HOST in deploy/.env
#   # The compose files, in order: paths relative to the clone, or absolute for this host's own
#   # overrides (extra_hosts, a private network, ...). Default: the kit's host-proxy pair; a host
#   # behind the kit's own Caddy uses just deploy/compose.yaml.
#   BOOKCLUB_COMPOSE_FILES="deploy/compose.yaml deploy/compose.host-proxy.yaml /home/<user>/.config/book-club/compose.host.yaml"
#   BOOKCLUB_DEPLOY_LOCK, BOOKCLUB_KEEP_ROLLBACKS, BOOKCLUB_BUILD_CACHE_MAX, BOOKCLUB_MIN_FREE_GB (below)
set -euo pipefail
umask 022

die() { echo "auto-deploy: $*" >&2; exit 1; }
say() { echo "auto-deploy: $*"; }

CONFIG=${BOOKCLUB_DEPLOY_CONFIG:-$HOME/.config/book-club/auto-deploy.env}
CONFIG_KEYS=' BOOKCLUB_DEPLOY_DIR BOOKCLUB_DEPLOY_URL BOOKCLUB_DEPLOY_LOCK BOOKCLUB_KEEP_ROLLBACKS BOOKCLUB_BUILD_CACHE_MAX BOOKCLUB_MIN_FREE_GB BOOKCLUB_COMPOSE_FILES '
# Read, never sourced: only the settings above, only from a file nobody else may change.
load_config() {
  local line key value
  [[ -O "$CONFIG" || "$(stat -c %u "$CONFIG")" == 0 ]] || die "$CONFIG is not this account's (or root's): not reading it"
  [[ -z "$(find "$CONFIG" -maxdepth 0 -perm /022)" ]] || die "$CONFIG is writable by others: not reading it"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] || die "$CONFIG: not a KEY=value line: $line"
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    [[ "$CONFIG_KEYS" == *" $key "* ]] || die "$CONFIG: unknown setting $key"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    [[ -n "${!key+set}" ]] || printf -v "$key" '%s' "$value"
  done < "$CONFIG"
}
[[ ! -e "$CONFIG" ]] || load_config

REPO=${BOOKCLUB_DEPLOY_DIR:-/opt/book-club}
PUBLIC_URL=${BOOKCLUB_DEPLOY_URL:-}
LOCK=${BOOKCLUB_DEPLOY_LOCK:-$HOME/.book-club-auto-deploy.lock}
read -r -a COMPOSE_FILES <<<"${BOOKCLUB_COMPOSE_FILES:-deploy/compose.yaml deploy/compose.host-proxy.yaml}"
# Disk retention (docs/DEPLOY.md, "Disk retention"). Each deploy tags the running image as
# bookclub:rollback-<commit> (~2 GB); without pruning they and the build cache filled a shared
# host's root disk on 2026-11-02 (its other services went down).
KEEP_ROLLBACKS=${BOOKCLUB_KEEP_ROLLBACKS:-2}
BUILD_CACHE_MAX=${BOOKCLUB_BUILD_CACHE_MAX:-8gb}
# Free space Docker's filesystem must have before a build starts: the new image (~2 GB), a cold
# build cache, and headroom for the other services on the host. Below it the deploy fails
# without changing anything, instead of filling the disk.
MIN_FREE_GB=${BOOKCLUB_MIN_FREE_GB:-8}
# Compose labels every image it builds for this project; untagged ones (a failed deploy's image
# after rollback) are pruned by this label only, so other stacks' images are never touched.
PROJECT_LABEL=com.docker.compose.project=bookclub

[[ "$KEEP_ROLLBACKS" =~ ^[0-9]+$ ]] || die "BOOKCLUB_KEEP_ROLLBACKS must be a whole number"
[[ "$MIN_FREE_GB" =~ ^[0-9]+$ ]] || die "BOOKCLUB_MIN_FREE_GB must be a whole number"

docker_root() { docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /; }
free_kb() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }

# One line per bookclub:rollback-* tag, newest image first: "keep\t<tag>" for the newest
# KEEP_ROLLBACKS, "remove\t<tag>" for the rest. Only that repository and prefix are listed, so
# bookclub:runtime, a hand-made tag and every other project's image are never candidates.
rollback_plan() {
  docker image ls --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' bookclub |
    awk -F'\t' '$2 ~ /^bookclub:rollback-[0-9a-f]+$/' | sort -r |
    awk -F'\t' -v keep="$KEEP_ROLLBACKS" '{ print (NR <= keep ? "keep" : "remove") "\t" $2 }'
}

# Drop the rollback tags past KEEP_ROLLBACKS, this project's untagged images, and build cache
# beyond BUILD_CACHE_MAX (oldest first, so the next build stays warm but bounded). Best effort:
# a failed step is reported, never fatal. Removing a tag whose image a container still uses
# only untags it.
cleanup() {
  local action tag
  while IFS=$'\t' read -r action tag; do
    [[ "$action" == remove ]] || continue
    if docker image rm "$tag" >/dev/null; then say "removed old rollback image $tag"; fi
  done < <(rollback_plan 2>/dev/null || true)
  docker image prune -f --filter dangling=true --filter "label=$PROJECT_LABEL" >/dev/null ||
    say "warning: could not prune untagged Book Club images"
  docker builder prune -f --max-used-space "$BUILD_CACHE_MAX" >/dev/null ||
    say "warning: could not trim the build cache"
  local root; root=$(docker_root)
  say "cleanup done; $(( $(free_kb "$root") / 1048576 )) GB free on $root"
}

# Read-only: what a cleanup would keep and remove right now, and the free-space gate.
retention_report() {
  local root avail; root=$(docker_root); avail=$(free_kb "$root")
  say "retention: keep the running image and the newest $KEEP_ROLLBACKS rollback image(s)"
  rollback_plan | sed 's/^/auto-deploy:   /'
  say "free on $root: $((avail / 1048576)) GB (deploys need $MIN_FREE_GB GB)"
}

request=${SSH_ORIGINAL_COMMAND:-$*}
read -r verb sha extra <<<"$request" || true
if [[ "${verb:-}" == retention && -z "${sha:-}" ]]; then
  retention_report
  exit 0
fi
if [[ "${verb:-}" != deploy || ! "${sha:-}" =~ ^[0-9a-f]{40}$ || -n "${extra:-}" ]]; then
  echo "usage: deploy <40-character commit on origin/master> | retention" >&2
  exit 64
fi

exec 9>"$LOCK"
flock -w 1800 9 || die "another deploy has held the lock for 30 minutes"

cd "$REPO"
compose_args=()
for f in "${COMPOSE_FILES[@]}"; do
  [[ -f "$f" ]] || die "compose file $f is missing (BOOKCLUB_COMPOSE_FILES)"
  compose_args+=(-f "$f")
done
((${#compose_args[@]})) || die "BOOKCLUB_COMPOSE_FILES names no compose file"
bc() { docker compose "${compose_args[@]}" --env-file deploy/.env "$@"; }
# The public address the health check goes through: as configured, or the one deploy/.env serves.
if [[ -z "$PUBLIC_URL" ]]; then
  env_value() { [[ -r deploy/.env ]] || return 0; sed -n "s/^$1=//p" deploy/.env | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
  host=$(env_value BOOKCLUB_HOST) port=$(env_value BOOKCLUB_PUBLIC_PORT)
  [[ -n "$host" ]] || die "no BOOKCLUB_DEPLOY_URL, and no BOOKCLUB_HOST in $REPO/deploy/.env to build it from"
  PUBLIC_URL="https://$host${port:+:$port}"
fi

[[ "$(git symbolic-ref --quiet --short HEAD || true)" == master ]] || die "$REPO is not on master"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "$REPO has tracked files changed by hand; deploy by hand"
git fetch --quiet origin master
git merge-base --is-ancestor "$sha" origin/master || die "$sha is not on origin/master"

prev=$(git rev-parse HEAD)
if [[ "$prev" != "$sha" ]] && git merge-base --is-ancestor "$sha" "$prev"; then
  say "already at $prev, which is newer than $sha: nothing to do"
  exit 0
fi
# Make room first (this project's old images only), then refuse to build without enough space.
cleanup
root=$(docker_root)
avail=$(free_kb "$root")
if (( avail < MIN_FREE_GB * 1048576 )); then
  die "only $((avail / 1048576)) GB free on $root, the deploy needs $MIN_FREE_GB GB (BOOKCLUB_MIN_FREE_GB); nothing was changed. See what uses it: docker system df; df -h $root"
fi
# Preserve the exact running image; rollback needs neither a registry nor another successful build.
container=$(bc ps -q app)
[[ -n "$container" ]] || die "no running app to preserve for rollback; deploy by hand"
previous_image=$(docker inspect --format '{{.Image}}' "$container")
runtime_image=$(docker inspect --format '{{.Config.Image}}' "$container")
rollback_image="bookclub:rollback-${prev}"
docker image tag "$previous_image" "$rollback_image"
git merge --ff-only --quiet "$sha" || die "cannot fast-forward $prev to $sha"
say "deploying $sha (was $prev)"

healthy() {
  local attempt
  for ((attempt=0; attempt<30; attempt++)); do
    curl -fsS -o /dev/null --max-time 5 "$PUBLIC_URL/healthz" && return 0
    sleep 2
  done
  return 1
}

# Build first: while it runs (or if it fails) the running containers are untouched.
# Compose delegates to Bake, but newer Buildx refuses network: host without an explicit
# CLI entitlement even when it is declared in Compose. Grant only the existing build-network
# permission, not security.insecure or any runtime host access. pipefail covers config failures.
if ! bc build --print --build-arg "BOOKCLUB_REVISION=$sha" |
  docker buildx bake --file - --allow=network.host --progress=quiet; then
  git reset --keep --quiet "$prev"
  die "the build failed; nothing was restarted, the clone is back at $prev"
fi

if bc up -d --no-build --wait --wait-timeout 900 && healthy; then
  current=$(bc ps -q app || true)
  revision=unknown
  if [[ -n "$current" ]]; then
    revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$current" 2>/dev/null || true)
  fi
  if [[ "$revision" == "$sha" ]]; then
    say "deployed $sha: $PUBLIC_URL/healthz answers"
    cleanup
    exit 0
  fi
  echo "auto-deploy: healthy app carries revision $revision, expected $sha; rolling back" >&2
fi

# Retain the error status even when rollback succeeds; GitHub must show the deploy failed.
echo "auto-deploy: $sha did not come up healthy; going back to $prev" >&2
bc logs --no-color --tail 80 app >&2 || true
git reset --keep --quiet "$prev"
docker image tag "$rollback_image" "$runtime_image"
if bc up -d --no-build --wait --wait-timeout 900 && healthy; then
  cleanup # the failed build is untagged now; drop it
  die "rolled back to $prev, which is healthy; $sha was not deployed"
fi
die "rolled back to $prev, but it is not healthy either: look at the host now"
