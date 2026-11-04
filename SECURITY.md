# Security policy

Book Club holds things people expect to stay private: what a group of friends is reading, how far
each of them has got, and what they have said about it. Spoiler gating is a security boundary here,
not a UI nicety: a member must never receive a note, reply, reaction, chat message or media file
past the place they have actually read, on any path the data can take.

## Reporting a vulnerability

Please report it privately, through GitHub's private vulnerability reporting: open this
repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue,
pull request or discussion for anything that could be exploited.

A useful report says what you found, how to reproduce it (a request, a test, or steps in the demo
stack), and what it exposes or allows. You will get an acknowledgement within a week, and a fix or a
plan as soon as the problem is understood. Please give a reasonable amount of time to fix it before
you disclose it, and say whether you would like to be credited.

## What counts

In scope, for the latest commit on `master` (there are no release branches):

- the server (`apps/server`): authentication and sessions, club membership and invites, the
  spoiler gate (read ranges, D12/D13), uploads (tus) and ingest of untrusted EPUB/PDF/audio,
  media serving, the WebSocket hub, the Cal assistant's tools and its spend limits;
- the web app (`apps/web`) and its service worker, and the iOS shell (`apps/mobile`);
- the shared packages (`packages/shared`, `packages/epub`, which parses untrusted EPUBs);
- the deploy kit (`deploy/`) and the CI workflows (`.github/workflows/`).

Out of scope: denial of service by sheer volume, findings that need an already-compromised host or
owner account, the demo stack's fixed demo secrets (`compose.yaml`; it binds to loopback and says it
is not for real use), and issues in third-party services or dependencies with no Book Club-specific
impact (report those upstream; a dependency bump here is still welcome).

## How the project guards itself

- Every security review finding, its severity and its fix are recorded in
  [docs/REVIEW.md](docs/REVIEW.md) (the `SA` ids), next to the test that proves the fix.
- Pull requests are checked on GitHub-hosted runners only, with a read-only token and no secrets.
  Workflow runs from outside contributors wait for a maintainer's approval. The production deploy
  runs only for reviewed commits on `master`, in a protected `production` environment, through a
  forced-command SSH key that can do nothing but deploy a commit already on `master`
  ([docs/DEPLOY.md](docs/DEPLOY.md), "Checks and automatic deploys").
- No secret lives in this repository; deployments keep theirs in `deploy/.env` and in host-only
  files outside the clone.
