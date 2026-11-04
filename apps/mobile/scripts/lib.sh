#!/usr/bin/env bash
# Shared helpers for the iOS build scripts. Sourced, not run directly.

# A shared build Mac's Xcode may serve other projects' gates too: wait for any other `xcodebuild` to finish
# before starting one of our own, rather than contend for the same toolchain and simulator boot
# server. Checked right before each `xcodebuild`/`expo prebuild` invocation, not once at the top
# of a script, since another one can start while this one is doing earlier (non-Xcode) work.
wait_for_xcodebuild_gate() {
  local waited=0
  while pgrep -x xcodebuild >/dev/null 2>&1; do
    if [ "$waited" -eq 0 ]; then
      echo "xcodebuild gate: another xcodebuild is running (another project's, or a previous run); waiting…" >&2
    fi
    sleep 10
    waited=$((waited + 10))
    if [ "$waited" -ge 1800 ]; then
      echo "xcodebuild gate: still waiting after 30 minutes; giving up" >&2
      return 1
    fi
  done
  return 0
}

# ~/bookclub/node (user-local Node 24, scripts/setup-mac-ec2.sh) ahead of anything system-wide.
add_local_node_to_path() {
  if [ -x "$HOME/bookclub/node/bin/node" ]; then
    export PATH="$HOME/bookclub/node/bin:$PATH"
  fi
}
