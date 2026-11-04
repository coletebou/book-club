#!/usr/bin/env bash
# One-time (idempotent) setup for the build Mac (an EC2 Mac instance, say): a user-local Node 24 and
# CocoaPods under ~/bookclub, nothing system-wide, nothing touching other projects' tooling there.
set -euo pipefail

BOOKCLUB_HOME="$HOME/bookclub"
NODE_DIR="$BOOKCLUB_HOME/node"
NODE_VERSION="24.9.0"
ARCH="$(uname -m)" # arm64 on Apple Silicon EC2 Mac instances

mkdir -p "$BOOKCLUB_HOME"

if [ -x "$NODE_DIR/bin/node" ] && "$NODE_DIR/bin/node" --version | grep -q '^v24\.'; then
  echo "setup-mac-ec2: Node already installed at $NODE_DIR ($("$NODE_DIR/bin/node" --version))"
else
  echo "setup-mac-ec2: installing Node $NODE_VERSION (user-local, $ARCH)"
  TARBALL="node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" -o "$TMP/$TARBALL"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$TARBALL" -C "$NODE_DIR" --strip-components=1
fi

export PATH="$NODE_DIR/bin:$PATH"
echo "setup-mac-ec2: node $(node --version), npm $(npm --version)"

# pnpm, via corepack (shipped with Node), user-local: apps/mobile is a pnpm workspace member, but
# builds and typechecks here run with plain npm/npx against this one app's own node_modules, kept
# separate from the monorepo's (apps/mobile is not rsynced with the rest of the repo for a build).
corepack enable --install-directory "$NODE_DIR/bin" 2>/dev/null || true

if command -v pod >/dev/null 2>&1; then
  echo "setup-mac-ec2: CocoaPods already available ($(pod --version))"
elif gem list --local cocoapods -i >/dev/null 2>&1; then
  echo "setup-mac-ec2: CocoaPods gem already installed for this user"
else
  echo "setup-mac-ec2: installing CocoaPods (user-local gem, --user-install)"
  if gem install cocoapods --user-install; then
    echo 'setup-mac-ec2: add this to your shell profile if `pod` is not on PATH:'
    ruby -e 'puts "  export PATH=\"#{Gem.user_dir}/bin:$PATH\""'
  else
    # Seen once (2026-10-28): this box's system Ruby (2.6, macOS's own) cannot build native gem
    # extensions (nkf, ffi) against Xcode 27.1's SDK — a header-path mismatch between the Ruby
    # the OS shipped and the SDK the current Xcode ships, not anything about CocoaPods itself.
    # `brew install cocoapods` (brew already on this box for another project) pulls its own Ruby and
    # avoids the system one entirely; it does not touch that project's own formulas (checked:
    # ffmpeg, awscli still ran fine after). Not "nothing system-wide" to the letter, but the
    # nearest thing to it that actually built.
    echo "setup-mac-ec2: user-local gem install failed (likely the system Ruby vs Xcode SDK mismatch); trying 'brew install cocoapods'"
    brew install cocoapods
  fi
fi

# A fresh SSH session on this box has no default keychain at all (there is no logged-in GUI
# session), so codesign and -allowProvisioningUpdates have nowhere to put or find a signing
# identity; scripts/archive.sh fails with "A default keychain could not be found" without this.
# Dedicated, not the login keychain, so a reboot or another project clearing its own keychains does not
# take archive.sh's signing identity down with it. The unlock password is kept (mode 600, this
# box only) so a later run, or a locked keychain after a reboot, can unlock it again; it secures
# nothing beyond this one local keychain.
KEYCHAIN_PW_FILE="$BOOKCLUB_HOME/.keychain-pw"
if [ ! -s "$KEYCHAIN_PW_FILE" ]; then
  openssl rand -base64 24 > "$KEYCHAIN_PW_FILE"
  chmod 600 "$KEYCHAIN_PW_FILE"
fi
KEYCHAIN_PW="$(cat "$KEYCHAIN_PW_FILE")"
if security show-keychain-info build.keychain >/dev/null 2>&1; then
  echo "setup-mac-ec2: build.keychain already exists"
else
  echo "setup-mac-ec2: creating build.keychain for codesigning"
  security create-keychain -p "$KEYCHAIN_PW" build.keychain
fi
security set-keychain-settings build.keychain # no timeout, no lock on sleep: stays open for CI
security unlock-keychain -p "$KEYCHAIN_PW" build.keychain
# Never the default keychain, never the user search list: a build Mac may be shared (another
# project's release host), and both are global to the user. Setting them here on 2026-10-28 blocked
# another project's release keychain steps. scripts/archive.sh adds build.keychain to the search list only for
# the length of an archive, and puts the list back as it found it, however the archive ends.

echo "setup-mac-ec2: done. Add 'export PATH=\"$NODE_DIR/bin:\$PATH\"' to your shell profile, or source apps/mobile/scripts/lib.sh (add_local_node_to_path) in each script."
echo "setup-mac-ec2: scripts/archive.sh also needs DEVELOPMENT_TEAM (the Apple Developer Team ID) and a certificate for ai.badland.books that this team can use on this machine -- see apps/mobile/README.md, TestFlight, for what was found and still blocks an upload."
