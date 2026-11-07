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
# Every deploy also compares this installed copy with deploy/auto-deploy.sh at the commit it
# deploys. When they differ it says so (and, run from GitHub Actions, as a warning on the run) with
# the command that installs the reviewed version; nothing else changes. A host that would rather
# not install by hand sets BOOKCLUB_DEPLOY_SELF_UPDATE=1 in its settings file (below; a commit
# cannot set it): the deploy then installs the version at the commit it deploys over this copy and
# runs that for the deploy. That gives master's reviewed commits this command too, as they already
# have the image and the compose files it runs (docs/DEPLOY.md, "When the command changes").
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
#   BOOKCLUB_DEPLOY_SELF_UPDATE=1             # install the deployed commit's version of this command
set -euo pipefail
umask 022

die() { echo "auto-deploy: $*" >&2; exit 1; }
say() { echo "auto-deploy: $*"; }

CONFIG=${BOOKCLUB_DEPLOY_CONFIG:-$HOME/.config/book-club/auto-deploy.env}
CONFIG_KEYS=' BOOKCLUB_DEPLOY_DIR BOOKCLUB_DEPLOY_URL BOOKCLUB_DEPLOY_LOCK BOOKCLUB_KEEP_ROLLBACKS BOOKCLUB_BUILD_CACHE_MAX BOOKCLUB_MIN_FREE_GB BOOKCLUB_COMPOSE_FILES BOOKCLUB_DEPLOY_SELF_UPDATE '
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
# Whether a deploy installs the deployed commit's deploy/auto-deploy.sh over this copy (header).
SELF_UPDATE=${BOOKCLUB_DEPLOY_SELF_UPDATE:-0}
# This command as installed: the file the forced command names, followed through any link.
SELF=$(readlink -f "${BASH_SOURCE[0]}")

[[ "$KEEP_ROLLBACKS" =~ ^[0-9]+$ ]] || die "BOOKCLUB_KEEP_ROLLBACKS must be a whole number"
[[ "$MIN_FREE_GB" =~ ^[0-9]+$ ]] || die "BOOKCLUB_MIN_FREE_GB must be a whole number"
[[ "$SELF_UPDATE" =~ ^[01]$ ]] || die "BOOKCLUB_DEPLOY_SELF_UPDATE must be 0 or 1"

docker_root() { docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /; }
free_kb() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }

# One line per bookclub:rollback-* tag, newest image first: "keep\t<tag>" for the tags of the
# newest KEEP_ROLLBACKS distinct images, "remove\t<tag>" for the rest. A tag on the running
# image (bookclub:runtime) or on an image already kept is kept and not counted: removing it
# would free nothing. Only that repository and prefix are listed, so bookclub:runtime, a
# hand-made tag and every other project's image are never candidates.
rollback_plan() {
  local rows running
  rows=$(docker image ls --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}\t{{.ID}}' bookclub)
  running=$(awk -F'\t' '$2 == "bookclub:runtime" { print $3 }' <<<"$rows")
  awk -F'\t' '$2 ~ /^bookclub:rollback-[0-9a-f]+$/' <<<"$rows" | sort -r |
    awk -F'\t' -v keep="$KEEP_ROLLBACKS" -v running="$running" '
      $3 == running || ($3 in kept) { print "keep\t" $2; next }
      n < keep { kept[$3] = 1; n++; print "keep\t" $2; next }
      { print "remove\t" $2 }'
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
  local root avail; root=$(docker_root); avail=$(free_kb "$root")
  if (( avail < MIN_FREE_GB * 1048576 )); then
    # Under the floor even so: the build cache can always be rebuilt, so the next build is cold
    # rather than the disk short. This also runs after a deploy, whose own build cache can take
    # the host below the floor (2026-11-05: 8 GB free before a build, 3 GB after). It is the
    # daemon's cache, shared with the host's other stacks; only unused entries go.
    say "only $((avail / 1048576)) GB free on $root; dropping the unused build cache to make room"
    docker builder prune -f >/dev/null || say "warning: could not drop the build cache"
    avail=$(free_kb "$root")
  fi
  say "cleanup done; $((avail / 1048576)) GB free on $root"
}

# Whether this installed copy is deploy/auto-deploy.sh as it is at <rev> in the clone: 0 when it
# is (or there is nothing to compare: it runs from the clone itself, or <rev> has no such file),
# 1 when it is not, after saying so with the command that installs the reviewed version.
command_current() {
  local rev want have repo
  repo=$(readlink -f "$REPO")
  [[ "$SELF" != "$repo"/* ]] || return 0
  rev=$(git -C "$REPO" rev-parse --verify --quiet "$1^{commit}") || return 0
  if ! git -C "$REPO" cat-file -e "$rev:deploy/auto-deploy.sh" 2>/dev/null; then
    say "no deploy/auto-deploy.sh at ${rev:0:12}: not comparing the installed command with it"
    return 0
  fi
  want=$(git -C "$REPO" show "$rev:deploy/auto-deploy.sh" | sha256sum | awk '{ print $1 }')
  have=$(sha256sum < "$SELF" | awk '{ print $1 }')
  if [[ "$want" == "$have" ]]; then
    say "the installed command is deploy/auto-deploy.sh at ${rev:0:12}"
    return 0
  fi
  say "the installed command $SELF (sha256 ${have:0:12}) is not deploy/auto-deploy.sh at ${rev:0:12} (sha256 ${want:0:12}); to install the reviewed version: install -m 755 $REPO/deploy/auto-deploy.sh $SELF"
  return 1
}

# Install deploy/auto-deploy.sh at <rev> over this copy, all at once: a new file moved into place,
# so the bash running the old one keeps reading the old one to its end.
install_command() {
  local rev=$1 next="$SELF.next.$$"
  if git -C "$REPO" show "$rev:deploy/auto-deploy.sh" > "$next" && chmod 755 "$next" && mv -f "$next" "$SELF"; then
    return 0
  fi
  rm -f "$next"
  return 1
}

# Read-only: what a cleanup would keep and remove right now, and the free-space gate.
retention_report() {
  local root avail; root=$(docker_root); avail=$(free_kb "$root")
  say "retention: keep the running image and the newest $KEEP_ROLLBACKS rollback image(s)"
  rollback_plan | sed 's/^/auto-deploy:   /'
  say "free on $root: $((avail / 1048576)) GB (deploys need $MIN_FREE_GB GB)"
  if git -C "$REPO" rev-parse --quiet --verify origin/master >/dev/null 2>&1; then
    command_current origin/master || true
  fi
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

# Run again by the version it just installed (below), it already holds the lock on fd 9: locking
# that same open file again is immediate, so no other deploy can start in between.
if [[ -z "${BOOKCLUB_DEPLOY_UPDATED:-}" ]] || ! { true >&9; } 2>/dev/null; then
  exec 9>"$LOCK"
fi
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
# The command itself (header): a reviewed change to it is installed here when the host asked for
# that, and the deploy is then run by the new version; otherwise it is only reported. Once only:
# a version just installed for this commit is never installed again in the same deploy.
# Run from GitHub Actions (the deploy job), what it found is also an annotation on the run.
if ! command_current "$sha"; then
  if [[ "$SELF_UPDATE" == 1 && "${BOOKCLUB_DEPLOY_UPDATED:-}" != "$sha" ]]; then
    install_command "$sha" || die "could not install deploy/auto-deploy.sh from $sha over $SELF; nothing was changed"
    say "installed deploy/auto-deploy.sh at ${sha:0:12} as $SELF; it runs this deploy"
    echo "::notice title=Book Club deploy command updated::The host installed deploy/auto-deploy.sh at ${sha:0:12} (BOOKCLUB_DEPLOY_SELF_UPDATE=1)."
    BOOKCLUB_DEPLOY_UPDATED=$sha exec "$SELF" "deploy $sha"
  fi
  echo "::warning title=Book Club deploy command out of date::The host's deploy command is not deploy/auto-deploy.sh at ${sha:0:12}. Install it by hand (docs/DEPLOY.md, When the command changes) or set BOOKCLUB_DEPLOY_SELF_UPDATE=1 on the host."
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
# Name the rollback tag after the revision the running image was built from, not the clone's
# HEAD: they differ once the clone is moved by hand, and the tag must say what it holds.
running_revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container" 2>/dev/null || true)
if [[ ! "$running_revision" =~ ^[0-9a-f]{40}$ ]]; then
  running_revision=$prev
elif [[ "$running_revision" != "$prev" ]]; then
  say "the running image was built from $running_revision, but the clone is at $prev"
fi
rollback_image="bookclub:rollback-${running_revision}"
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
