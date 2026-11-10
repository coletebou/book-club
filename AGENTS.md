# Book Club: guide for coding agents

A self-hosted web app (an installable PWA plus a thin Expo iOS shell) where a few friends read one
book together in EPUB, PDF or audiobook, on one shared timeline, with notes that can never spoil.
Humans start at [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md); this file is what an
agent needs on top of them. `CLAUDE.md` only imports this file. Edit this one.

## Read before changing behaviour

- [docs/INTENT.md](docs/INTENT.md) "What must never happen": the product's hard limits.
- [docs/DECISIONS.md](docs/DECISIONS.md): every design choice as `D<n>`, cited from code comments.
  When a comment cites one (`D46`), read that entry before changing the code. A new choice that
  someone might later ask "why?" about gets the next free number (after the last `## D<n>.`
  heading), with the alternatives rejected, and the code cites it.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/TRACEABILITY.md](docs/TRACEABILITY.md)
  (requirement → code → test). Keep its rows current when you add or move a requirement's test.

## Hard rules

- **The spoiler gate lives on the server, on every path**: REST, WebSocket, media, search, chat,
  push and Cal. A new way for data to reach a member gets the same gate and a test that a member
  who has not read that far cannot get it. Hiding something in the UI does not count.
- **Auth-gated media is never publicly cacheable**, and only club members see a club's books, files,
  progress or presence. `packages/epub` parses untrusted input: keep it sanitising.
- **`master` is production.** A merge to `master` deploys the live club (`deploy.yml`), and once that
  deploy finishes, `ota-update.yml` publishes the iOS app's JavaScript over the air. Work on a branch and merge
  through a PR. Never push to `master`, and never run `deploy/`, `scripts/deploy-drill.sh`
  or `pnpm --filter @bookclub/mobile update:*` unless the owner asks.
- **Public, AGPL repo.** No secrets, private hostnames or host-only config in commits. Sign off
  commits (`git commit -s`, DCO) and use Conventional Commits (`feat(server): …`).
- Never skip, weaken or delete a test to get green. Change one only when the intended behaviour
  changed, and say why in the PR.
- No formatter (no Prettier). Match the surrounding style.

## Where things are, and what a change can break

Workspace packages export TypeScript source (`"exports": "./src/index.ts"`), so there is no build
step between them. A package's typecheck and tests already exercise the shared code it imports.

| Package | Holds | Its changes can break |
|---|---|---|
| `packages/shared` | book timeline, read ranges, locators, alignment, zod API contracts | everything: epub, server, web, mobile, e2e |
| `packages/epub` | EPUB parse/sanitise/normalise | epub, server, web |
| `packages/chat-core` | chat model | chat-core, server, web |
| `apps/server` | Fastify API, WS hub, ingest, SQLite (`src/db/migrations/NNN_name.sql`, applied by `PRAGMA user_version`: add the next number, never edit a shipped one), CLI | server, e2e |
| `apps/web` | React SPA, reader, player, service worker | web, e2e (the mobile shell wraps it) |
| `apps/mobile` | Expo iOS WebView shell, audio engine | mobile |
| `tools/` | `align/` recogniser (Python), stand-in IdPs and agent, OTA planner | their own tests |

Server tests live in `apps/server/test/`. Everywhere else, tests sit beside the code (`*.test.ts(x)`).

## Checks: run what your diff can break, and let CI run the rest

Run inside the package (`cd <package>`, or `pnpm --filter @bookclub/<name> exec …`):

```sh
node ../../node_modules/vitest/vitest.mjs run test/auth.test.ts         # named test files
node ../../node_modules/vitest/vitest.mjs related --run src/foo.ts      # tests that import these files
pnpm --filter @bookclub/<name> run typecheck                             # one package
pnpm exec oxlint <files>                                                 # CI's lint, on your files
```

- `related` follows imports across packages, but anything imported through
  `@bookclub/shared`'s index pulls in most of the dependent package's tests. For a `shared` change,
  run `related` in `shared` plus the typecheck of each dependent that uses the changed export.
- **The full gate is CI's job.** `check.yml` (lint, every typecheck, every suite) runs on each PR,
  free, on GitHub-hosted runners. Pushing a branch runs nothing: open a draft PR or
  `gh workflow run check.yml --ref <branch>`. Playwright: `gh workflow run e2e.yml --ref <branch>
  -f grep='<title pattern>'`. Watch with `gh run watch <id> --exit-status`, and read only the failures:
  `gh run view <id> --log-failed`.
- Run the whole thing locally only for cross-cutting changes (lockfile, `tsconfig.base.json`, lint
  config, `patches/`) or when asked. Then use CI's memory-capped scripts, one at a time:
  `bash scripts/typecheck-ci.sh`, `bash scripts/test-ci.sh`. Never use bare `pnpm test` or `pnpm typecheck`,
  which run everything at once with no caps.
- Known traps: never put `--max-old-space-size` in `NODE_OPTIONS` for tests (it overrides the
  server's Worker limits and `worker-limits.test.ts` fails on purpose). `readalong-limits` "keeps
  answering throughout" flakes under machine load, so rerun it alone before believing it. On macOS
  with Homebrew Python, `tools/align` service tests can time out in `socket.getfqdn`; Linux CI
  is authoritative for them. Tests run in a pinned zone (D225: New York for web and shared, UTC
  for the server), not your machine's; `BOOKCLUB_TEST_TZ=<zone>` runs them in another.

## Running it

| What | How | Port |
|---|---|---|
| Demo stack (Docker) | `docker compose up -d --build --wait` | 47100 app, 47101 stand-in IdP, 47180 LiveKit |
| Server from source | `scripts/dev-stack.sh [port]` | 47120 |
| E2E against a stack | `pnpm e2e` (`BOOKCLUB_URL` to point elsewhere) | — |

- `dev-stack.sh` does not watch for changes: restart it after any server or web change. Its `stop`
  finds the process with `ss` (Linux only). On macOS, kill the listener on your port with
  `lsof -ti tcp:<port> -sTCP:LISTEN`, after checking that the process belongs to your checkout.
- Demo sign-ins are in the README. Cal runs as a stand-in in the demo and needs no API key.
- Native iOS builds (`expo prebuild`, Xcode) are slow and heavy. Do them only when native code or
  `app.config.ts` changes; see [apps/mobile/README.md](apps/mobile/README.md).

## Working alongside other agents

- Several sessions may share one clone. Work in your own worktree under `.claude/worktrees/`
  (ignored by git and Docker), never on another session's branch.
- Commit small, one concern per PR, with the tests that prove it.
