# Contributing

Thanks for looking. Book Club was built for one small group of friends and is shared in case it is
useful to yours. Bug reports, fixes and focused improvements are welcome.

## Before you start

- For anything larger than a bug fix, open an issue first and say what you want to change and why,
  so nobody builds something that cannot be merged.
- Read [docs/INTENT.md](docs/INTENT.md) (what the app is for, and what it must never do) and
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Design choices are logged in
  [docs/DECISIONS.md](docs/DECISIONS.md) as numbered decisions (`D116`, ...), and code comments cite
  them; [docs/TRACEABILITY.md](docs/TRACEABILITY.md) maps each requirement to its code and tests.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Setting up

You need Node 24, pnpm 11 (`corepack enable` picks the version in `package.json`), Python 3 (for
the recogniser tools' tests), and Docker with Compose v2 for the demo stack and the end-to-end
suite.

```sh
pnpm install
pnpm test             # unit and integration tests: shared, epub, web, mobile, server
pnpm typecheck
pnpm lint             # typed ESLint; `pnpm lint:ci` is the fast oxlint pass CI runs on every PR
docker compose up -d --build --wait   # the demo stack on http://127.0.0.1:47100 (README.md)
pnpm e2e              # Playwright against it (BOOKCLUB_URL to point elsewhere)
scripts/dev-stack.sh  # or: the server from source with a built web app and the demo club, on 47120
```

More on running, seeding, backups and the read-along recogniser is in
[docs/RUNBOOK.md](docs/RUNBOOK.md).

## Making a change

- Keep a pull request to one concern, with the tests that prove it: unit or integration tests
  (Vitest) beside the code, and a Playwright test in `e2e/` for anything a person does in the app.
  Never skip, weaken or delete a test to make a change pass; if a test's expectation really
  changed, say why in the pull request.
- The spoiler gate is enforced by the server on every path (REST, WebSocket, media, search, Cal):
  a new way for data to reach a member needs the same gate and a test that a member who has not
  read that far cannot get it.
- There is no formatter to run (no Prettier). Match the surrounding style; `pnpm lint` must pass
  with no warnings.
- A choice someone might later ask "why?" about gets a short entry in `docs/DECISIONS.md` (the next
  free `D` number, with the alternatives rejected), and the code that depends on it cites it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  (`feat(web): ...`, `fix(server): ...`, `docs: ...`).

## What CI runs

`.github/workflows/check.yml`, on every pull request, on GitHub-hosted runners:

```sh
pnpm lint:ci
bash scripts/typecheck-ci.sh
bash scripts/test-ci.sh
node --test tools/ota-plan.test.mjs
python3 -I -m unittest discover -s tools/align -p 'test_*.py'
bash scripts/test-auto-deploy.sh      # Linux only (flock)
```

Typed lint (`node scripts/lint-daily.mjs`) runs daily rather than per pull request, and the browser
suite runs by hand (`.github/workflows/e2e.yml`: the demo stack and Playwright on a GitHub-hosted
runner). Workflow runs for pull requests from outside contributors start once a maintainer approves
them.

## Licence

By contributing, you agree that your contributions are licensed under the GNU AGPL v3.0
([LICENSE](LICENSE)), and you grant Cole Tebou a perpetual, irrevocable licence to also
distribute your contributions under other terms (so the project can be dual-licensed).
Sign off your commits (`git commit -s`) to certify the
[Developer Certificate of Origin](https://developercertificate.org/).
