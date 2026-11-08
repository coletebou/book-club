#!/usr/bin/env bash
# CarPlay's model (D221) as the native side decodes it, against the vectors the TypeScript test
# checks model.ts builds: plain swiftc on macOS (Foundation only), no simulator and no Xcode project.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
xcrun swiftc -parse-as-library -o "$out/test" modules/book-club-native/ios/CarPlayModel.swift test/swift/CarPlayModelTests.swift
"$out/test" src/carplay/carplay-vectors.json
