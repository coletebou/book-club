#!/usr/bin/env bash
# The watch app's model (D222) against the record the TypeScript test checks recordOf makes: plain
# swiftc on macOS (Foundation only), no simulator and no Xcode project.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
xcrun swiftc -parse-as-library -o "$out/test" targets/watch/NowPlaying.swift test/swift/WatchNowPlayingTests.swift
"$out/test" test/swift/watch-vectors.json
