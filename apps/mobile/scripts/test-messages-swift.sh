#!/usr/bin/env bash
# The Messages extension's message format (D220) against the shared golden vectors: plain swiftc on
# macOS (Foundation only), no simulator and no Xcode project. CI runs the TypeScript half; this one
# runs wherever Xcode's command-line tools are.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
xcrun swiftc -parse-as-library -o "$out/test" targets/messages/_shared/BookClubMessage.swift targets/messages/Tests/BookClubMessageTests.swift
"$out/test" ../../packages/shared/src/messages/imessage-vectors.json
