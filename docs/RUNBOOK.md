# Runbook

## The stack

One container (`compose.yaml`, project `bookclubv2`) runs one Node process: the web app, the
API, the WebSocket and the media files on one origin. Its data is one directory (`/data`, the
`data` volume): `bookclub.db` (SQLite, WAL), `blobs/` (uploaded files, each content once),
`pubs/` (normalised EPUBs with their compressed copies), `derived/` (cover thumbnails, safe to
delete), `uploads/` (unfinished uploads, expired after a week).

```sh
docker compose up -d --build --wait   # build and start (the demo target, seeded)
docker compose logs -f app            # logs (pino JSON)
docker compose exec app bookclub ...  # the admin CLI (below)
docker compose down                   # stop (data kept); down -v deletes the data
```

The ports are published on 127.0.0.1 only: 47100 for Book Club, 47101 for the upstream identity stand-in
(D116). To reach them from a laptop, tunnel both:
`ssh -N -L 47100:127.0.0.1:47100 -L 47101:127.0.0.1:47101 <host>`, then <http://localhost:47100>.

The runtime image carries `ffmpeg` (D141), for media notes: a voice recording and a video are made
web-safe with it (AAC/m4a; H.264/AAC mp4 plus a poster frame), and its absence is checked once at
first use, not a setting. A voice note still works without it (served as its own bytes); a video
note is refused outright, with a reason, until the image is rebuilt with it.

### A real deployment

The deploy kit does all of this on one host, with HTTPS, daily backups, a speech recogniser for
reading along and a rehearsed restore: see [DEPLOY.md](DEPLOY.md) (`deploy/compose.yaml`,
`scripts/deploy-drill.sh`) and "Reading along" below. By hand, build the `runtime` target (no demo
data; with `TRANSCRIBER_MODEL` for the recogniser, without it for none) and give it a public
address behind a TLS proxy:

```yaml
services:
  app:
    build: { context: ., target: runtime, args: { TRANSCRIBER_MODEL: base.en } }
    environment:
      PUBLIC_ORIGIN: https://books.example.org   # links in invites and reset links; Secure cookies
      TRUST_PROXY: "uniquelocal"                  # the proxy's address: a container on this host's Docker network
    ports: ["127.0.0.1:47100:8080"]
    volumes: [data:/data]
```

Then create the first owner before sharing the address (otherwise the first visitor to `/setup`
becomes the owner):

```sh
docker compose exec -T app bookclub create-owner --email you@example.org --name You --club 'Our club' --password-stdin < ~/.bookclub-owner
```

### Reading along: the recogniser in the image

The deploy kit builds its image with a speech recogniser (`TRANSCRIBER_MODEL=base.en`): faster-whisper
with the packages locked by hash in `tools/align/requirements.txt`, on Debian's Python, and the
base.en model, fetched at build time and checked file by file against its SHA-256
(`tools/align/fetch_model.py`). The image sets `TRANSCRIBE_COMMAND` to it, so the server transcribes
each audiobook uploaded, one at a time, and lines it up with the book sentence by sentence: notes
between readers and listeners then open at their sentence, without the cross-format margin of a
chapter map (D46, D63). The recogniser runs as the server's own user, at the lowest priority
(`nice -n 19`), with no network (the model is a directory in the image and `--offline` forbids a
download), on ten-minute windows of each track (`--window`), and within the server's limits (above).

What it costs, measured on this host (docs/ALIGNMENT.md, "The recogniser in the deploy image"):

| | |
|---|---|
| image | 561 MB more unpacked (532 MB to 1.35 GB in `docker image ls`), 260 MB more to download |
| build | its stages build beside the app's: from scratch 58 s against 51 s here, plus 300 MB of wheels and model downloaded the first time (20 s here); added to an image already built, 64 s; later builds reuse its layers |
| CPU | base.en with 2 threads: 8× faster than the audio on one core's two hyperthreads (a 2-vCPU host), the 3-hour Alice in 22 minutes; 13× on two cores (a 4-vCPU host), 13 minutes |
| memory | about 1 GB while it runs (0.97 GB at most for the Alice chapters), nothing when idle |

Settings (`deploy/.env`; the build ones take effect with `up --build`):

- `BOOKCLUB_TRANSCRIBER_MODEL=` (empty): no recogniser in the image, which is then the plain
  `runtime` image, and nothing is transcribed; owners can still upload transcripts.
- `BOOKCLUB_TRANSCRIBE_COMMAND=` (empty): the recogniser stays in the image but never runs. Set to
  a command, that command runs instead (it is split on spaces, with "quotes" for one argument).
  Unset, the image's own runs. A deploy/.env from before this kit carried an empty line for it,
  which now turns transcription off: delete the line.
- `BOOKCLUB_TRANSCRIBER_THREADS`: 2 by default. On 4 vCPUs (two cores) 2 threads already run as
  fast as 4 (13.4× against 12.9×); more help only with more cores, and more threads than vCPUs
  run slower.
- `BOOKCLUB_TRANSCRIBER_MODEL=small.en`: 338 MB more, 2.5 to 2.7 times slower (Alice in an hour
  on 2 vCPUs), a little closer: 97.6 % of the words matched against 97.2 %, sentence starts
  within 0.56 s against 1.08 s at the 95th percentile.
- `BOOKCLUB_TRANSCRIBE_REMOTE_URL` and `BOOKCLUB_TRANSCRIBE_REMOTE_TOKEN`: a GPU recogniser
  elsewhere that takes each run when it answers (small.en on a GPU, the 3-hour Alice in under two
  minutes); this host's recogniser runs when it does not, or fails, or goes away midway. Set up in
  docs/GPU-TRANSCRIPTION.md.

### Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOST`, `PORT` | `127.0.0.1`, `47100` (`0.0.0.0:8080` in the image) | where to listen |
| `DATA_DIR` | `.data` (`/data` in the image) | everything the app keeps |
| `PUBLIC_ORIGIN` | the request's origin | the address friends use; https makes cookies Secure |
| `ALLOWED_ORIGINS` | none | extra origins allowed to make state-changing requests |
| `TRUST_PROXY` | `false` | which proxies may report the client's address and scheme (`X-Forwarded-*`): their addresses, ranges or `loopback` / `uniquelocal` / `linklocal`. Never every hop: a client could then choose its own address and walk past the sign-in limits |
| `TRUST_PROXY_KEY` | unset | a secret (32 characters or more) the trusted proxy sends in `X-Bookclub-Proxy-Key`; when set, a request's `X-Forwarded-*` count only if it carries it, and the header goes no further. Set it wherever other people have accounts on the host: Docker relays their connections to the app from the same address as the proxy's. The deploy kit's `BOOKCLUB_TRUST_PROXY_KEY`, which Caddy sends; nginx sends it from a root-only include (docs/DEPLOY.md). Needs `TRUST_PROXY` |
| `COOKIE_SECURE` | `auto` | force the session cookie's Secure flag on or off |
| `SESSION_DAYS` | `180` | sessions slide forward with use |
| `MAX_UPLOAD_BYTES` | 4 GiB | largest single file |
| `UPLOAD_EXPIRY_HOURS` | 168 | unfinished uploads are dropped after this |
| `SIGNIN_ATTEMPTS` | `10` | per 15 minutes, per address and email (5× that per address); also the upstream's codes that sign nobody in, per address, before the rest are not redeemed (D116) |
| `SCRYPT_LOG_N` | `17` | password hashing cost |
| `UPSTREAM_START_URL`, `UPSTREAM_EXCHANGE_URL`, `UPSTREAM_NAME` | unset | friends continue with an upstream account through its sign-in grant (client `book-club`; D14, D116). The sign-in and invite pages offer "Continue with `UPSTREAM_NAME`": the browser goes to `UPSTREAM_START_URL` with a state and a PKCE challenge (S256), the sign-in under way kept in a ten-minute cookie of this host's, and comes back to `/api/auth/upstream/callback` with a one-time code, which this server redeems at `UPSTREAM_EXCHANGE_URL` (JSON, 10 s, no redirects) for the person's id, name and verified address. Both http(s) addresses or neither: two, because the browser and the server may reach the upstream by different names (the demo stack's are the stand-in's published port and its compose name). The cookie adapter's `UPSTREAM_JWT_SECRET`, `UPSTREAM_JWT_ISSUER`, `UPSTREAM_JWT_AUDIENCE`, `UPSTREAM_COOKIE` and `UPSTREAM_LOGIN_URL` are gone: with any of them set, the server will not start. A session here, once started, stands on its own (an account deactivated upstream keeps its open sessions until an owner removes it); signing out here signs out here only, and Continue brings the person back through the upstream, without a form while they are signed in there. An upstream account joins clubs by invite before it can start one. Local accounts keep working beside it |
| `TRANSCRIBE_COMMAND` | unset; in an image built with a recogniser (the deploy kit's), that recogniser | a speech recogniser run on each new audiobook for reading along (D46): it is given `--out FILE` and the track files and writes a `bookclub-transcript/1` document (tools/align/transcribe.py). An image built with `TRANSCRIBER_MODEL` carries one and sets this to `nice -n 19 /opt/align/venv/bin/python -I /opt/align/transcribe.py --model /opt/align/models/base.en --offline --threads 2` (below, "Reading along"); from source, `scripts/dev-stack.sh` points it at the venv of docs/ALIGNMENT.md when this host has it. Empty is off. It gets only PATH, HOME, the locale, TMPDIR, HF_HOME, XDG_CACHE_HOME and `TRANSCRIBE_*` from the environment (no secrets); one recogniser runs at a time, in a process group of its own (stopping it stops what it started), and is stopped at twice the audio's length (at least an hour). An audiobook gets two runs at most, counted across restarts (one more at a later start after a failure), and none once its owner removed its transcript; a run the server stops as it shuts down is given back, and shutting down never waits for the queue. A recogniser's transcript over 32 MiB, or with more words than the audio can hold (eight a second, plus 10,000), is refused, as an upload is; both are read and lined up in worker threads with time and memory limits (SA60). An owner uploads at most 10 transcripts an hour, one at a time (429 for a second at once); the server reads two at once (a third is told it is busy, 503, and tries again), and a transcript's body must arrive within the longer of 60 s and its length at 64 KiB/s (408 after). Every request must come in whole within ten minutes (D71). Limit its memory by wrapping the command (`prlimit`, `systemd-run --scope -p MemoryMax=`) or the container. Without it, the club owner uploads a transcript made elsewhere |
| `TRANSCRIBE_MAX_HOURS` | 100 | the longest audiobook, in hours, the recogniser reads by itself (War and Peace is 61 h): a run may take twice the audio's length, so a longer upload would hold every other audiobook's for days; its owner can still give it a transcript. A transcript the owner gives or removes while the recogniser reads that audiobook stops the run (D79) |
| `SEED_DEMO`, `DEMO_ASSETS` | off | seed the demo club from the books baked into the demo image |
| `LOG_LEVEL` | `info` | pino level |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | unset | voice channels and listening together (D153), self-hosted LiveKit. All three or none; voice is absent from the UI (`GET /api/livekit/config` says `enabled: false`) until they are all set. `LIVEKIT_URL` is the address the *browser* dials (its own wss or, in dev, `ws://127.0.0.1:<port>`); this server never connects to it, only mints tokens and verifies its optional webhook (docs/DEPLOY.md, "Voice and listening together") |

### Voice, chat and listening together

`scripts/dev-livekit.sh` runs a local LiveKit dev server (no TLS, a fixed demo key) alongside
`scripts/dev-stack.sh`: export the three `LIVEKIT_*` variables it prints before starting the dev
stack (or before `pnpm e2e`), and chat, voice channels and listening parties all work against it.
The Docker demo (`compose.yaml`) already runs its own dev LiveKit unconditionally — `docker
compose up` demos all three with no extra setup. Chat is plain REST plus the existing hub (no
LiveKit involved); only voice and listening-together need it.

### The admin CLI

```sh
bookclub create-owner --email E --name N (--password P | --password-stdin) [--club NAME]
                                                 # stdin: from a pipe or a file, never the command line
bookclub reset-link --email E [--origin URL]     # a one-time, 24-hour password reset link
bookclub backup [--out FILE]                     # SQLite snapshot (VACUUM INTO) + files, one .tar.gz
bookclub backup --set DIR [--keep N]             # incremental: a dated snapshot, pruned to the newest N (D125)
bookclub restore --from FILE [--force]           # single-file restore; stop the server first
bookclub restore --from-set DIR [--at TS] [--force]  # restore a set's newest snapshot, or its newest at/before TS
bookclub prune --set DIR [--keep N]              # prune an incremental set on its own
bookclub seed                                    # the demo club, into an empty database
bookclub deleted                                 # disbanded clubs and removed books, still recoverable (D179)
bookclub undelete (--club ID | --book ID)        # bring one back, as it was
bookclub purge (--club ID | --book ID)           # remove a disbanded club or a removed book for good, with its files
```

Owners can make reset links from the club settings for members whose every club they run;
for anyone else, use the CLI.

### Backups

`bookclub backup --set DIR` is safe while the server runs (a consistent SQLite snapshot plus the
stored files it needs; caches and unfinished uploads are left out) and bounded: each run copies
only the blobs and publication files its snapshot needs that are not already in the set, by
content hash, then prunes anything no kept snapshot still needs (D125, docs/DECISIONS.md). Keep
the set off the machine (rsync, a cloud drive, S3 — docs/DEPLOY.md "Offsite copy (S3)"):

```sh
docker compose exec app bookclub backup --set /data/backups --keep 14
docker compose cp app:/data/backups ./backups
```

Restore into a stopped stack: the chosen snapshot's database is unpacked and checked
(`PRAGMA integrity_check`) beside the data first, every blob and publication file it names must be
in the set, and the current data is replaced only if all of that holds.

```sh
docker compose stop app
docker compose run --rm app bookclub restore --from-set /data/backups --force
docker compose start app
```

A single, portable file (`backup --out` / `restore --from FILE`) still works exactly as before —
for a drill, or to carry one backup to a new host as one artifact (D127).

## Tests

| Command | What runs |
|---------|-----------|
| `pnpm test` | vitest in `packages/shared`, `packages/epub`, `apps/web` (jsdom), `apps/server` (real HTTP, sockets, SQLite and files in temp dirs) |
| `pnpm test:coverage` | the same with line coverage (text summary per package) |
| `pnpm typecheck`, `pnpm lint` | `tsc` per package; ESLint with type-checked rules, zero warnings allowed |
| `pnpm e2e` | Playwright against `BOOKCLUB_URL` (default `http://127.0.0.1:47100`): `chromium-desktop` and `webkit-iphone` (iPhone 15), 4 workers, no retries |
| `node e2e/lighthouse/run.mjs` | Lighthouse mobile on the demo club's library and reader pages |

The E2E suite needs the stack running with the demo club (it signs in as the demo owner to make
fresh clubs for each test), the Playwright browsers (`pnpm --filter @bookclub/e2e exec playwright
install chromium webkit`), and the LibriVox tracks (`scripts/fetch-librivox.sh`, copied out of the
demo container). Its 1 GiB upload fixtures are generated under `e2e/.tmp` and deleted by the
tests. `scripts/dev-stack.sh [port]` runs a faster stack from source (default port 47120); point
the suite at it with `BOOKCLUB_URL`.

### A failure is a regression only once it fails alone

Some tests keep a wall-clock budget (a note kept within 1.5 s offline, a listener shown within 2 s,
a party joined within the default timeout) or run axe while toasts are still settling. On a busy
host at 4 workers a full run can miss a few of these. A different few each time; on cole-pc
2026-11-02: `presence:62`, `live:235`, `offline:32`, `polish:122`, `moments:71`, `audio:168`,
`notes-further:46`, `polish15:334`, `polish16:97`. All passed again run alone. Before treating one as a
regression, run it alone (`--workers=1 --retries=0`), and repeat it (`--repeat-each=8`) if it
might be a race. Never run two suites against one stack at once: they share its clubs' server and
the checkout it was built from.

### Tests left out of the WebKit project

The WebKit iPhone project runs every test except those tagged `@chromium-only` (collected out
with `grepInvert`, so they are never "skipped"). Each is there for an engine limitation of the
test environment, not of the app:

| Test | Why it cannot run in Playwright's WebKit | What covers the same behaviour there |
|------|------------------------------------------|--------------------------------------|
| `audio.spec` "seeking uses HTTP range requests answered with 206" | Playwright's Linux WebKit plays media through GStreamer, which fetches a track whole, with no `Range` header (Safari on iOS does send ranges) | "tracks answer byte-range requests with 206, as iOS Safari asks for them" runs in both projects |
| `touch.spec` "a swipe turns the page, and the next tap still works" | Playwright can send a moving touch only through Chromium's DevTools protocol; in WebKit it can only tap | "a tap on the right of the page turns it…" runs with real touch in both projects |

## Troubleshooting

- **Image build fails downloading packages ("error (23)")**: this host's bridge network drops
  long downloads, so the build uses the host network (`build.network: host`) and BuildKit caches
  for the pnpm store (D36). Retry the build; cached layers make it quick.
- **A book stays "Preparing…"**: ingest runs one job at a time in the background; a restart
  re-queues interrupted ones. `docker compose logs app` shows `ingest failed` with the reason for
  a file that could not be read (it is shown on the book page too).
- **An audiobook does not read along yet**: with the recogniser in the image it is transcribed
  once it is ready, one audiobook at a time (the 3-hour Alice in some 20 minutes on two vCPUs), and
  lined up right after. `docker compose logs app | grep transcri` shows each run: `job done` with
  its time in ms, or `transcription failed` with the recogniser's last line. An audiobook gets two
  runs at most (D59); its owner can still upload a transcript.
- **Signed out everywhere unexpectedly**: a password change or a reset ends every other session,
  and their live connections, on purpose.
- **Disk**: identical uploads are stored once; deleting a book removes its files once nothing
  else uses them; orphaned files are swept hourly.
- **A phone with the app does not get a push**: check `docker compose logs app | grep -i apns`;
  `services/push.ts` logs `push to a device failed` with the error, never the key. First rule out
  the obvious: `APNS_*` unset (push is off by design; the in-app bell still works), the app not
  signed in yet at the time it tried to register (it retries on every foreground), or
  `BOOKCLUB_APNS_PRODUCTION` not matching the build's own `BOOKCLUB_APS_ENVIRONMENT`
  (`docs/DEPLOY.md`, "Push to the iOS app") — Apple answers `BadDeviceToken` for that mismatch,
  which the server already turns into forgetting the token, so a device stuck on the wrong
  environment simply has to reopen the app to register again once the mismatch is fixed.
- **Building or running the iOS app** (`apps/mobile`): needs Xcode, so it happens only on a build
  Mac (`apps/mobile/README.md`). On a shared one, `pgrep -x xcodebuild` first — every script there
  waits for another project's build to clear.
