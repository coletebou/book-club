# Book Club

A private place for a handful of friends to read the same book together, mostly on their phones.
Some read the EPUB, some the PDF, some listen to the audiobook; everyone meets on one timeline. You
see where your friends are, live. Notes and reactions are pinned to the exact passage, and you meet
them when you get there: a friend who reads faster can never spoil the book for you.

It is one self-hosted web app (an installable PWA, with a thin iOS shell for background audio and
push), built for one small club and shared in case it is useful to yours. MIT licensed.

- **One timeline for every format.** A reader in the EPUB and a listener in the audiobook see each
  other in the same chapter, and a note made in one is met at the matching place in the other.
- **Reading along.** An audiobook is lined up with its text sentence by sentence (speech
  recognition plus text alignment, median error 0.11 s on the demo's LibriVox recording): the book
  marks the sentence being read and turns its pages with the narrator.
- **Spoiler-free by construction.** The server gates every note, reply, reaction, chat message,
  photo and voice clip by how far *you* have read, on every path the data can take. Until you get
  there, a friend's note is a marker, not its words.
- **Real pages.** Book-wide page numbers ("Page 82 of 180 · 11 of 17 in chapter · 46%") that stay
  put across reloads and are recomputed, never doubled, after a font change.
- **Together, live.** Presence and moving progress markers within a second; a club chat; voice
  channels and **listening together** (one shared playback the server keeps in sync) on a
  self-hosted LiveKit; "the next stop" a club agrees to read to.
- **Cal**, the club's own AI librarian (optional, off until you add a key): ask in text or by voice;
  he searches the club's books, cites what he finds, and never spoils past your place.

## Try it

One command, from a fresh clone (Docker with Compose v2):

```sh
docker compose up -d --build --wait
```

Then open <http://127.0.0.1:47100>. The demo seeds a club, "The Rabbit Hole Society", reading
*Alice's Adventures in Wonderland* as an EPUB, a PDF and the LibriVox audiobook (read-along
included), with four friends part-way through, a few notes, and a next stop at the end of chapter 6:

| Who | Email | Password |
|-----|-------|----------|
| Cole (owner) | `cole@demo.bookclub` | `wonderland-demo` |
| Ana | `ana@demo.bookclub` | `wonderland-demo` |
| Ben | `ben@demo.bookclub` | `wonderland-demo` |
| Cleo | `cleo@demo.bookclub` | `wonderland-demo` |

Sign in as two of them in two browsers (or a normal and a private window) to see presence, moving
markers and spoiler-free reactions. "Continue with Upstream ID" on the sign-in page goes through a
stand-in identity provider on 127.0.0.1:47101 (`dana@upstream.test`, `eli@upstream.test`, or any
name at `upstream.test`, password `upstream-demo`; `gus@upstream.test` is deactivated there, and
turned away), to show how friends who already have an account elsewhere join without making a new
one. Voice channels and listening together use the demo's own LiveKit on 127.0.0.1:47180. Cal in
the demo is a stand-in mind with his real spoiler gate, search and citations, so the demo needs no
API key and spends nothing.

Everything listens on 127.0.0.1 only; to open it from another machine, tunnel the ports
(`ssh -N -L 47100:127.0.0.1:47100 -L 47101:127.0.0.1:47101 -L 47180:127.0.0.1:47180 <host>`).
Stop it with `docker compose down` (add `-v` to delete its data).

## How it works

```
 phone / desktop browser (installed PWA)  ·  iOS app (a WebView shell: background audio, push)
   │  one origin: SPA + service worker, JSON API, tus uploads, auth-gated media (HTTP 206), /ws
   ▼
 one Node 24 process (Fastify) ── SQLite (WAL) + content-addressed files on one volume
   │   auth · clubs · books/editions · progress · notes · chat · media · live hub · Cal
   ├── ingest: EPUB normalised by its own engine, PDF, audiobook tags and covers, ffmpeg for media notes
   ├── read-along: a speech recogniser run as a separate low-priority process, then text alignment
   └── optional: self-hosted LiveKit (voice), APNs (push), Anthropic + embeddings (Cal)
```

- **One origin, one process.** The SPA, the API, the WebSocket and the media are served together,
  which removes a whole class of cross-origin failures and makes a deployment one container with
  one volume (D1).
- **A book is the thing a club reads; formats are editions of it** (D10). Every edition maps onto
  one book timeline `t ∈ [0, 1]` through its own sync map (D11), so progress, notes and presence
  are positions on the *book*, each remembering the edition and native position it was made in.
- **Read ranges, enforced by the server** (D12): what you have actually read (not jumped to)
  decides what you may see; jumping ahead to a friend's note is a visit that never moves your place.
- **Reading along** (D46, [docs/ALIGNMENT.md](docs/ALIGNMENT.md)): `tools/align/transcribe.py`
  (faster-whisper) writes every word it heard with its timing; the app normalises both sides
  (numbers and the Roman numerals of headings spelled out), finds runs of four words that occur
  once on each side as anchors, keeps the longest chain in order, aligns the words between them,
  and places each sentence of the EPUB at its first word heard. Tracks that do not match well
  enough are not trusted, and the audiobook falls back to following the book by chapters. A GPU
  box can take the recognition and hand it back
  ([docs/GPU-TRANSCRIPTION.md](docs/GPU-TRANSCRIPTION.md)).

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); every choice, with the alternatives rejected,
is in [docs/DECISIONS.md](docs/DECISIONS.md) (`D1`-`D198`, cited from the code), and what the app
is for (and must never do) in [docs/INTENT.md](docs/INTENT.md).

## Host your own

The deploy kit in [deploy/](deploy/) runs the app, HTTPS (Caddy, Let's Encrypt) and daily
incremental backups on one small Linux host:

```sh
cp deploy/.env.example deploy/.env    # your address and e-mail; every optional feature is listed there
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build --wait
```

[docs/DEPLOY.md](docs/DEPLOY.md) covers creating the owner, running behind a web server you already
have (nginx), voice (LiveKit), push to the iOS app, Cal, restoring, an offsite copy in S3, a full
backup-and-restore drill, and automatic deploys from CI. Day-to-day running, every setting and
the read-along recogniser are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Develop

Node 24, pnpm 11, Python 3 (the recogniser tools), Docker for the demo stack.

```sh
pnpm install
pnpm test             # unit and integration tests: shared, epub, web, mobile, server
pnpm typecheck && pnpm lint
scripts/dev-stack.sh  # the server from source with a built web app and the demo club, on 47120
pnpm e2e              # Playwright (desktop Chromium, WebKit iPhone) against the demo stack
```

The E2E suite also uploads the real LibriVox recording: `scripts/fetch-librivox.sh` copies it out
of the running demo container. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest, including what CI
runs.

| Path | What |
|------|------|
| `apps/server` | Fastify API, WebSocket hub, tus uploads, ingest, media, SQLite, CLI (seed, backup, restore) |
| `apps/web` | React app: library, reader (its own EPUB paginator, PDF), player, uploads, service worker |
| `apps/mobile` | iOS app (Expo): a native shell around `apps/web` in a WebView — see [apps/mobile/README.md](apps/mobile/README.md) |
| `packages/shared` | The book timeline, read ranges, locators, alignment, API contracts (zod) |
| `packages/epub` | EPUB parsing, sanitising and normalising (untrusted input) |
| `tools` | The speech recogniser and GPU service (`align/`), stand-in identity providers for the demo and tests, the iOS OTA planner |
| `e2e` | Playwright suite and Lighthouse runner |
| `deploy` | The single-host deploy kit |
| `fixtures` | Public-domain books (Project Gutenberg) and generated audio for the tests |
| `docs` | Intent, architecture, decisions, traceability, reviews, deploy, runbook |

## Project status

Book Club runs for real for one club, and is built and tested to the bar of software people rely on
(security reviews in [docs/REVIEW.md](docs/REVIEW.md), a requirement-to-test map in
[docs/TRACEABILITY.md](docs/TRACEABILITY.md)). It is a personal project, not a product: issues and
pull requests are welcome, but there is no roadmap or support promise.

## Security and licence

Report vulnerabilities privately: [SECURITY.md](SECURITY.md). The code is under the MIT License
([LICENSE](LICENSE)). The books and audio under `fixtures/` are public-domain texts (Project
Gutenberg) and generated media; the Apple and Google sign-in marks are their owners' and are used
as their sign-in guidelines describe.
