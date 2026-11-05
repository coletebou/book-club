#!/usr/bin/env bash
# All non-E2E suites, in fresh processes and one package at a time.
set -euo pipefail
cd "$(dirname "$0")/.."
# No old-generation flag may reach a test fork. On Node 24 any process-wide old-space flag
# (NODE_OPTIONS or the command line) replaces the `resourceLimits` of every Worker the process
# starts, even one with `execArgv: []`: a Worker asking for 32 MiB got 280 MiB under
# --max-old-space-size=256. The server's work-limit tests depend on those limits
# (test/worker-limits.test.ts fails fast if they are overridden). Forks size their old generation
# from the runner's cgroup instead. Vitest hands none of its own flags to its forks, so capping the
# coordinator is safe. No resident package manager during the large fixtures.
#
# The runner's own processes take about 200 MB of the same cgroup, so no test file may come near
# 800 MB. Three settings that leave every app limit as it is keep the heaviest under ~650 MB:
# - two libuv threads: each sign-in checked against the 128 MB scrypt hash (N=2^17, r=8, also the
#   dummy hash for unknown emails) holds its memory on a pool thread, and the sign-in limit tests
#   fire them at once: 758 -> 507 MB for security.test.ts;
# - two glibc malloc arenas instead of eight per core: freed worker-thread memory goes back
#   instead of staying resident;
# - a 4 MiB semi-space for every isolate's young generation (the app's workers set only
#   old-generation limits, so this replaces none of them). These two: 815 -> 641 MB for
#   readalong-limits.test.ts, a 400,000-word transcript read and lined up in worker threads.
export UV_THREADPOOL_SIZE=2 MALLOC_ARENA_MAX=2 NODE_OPTIONS=--max-semi-space-size=4
run_suite() {
  local directory=$1 workers=$2; shift 2
  (cd "$directory" && node --max-old-space-size=128 ../../node_modules/vitest/vitest.mjs run \
    --pool=forks --maxWorkers="$workers" "$@")
}
run_suite packages/shared 2
run_suite packages/chat-core 2
run_suite packages/epub 1
run_suite apps/web 2
# The iOS app's own: the audio engine, and app.config.ts's updates and runtime version (D180),
# which run the real expo-updates resolver in a child process, one at a time.
run_suite apps/mobile 1
# Two capped CPUs need longer to construct/align the largest fixtures; their own event-loop
# assertions and the responsiveness project's serial group ordering remain unchanged.
run_suite apps/server 1 --testTimeout=90000
