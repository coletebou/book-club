# Architecture

How Book Club v2 is put together and why each part is shaped the way it is. The reasons and the
alternatives that were rejected are in [DECISIONS.md](DECISIONS.md); what each requirement maps to
is in [TRACEABILITY.md](TRACEABILITY.md).

## 1. The shape of the system

```
 iPhone / desktop browser  (installed PWA)
   │  one origin, e.g. https://books.example.org  (locally http://127.0.0.1:47100)
   │
   ├── /                 React SPA + service worker (app shell, book cache, progress outbox)
   ├── /api/*            JSON REST, every body validated by shared zod schemas
   ├── /api/uploads/*    tus 1.0 resumable uploads
   ├── /media/*          auth-gated files: covers, EPUB resources, PDF, audio (Range / 206)
   └── /ws               WebSocket: presence, live positions, new comments, new books
          │
   ┌──────┴─────────────────────────────────────────────────────────────┐
   │ one Node 24 process (Fastify)                                       │
   │   auth · clubs · books/editions · progress · comments · media · ws  │
   │   ingest pipeline (EPUB normalise, PDF, audio tags) · backup CLI    │
   ├─────────────────────────────────────────────────────────────────────┤
   │ DATA_DIR/bookclub.db      SQLite (WAL) — all metadata               │
   │ DATA_DIR/blobs/…          original files (content checked, sha256)  │
   │ DATA_DIR/pubs/<edition>/… normalised EPUB publications              │
   │ DATA_DIR/uploads/…        in-flight tus uploads                     │
   │ DATA_DIR/derived/…        cover thumbnails                          │
   └─────────────────────────────────────────────────────────────────────┘
```

Everything is served from one origin by one process. That single choice removes v1's whole class of
cross-origin failures (CORP on covers, CORS on R2, cookie domains, a Range-forwarding proxy) and
makes deployment one container with one volume. Daily backup is an incremental, content-addressed
set, bounded to what is actually stored (D125); a single consistent SQLite-snapshot-plus-files
tarball still exists for drills and moving hosts (D127).

## 2. Repository layout

```
apps/server      Fastify server: config, db, routes, ws, ingest, CLI (seed, backup, restore)
apps/web         React SPA: pages, reader engines (EPUB paginator, PDF, audio), service worker
packages/shared  zod API schemas, timeline maths, read ranges, Range parsing, natural sort, constants
packages/chat-core  a group chat's app-free parts (D202): mentions, threads, the composer store; no dependencies
packages/epub    EPUB parsing (container, OPF, nav/NCX), path resolution, TOC↔spine matching,
                 XHTML sanitising/normalising, text measurement, boilerplate detection
e2e              Playwright suite (Chromium desktop + WebKit iPhone), fixtures, helpers
scripts          fixture builders, backup/restore/offsite drills
docs             INTENT, ARCHITECTURE, DECISIONS, TRACEABILITY, REVIEW, RUNBOOK
```

## 3. Domain model

A **club** is a private group. A **book** belongs to one club and is the thing the club reads. A
book has one or more **editions**, one per format the club has: an EPUB, a PDF, an audiobook (an
ordered list of tracks). Progress, comments and reactions belong to the *book*; each one also
remembers the edition and the native position it was made in.

```
users ─< memberships >─ clubs ─< books ─< editions ─< edition_files ─ blobs
                         │          │
                      invites       ├─< comments            (book timeline position + native anchor)
                                    └─< progress            (per user per book: position + read ranges)
sessions ─ users            imports ─< uploads             (tus uploads grouped into one edition)
```

Tables (SQLite, see `apps/server/src/db/migrations`):

| Table | Purpose |
|---|---|
| `users` | id, display name, email, scrypt password hash (local accounts) or upstream subject (upstream accounts) |
| `sessions` | sha256 of an opaque random token, user, expiry, last seen. Revocable. |
| `ended_sessions` | no longer written (D116): it kept ended sessions until their cookie would expire, so that a late request was not signed in again from the upstream's cookie (D52); what is left there goes as those cookies would have expired |
| `clubs`, `memberships` | club and its members with role `owner` or `member` |
| `invites` | unguessable invite codes per club, revocable/rotatable, use count |
| `password_resets` | owner-issued one-time reset tokens (hashed) |
| `books` | title, author, cover, the book timeline (canonical chapters) |
| `editions` | kind `epub`/`pdf`/`audio`, status, metadata, **sync map** onto the book timeline |
| `edition_files` | the files of an edition in order (one for EPUB/PDF, N tracks for audio) |
| `blobs` | stored files: size, mime, sha256 |
| `imports`, `uploads` | an upload session: the tus uploads that will become one edition |
| `progress` | per user per book: last position, read ranges, finished time |
| `comments` | text and/or reaction, book timeline position, native anchor, optional quote; a reply points at its note (D48) |
| `comment_media` | a note or reply's voice recording, 1-4 photos, or short video (D140): original and derived (web-safe) blobs, a video's poster frame, duration, dimensions, a voice note's transcript; `comment_id` starts null until the note is posted (`attachMedia`), so an unclaimed upload is swept up an hour later (`services/note-media-cleanup.ts`) |
| `notifications` | a friend answered your note or got to it, batched per friend per chapter while unread (D49, D145) |
| `reading_sessions` | your own history (D191): each sitting of reading or listening on one device in one edition, its times, time spent, where from and to, pages shown; only ever shown to its reader |
| `meeting_points` | a book's next stop: a place on the timeline, perhaps a day, who set it (D53) |
| `transcripts`, `readalong` | what a speech recogniser heard in each track, and the sentences lined up with the text (D46) |
| `transcriptions` | the server's own recogniser and each audiobook: runs begun, the last error, and whether the owner removed its transcript (so it is not made again) |

## 4. The shared timeline (one bar for every format)

The central idea. Every book has a timeline `t ∈ [0, 1]` from the first word of the story to the
last. Every edition has its own **linear measure** `m`:

| Edition | Native locator | Linear measure `m` |
|---|---|---|
| EPUB | `{section, offset}`: spine index + UTF-16 offset into that section's text | section start + offset (characters of story text) |
| PDF | `{page, y}`: zero-based page + vertical fraction | `page + y` |
| Audio | `{track, ms}` | track start + ms (milliseconds across all tracks) |

An edition's **sync map** is a list of tie points `(m_i, t_i)`, strictly increasing in `m` and
non-decreasing in `t`. `t(m)` is the piecewise-linear interpolation between tie points (clamped at
the ends) and `m(t)` is its inverse. All of this lives in `packages/shared/src/timeline` and is the
same code on server and client.

- The **reference edition** (the first one added to a book) defines the timeline: its map is linear
  from story start (`t = 0`) to story end (`t = 1`). For a Project Gutenberg EPUB the story range
  excludes the Gutenberg header and licence, so finishing chapter XII is 100 %.
- The book stores **canonical chapters**: title and `t_start`, from the reference edition's table of
  contents (EPUB nav/NCX, PDF outline) or its tracks (audio).
- Every later edition is **aligned** to the canonical chapters: audio tracks to chapters by count
  and by fuzzy title matching, with a manual override in the book settings. Each aligned chapter
  boundary becomes a tie point. Inside a chapter the map is linear in each format's own measure,
  which is accurate to a few percent of a chapter for narrated books.
- Forced alignment (speech recognition plus text alignment, stretch goal) replaces the chapter-level
  tie points of an audio edition with sentence-level ones. Nothing else changes.

Because positions, comments and read ranges are stored as `t` (plus the native locator they were
made at), a comment written on page 49 of the EPUB appears at the matching second of the audiobook,
a listener's marker sits at the right place on a reader's bar, and switching from listening to
reading opens the page that matches the audio position.

## 5. Read ranges and spoiler gating

What a member has **read** is the union of everything that has been on their screen or in their
ears, kept as a sorted list of disjoint `t` intervals (`packages/shared/src/timeline/ranges.ts`).

- EPUB / PDF: every time the reader settles on a page it reports the visible range. Consecutive
  pages touch, so turning pages extends one interval. A chapter chosen from the contents is a look
  (D58, D62): nothing is counted until you read on there, and then a new interval starts at the
  destination: the chapters you skipped stay unread.
- Audio: while playing, the player reports the span heard since its last report; a seek starts a
  new span at the seek target.

Reading is also kept per edition, in that edition's own measure (characters, pages or
milliseconds; `edition_progress`, migration 008), because formats placed on the timeline by a
chapter-level map disagree about where a passage is by up to tens of seconds of audio (D63). The
server releases a comment's text and quoted passage to a viewer only if the viewer wrote it, or
read its place in the edition it was made in, or, from another edition, read every place the
passage may really be: its mapped place give or take the margin between the two maps (60 s of a
chapter-aligned audiobook, one PDF page, 2,000 characters between EPUBs, or a tenth of the chapter
around the place where that is more; none where a trusted forced alignment holds), never past a
chapter start the two were matched at. Pieces of listening within two seconds of each other count
as one (a pause, D65). Otherwise the API returns a
**marker**: id, position, author, reaction emoji (the deliberate "spoiler-free sentiment"), nothing
else. The same rule applies to WebSocket pushes and to every listing. The UI cannot leak what the
client never received.

A member who arrives having read part of the book elsewhere can say so explicitly ("I've read up to
here") which adds `[0, here]` to their read ranges after a confirmation.

## 6. Reading engines (client)

### EPUB: server-normalised publication + own paginator

At ingest the server unzips the EPUB, parses `container.xml`, the OPF (metadata, manifest, spine),
the EPUB 3 nav or EPUB 2 NCX, and **normalises every spine document**: parse leniently, drop
`<script>`, event-handler attributes, `javascript:` URLs, remote resources and forms; add missing
`alt`; write explicit `width`/`height` on images (so layout never waits for an image); and serialise
clean, well-formed XHTML. It records each section's text length (the exact UTF-16 length of the
concatenated text nodes of `<body>`, the same walk the browser does) and resolves every table of
contents entry to `{section, offset}`, comparing **resolved absolute paths** rather than raw hrefs
(v1's TOC-versus-spine bug). The result is a `publication.json` manifest plus the normalised files
under `DATA_DIR/pubs/<edition>/`, served at `/media/editions/<edition>/epub/<path>` with a CSP that
forbids scripts.

The client paginator (`apps/web/src/reader/epub`) renders the current section, loaded from its
server URL, in a sandboxed iframe (`sandbox="allow-same-origin allow-scripts"`; the document's CSP has
no script source, so nothing in the book can run, while the app's own listeners work on iOS; see
D27), laid out with CSS multi-column: one column per page, column width equal to the page width. The iframe is as wide as all of its columns
and the paginator translates it, which also works with iOS Safari's habit of sizing iframes to
their content.

- **Pages in a section** = columns, measured from the laid-out document.
- **Book-wide pages** come from measuring every section at the current *layout signature* (page
  width × height, font size, line height, font family, margins) in a hidden iframe of identical size
  and styles, one section per idle slice. Counts are stored in IndexedDB per edition and signature,
  so a reload at the same settings shows the same numbers immediately. Changing the font size
  changes the signature and recomputes the counts from nothing, never appending to old ones (v1's
  `locations.generate()` concatenation doubled them).
- **Page X of Y** = pages of all earlier sections + page index in this section + 1. **Chapter page**
  is computed against the canonical chapter boundaries, which are measured too (a chapter may start
  inside a section). **Percent** is the timeline position, the same number friends see.
- **Keeping the passage on screen**: before a relayout the paginator records the locator of the
  first visible character; after relayout it opens the page that contains that character.
- Positions are text offsets, so they survive font changes, other devices and other fonts.
- Comment anchors are text ranges; highlights and margin markers are drawn in an overlay layer, so
  the text nodes (and therefore offsets) are never modified.

### PDF

pdf.js renders the current page to a canvas fitted to the viewport, with its text layer for
selection. The edition records page count and outline (for chapters) at ingest. Positions are
`{page, y}`; page numbers are the PDF's own.

### Audio

One `<audio>` element owned by an app-level controller, so playback continues while you browse the
club. Tracks play in order and the next track is loaded in the `ended` handler (which keeps iOS
background playback alive). Media Session metadata (chapter title, author, book, square cover
artwork in five sizes) and handlers (play, pause, seek backward 15 s, seek forward 30 s, seek to,
previous/next *chapter*) are registered once and read live state (`player/useMediaSession.ts`,
rules in `player/now-playing.ts`), and `setPositionState` is told the element's exact place on
every event that moves it (D190). Inside the iOS app the page also tells native the tracks it may
play on into, and when the sleep timer ends, so playback goes on while iOS has the page asleep
(D181).
Speed from 0.5× to 3× in 0.05 steps, with presets, a default on your profile and each book's own
last speed, kept per person by the server so it follows you to every device (D195); sleep timer, a
track list with chapter names (from tags, filenames, or the aligned EPUB chapters). Files are served with byte ranges (206) so seeking works anywhere.

## 7. Presence and live updates

`/ws` authenticates with the session cookie on upgrade and checks `Origin`. A client subscribes to
the clubs it is showing (membership checked) and, in the reader, reports `{book, t, format,
label}` at most four times per second. The server keeps presence in memory (one process) and
broadcasts deltas to subscribers of that club only. Heartbeats (20 s) drop dead phones; a hidden
page reports `idle`. Saved progress, new comments (gated per recipient) and new books are pushed
over the same socket, so a friend's marker moves on your bar within a second of their page turn.

## 8. Uploads and ingest

The browser uploads each file with **tus** (8 MiB chunks, unlimited retries with back-off, resume
fingerprints in localStorage). If the connection drops, the client asks the server for the current
offset and continues from there; after a reload, re-selecting the same files resumes them. The
server (`@tus/server` with a file store) authorises every request against the session and the
import it belongs to.

Before anything is uploaded, the browser reads metadata locally (EPUB OPF and cover, PDF info
dictionary and a rendering of page one, MP3/M4B tags and pictures, a cover image in the folder) and
pre-fills title, author, cover and the track order (natural filename sort, then tag track numbers;
reorderable). Finalising an import runs the authoritative server-side ingest: magic-byte checks,
EPUB normalisation, PDF page count and outline, audio durations and tags, cover thumbnails. If the
new edition looks like a book the club already has (normalised title and author), the UI offers to
add it as another format of that book, and the alignment of its chapters runs there.

A note's media (voice, photo, video, D140) does not use tus: it is tens of megabytes at most, so a
single bounded multipart request (`@fastify/multipart`, `POST /api/books/:bookId/media?kind=…`)
uploads, validates by content and processes it (sharp for a photo's resize and EXIF strip; ffmpeg
for voice and video, when the deploy has it) inline, before answering (D142). The response's id is
named in `mediaIds` when the note or reply is posted, which claims it inside the same transaction
that creates the comment (`services/note-media.ts`, `repos/comment-media.ts`).

## 9. Offline

The service worker precaches the app shell. API reads the reader needs (me, club, book, publication
manifest, comments, progress) are network-first with a cached fallback. Opening a book downloads its
edition into a per-edition Cache Storage bucket (or on demand via "Save for offline"), and media
requests are answered from it first. Progress made offline is written to an IndexedDB outbox and
flushed when the app is online again (on `online`, on focus, on an interval): positions are
last-writer-wins by the client timestamp, read ranges are unioned, so replaying a queue in any order
converges. Signing out clears every cache, the outbox and IndexedDB, and the response carries
`Clear-Site-Data`.

## 10. Identity

- **Standalone (default)**: people join only through a club invite link, choosing a display name,
  an email and a password (scrypt). The first owner is created by the setup screen on an empty
  instance or the `seed` / `create-owner` CLI. Owners can issue one-time reset links.
- **Upstream (the upstream's sign-in grant)**: with `UPSTREAM_START_URL` and `UPSTREAM_EXCHANGE_URL`
  configured, "Continue with the upstream" (`GET /api/auth/upstream`) keeps a state and a PKCE verifier
  in a ten-minute cookie of this host's and sends the browser to the upstream's start address with the
  state and the verifier's S256 challenge; the upstream signs the person in on its own pages and sends
  the browser back to `GET /api/auth/upstream/callback` with a one-time code, which the server
  redeems at the exchange address with the verifier for the person's id, name and verified
  address. The user is upserted by upstream subject and gets a normal local session; nothing of
  the upstream's (secret, cookie, session) is kept or shared, and signing out here simply signs out
  (D116). The demo stack runs a stand-in for the grant (`tools/fake-upstream`).
- Sessions are opaque random tokens stored hashed, in an `HttpOnly`, `SameSite=Lax` cookie
  (`Secure` behind HTTPS), sliding 180-day expiry so the installed iPhone app stays signed in.
- Every state-changing request must come from the app's own origin (checked against `Origin` /
  `Sec-Fetch-Site`).

## 11. Authorisation

One rule, applied in one place (`apps/server/src/auth/access.ts`): a user can touch a book, edition,
file, cover, comment, progress row, upload, import or presence channel only through a club they are
a member of. Resources in other clubs answer `404` (their existence is not revealed); missing
sessions answer `401`. Owners can rename the club, rotate invites, remove members and delete any
comment or book in their club; members can delete their own comments and books they added.

## 12. Media and caching

`/media/*` responses are `Cache-Control: private` (never `public`), `Cross-Origin-Resource-Policy:
same-origin`, `X-Content-Type-Options: nosniff`, strong `ETag`s, and support `Range`/`If-Range`
with `206` and `416`. Content is addressed by immutable edition ids, so `max-age` can be long for the
browser's private cache, and the service worker keeps per-book copies for offline reading. Covers are
resized server-side (sharp) into the sizes the UI requests, so the library page never downloads a
full-size scan.

A note's media (`/media/notes/:id/file`, `/poster`, D144) is the one exception: its gate is a
member's own *reading*, which moves by the minute, not their club membership, which does not — so
every request re-checks `services/gating.ts`'s `Gate.isOpen` live and answers `Cache-Control:
private, no-store`, never cached by the browser or the service worker. "Save offline" for a book
does not fetch any note's media for the same reason; its text and markers still work offline.

## 13. Security headers

A strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, …),
`Referrer-Policy: same-origin`, COOP, `Permissions-Policy`, and for EPUB documents a CSP with no
script source at all, on top of sanitising and the iframe sandbox.

## 14. Deployment

`compose.yaml` (project `bookclubv2`) runs one container from a multi-stage `Dockerfile`, published
on `127.0.0.1:47100` only, with one volume for `DATA_DIR`. The `demo` image target bakes in the
public-domain demo books (verified by checksum) and seeds a demo club on an empty volume.

**Backups** (D125-D129, `cli/backup.ts` and `cli/backup-set.ts`). Daily, the `backup` compose
service runs `bookclub backup --set DIR --keep N`: a dated, gzip'd `VACUUM INTO` SQLite snapshot
(checked with `PRAGMA integrity_check`) plus every blob and publication file it needs, each copied
once into a content-addressed store (`files/blobs/<sha256>`, `files/pubs/<sha256>`) shared by
every snapshot, then pruned to the newest `N`. `bookclub restore --from-set DIR [--at TS]` is as
strict as the single-file restore it sits beside: the snapshot's database is checked, every file
it names must be present, and only regular files land beside the data. `bookclub backup --out
FILE` / `restore --from FILE` (one tarball) still exist for a drill or a move to a new host. A
systemd timer (`deploy/offsite/bookclub-offsite-s3.*`) `aws s3 sync`s the incremental set to S3 as
a second, independent copy after the daily backup, without delete rights (D129). All three paths
— incremental set, single file, and S3 — are exercised by `scripts/deploy-drill.sh`. The runbook
has the single-host TLS recipe.

## 15. Testing

| Layer | Tooling | Real or fake |
|---|---|---|
| Unit | Vitest | pure functions: timeline, ranges, Range parsing, EPUB parsing and normalising, tags |
| Integration | Vitest + `app.inject` / real sockets | real SQLite file, real files on disk, real tus, real WebSocket |
| E2E | Playwright: `chromium-desktop`, `webkit-iphone` | the real Docker stack: server, database, storage, browsers |
| Quality | Lighthouse (mobile), axe-core | the real stack |

E2E tests create their own clubs and users through the real API and UI, use several browser
contexts for several people, and never stub the backend.

## 16. Cal (Callimachus): the club's native AI assistant

D160-D169 (docs/DECISIONS.md) have the reasoning and the alternatives; this is the shape.

```
apps/server/src/cal/
  store.ts            cal_* table repos (chunks, embeddings, shelf, conversations, settings, cost)
  extract.ts           EPUB/PDF/audio text -> ChunkAtom[] on the edition's own measure
  shelf-extract.ts     the same, for Cal's shelf (an upload or a fetched URL)
  indexer.ts            chunk -> embed -> store, resumable (cal_index_status)
  shelf.ts              shelf item ingest, same pipeline, no timeline place
  safe-fetch.ts         SSRF-safe fetch for a pasted shelf URL (D163)
  gating.ts             CalGate: reuses services/gating.ts's Gate.readSpans; series exclusion (D162)
  search.ts             hybrid search: FTS5 BM25 + vector-search.ts, fused by RRF, then CalGate
  vector-math.ts         brute-force cosine (pure); vector-search.ts picks inline vs. a worker thread
  embeddings/           OpenAI / Gemini / fake providers (D161)
  tools.ts               search_library, get_passage, whats_my_place (tool defs + handlers)
  anthropic.ts           runChatTurn: the streaming tool-use loop, citations, prompt caching
  fake-model.ts          deterministic stand-in for the E2E suite (CAL_TEST_FAKE_MODEL)
  voice/                 STT/TTS provider adapters + voice/pipeline.ts (same brain as text chat)
apps/server/src/routes/cal.ts         REST: conversations, settings, series, shelf, SSE chat
apps/server/src/routes/cal-voice.ts   /ws/cal/voice: push-to-talk / hands-free turns
apps/web/src/cal/                     CalLauncher (floating button, every signed-in page except
                                      the reader/player, which open the same panel from their own
                                      header, D170), calStore (the one shared open/close state),
                                      CalPanel (chat + shelf + settings), useCalVoice (mic + WS)
```

**Indexing.** Every ready book edition is chunked and embedded automatically (D164): EPUB text from
the normalised publication's own `bodyTextWithBreaks`, PDF text from its printed lines (D75's own
extraction), audiobook text from its read-along or raw transcript where one exists. A chunk's
`t_start`/`t_end` are the edition's own `m` positions (the chunk's atoms' native offsets) mapped
through its sync map — the same coordinate the spoiler gate reads positions through, so "has the
asker read this chunk" and "has the asker read this comment's place" are the same question asked
of the same data. Chunking is format-agnostic (D165): one pure chunker over "atoms" (a paragraph,
a printed line, a transcript sentence), ~420-token windows, ~90-token overlap.

**Hybrid search (D161).** `cal_chunks_fts` (FTS5, BM25) and `cal_embeddings` (float32 BLOBs, brute-
force cosine, `vector-search.ts`) each return a ranked candidate list; `packages/shared/src/cal/rrf.ts`
fuses them by reciprocal rank fusion. Cosine search runs inline for a small club and in a
persistent worker thread above `INLINE_THRESHOLD` (1,500 chunks) — the same "one long-lived
worker, reused, correlated by a request id" shape the track-reader and aligner workers already
use (`lib/worker-source.ts` bundles it from source in dev, `build.mjs` ships it as its own file in
production).

**Spoiler gating (D162).** `cal/gating.ts`'s `CalGate` is a thin, Cal-specific layer over
`services/gating.ts`'s existing `Gate`: a chunk is offered only if it falls entirely inside what the
asker has actually read (`Gate.readSpans`, the same spans the comment gate judges open/held/ahead
by), and a book that belongs to a series the asker has never opened at all is excluded from the
candidate set before search even runs on it. "Cal may use the whole series", a standing setting
chosen only in Cal's settings (the per-question "ask about the whole series" is gone since D183),
lifts both rules, scoped to that series only.

**Chat (D160, D166).** `cal/anthropic.ts`'s `runChatTurn` streams Claude's text as it is generated,
runs `search_library`/`get_passage`/`whats_my_place` as tool calls come in (Anthropic's server-side
`web_search` needs no handler at all), and up to `MAX_TOOL_TURNS` rounds before forcing an answer.
A `[[cite:CHUNK_ID]]` marker in the final text becomes a numbered citation, re-verified against the
spoiler gate and against the set of chunk ids actually offered this turn — a marker naming
anything else is dropped. Only the final text and citations are persisted per turn (D166); the
tool-call scaffolding is rebuilt fresh from a short plain-text history on every new message. The
system prompt's static persona block is `cache_control`-cached; the fixed tool list carries the
breakpoint that also caches it (tools render before system in the request).

**Voice (D167, D169).** `/ws/cal/voice` runs STT -> the same `runChatTurn` -> streaming TTS over one
WebSocket per conversation: push-to-talk or hands-free turns, `speakingStart`/`speakingEnd`
messages the client uses to pause an audiobook while Cal talks, and a `bargeIn` message that aborts
whatever is still being generated. Provider adapters (ElevenLabs, OpenAI, and a fake for tests) are
pluggable through config; `scripts/cal-voice-bench.ts` measures real latency to pick the default.

**Cal's shelf (D163).** A member can feed Cal a PDF/EPUB/TXT/MD upload or a URL beyond the club's
own books; URLs are fetched through an SSRF-safe fetch (hostname and every redirect resolved and
checked against private address ranges before connecting). Shelf chunks are indexed the same way a
book's are but carry no timeline place, so they are never spoiler-gated.

**Graceful absence.** Every Cal route 404s, and the web app never shows the launcher as enabled,
when `ANTHROPIC_API_KEY` is unset — a server without a key behaves as if Cal does not exist, not as
a broken feature.

## 16. Live chat, voice channels and listening together (D150-D159)

Three features, one wire: text chat, voice (self-hosted [LiveKit](https://livekit.io)) and a
shared audiobook "listening party", all delivered over the hub (`/ws`) presence already uses, or
plain REST where a request/response is the natural shape.

```
 chat (REST + hub push)         voice (LiveKit)                 listening together
 ───────────────────────        ───────────────────────         ───────────────────────────────
 POST /api/clubs/:id/chat   →   POST /api/livekit/token    →    POST /api/books/:id/party/start
 (persisted, chat_messages)     (mints a token for a room       POST .../party/control
                                 this server names)              (realtime/party.ts, in memory)
      │ hub.publish                   │ browser dials                    │ hub.publish
      ▼ chat:new / chat:updated       ▼ wss://rtc.<host>                 ▼ party:state
 every club subscriber           LiveKit (voice + the           every club subscriber projects
 (spoiler-gated like a note)     party's own voice room)        position locally, drift-corrects
```

- **Chat** (D150-D152) is a club-wide stream (`chat_messages`, migration 015), each message
  optionally tagged to a book. Creating, editing, deleting and reacting are ordinary REST, pushed
  to other members over the hub exactly as a comment already is; a message tagged to a book may
  carry a spoiler fence ("spoiler up to `<t>`"), judged by the very same `Gate` a note's spoiler
  rule uses (`services/gating.ts`), so one rule decides what a member may read everywhere in the
  app. Typing is the one thing sent client→server over the socket (`chat:typing`), never stored.
  @-mentions notify through the existing `notifications` table (a third `kind`, `mention`, D152),
  gated the same way when the message that named you is itself spoiler-fenced. Who a mention names
  is read by `@bookclub/chat-core`'s `findMentions` (D201), the one parser the server notifies by
  and the composer's autocomplete writes for; a message's view carries the spans it read. Replies
  (D200) sit in the stream with a quote of what they answer, gated by that message's own fence; a
  reply names its thread's root (`thread_id`, migration 022), so a thread reads on its own in one
  query (`GET /api/chat/:id/thread`).
- **Voice** (D153-D154) is one LiveKit room per club (`club:<clubId>`), tokens minted by
  `POST /api/livekit/token` only for a member of that club, for a room name the server built. Who
  is in voice, muted, deafened or speaking is each client's own report, relayed over the hub
  (`voice:join`/`leave`/`self` → `voice:update`) — not polled from LiveKit. LiveKit's webhook
  (optional) is only a backstop for a participant whose own socket has not noticed it left yet.
- **Listening together** (D155-D158) is one `PartyState` per `(club, book)`, owned by the server,
  kept in memory (`realtime/party.ts`) exactly as presence is: track, position, playing, rate and
  its own clock. Every member's local `<audio>` element is still the one actually playing (local,
  authenticated, byte-ranged — D157 is explicit that listening in a party saves your place through
  the very same path listening alone does); each client reconciles to the party's clock with pure,
  independently unit-tested math (`packages/shared/src/live/party.ts`): a drift past 0.75 s seeks,
  a smaller one nudges the rate. Voice for a party is the club's own LiveKit room: the audiobook
  ducks locally while someone else in the room is heard speaking, and never becomes a LiveKit
  track itself. Auto-pause on interruption (D158, optional, with a sensitivity) is a pure state
  machine (`packages/shared/src/live/autopause.ts`) fed each participant's own LiveKit
  active-speaker state over the hub (`party:speaking`) — it is sharply limited to that device's own
  claim about its own mic, since echo cancellation cannot remove a second device's speakers picked
  up by a third device's microphone; earbuds are the documented fix for that case.
- No new table backs voice or the party: both are ephemeral by nature (nobody expects either to
  survive a restart), so they live in memory like presence, by the design rule to use the
  smallest coordination primitive that satisfies the invariant rather than add a persistence layer
  with nothing to show for it.
- **Deployment** (D159): LiveKit runs self-hosted, next to the app, never a managed cloud service.
  Its signalling connection gets its own subdomain (`rtc.books.example.org`) so a CDN can be told
  that one name is DNS-only without touching the app's own proxied name; its real-time media (one
  TCP fallback port, one UDP mux port) cannot go through a reverse proxy at all and is the one
  place this kit publishes ports beyond loopback. See `docs/DEPLOY.md`, "Voice and listening
  together", for the exact ports and the generated config (`deploy/livekit/`).

## 16. The iOS app

`apps/mobile` (Expo SDK 58): a native shell around the web app itself, running inside a
`react-native-webview` at the same origin — the reader, the social layer, uploads and chat are the
web app, unchanged; nothing here reimplements them (D130-D139).

- **Audio** (D130-D132): `apps/web/src/player/native-bridge.ts` defines `NativeAudioElement`, an
  object shaped like `HTMLAudioElement` that `AudioProvider.tsx` uses instead of a real `<audio>`
  element whenever `window.BookClubNative` exists, so none of `AudioProvider`'s logic (places,
  looks, D70 catch-up, the sleep timer, read-along) has a second code path. Its commands reach
  `apps/mobile/src/audio/NativeAudioEngine.ts`, which drives a real `expo-audio` player (AVPlayer)
  and turns its status back into the same DOM events the browser's `<audio>` element would have
  fired. Lock-screen and Control Center controls are native end to end: a remote command acts on
  the player directly, and the resulting status update is all that needs forwarding.
  `navigator.mediaSession` is similarly stood in for (`NativeMediaSession`), so the existing
  lock-screen effects, which do nothing in a plain WKWebView, run unchanged and tell native what to
  show.
- **Auth for native playback** (D133): no signed URL, no manual header. `sharedCookiesEnabled` on
  the WebView keeps WKWebView's cookie store and `NSHTTPCookieStorage.sharedHTTPCookieStorage` in
  sync both ways; `AVURLAsset` and the app's own `fetch` calls consult that same store by default,
  so the session cookie set by signing in inside the page already authenticates native requests.
- **Offline reading** (D135): WKAppBoundDomains (a custom config plugin,
  `apps/mobile/plugins/with-app-bound-domains.ts`) makes the service worker (section 9) reliable
  inside WKWebView; `onShouldStartLoadWithRequest` sends anything outside the server's own host to
  Safari before a navigation there can fail.
- **Camera and microphone** (D136): `mediaCapturePermissionGrantType` plus the usual Info.plist
  usage strings, so `getUserMedia`/`MediaRecorder` work for voice notes, voice channels and talking
  to Cal — all built in the web app by other work, not reimplemented here.
- **Push** (D134): a raw APNs device token (`expo-notifications`' `getDevicePushTokenAsync`, not
  Expo's push service), registered at `/api/push/register`
  (`apps/server/src/routes/push.ts`, migration `014_push_tokens.sql`). The server
  (`apps/server/src/push/apns.ts`) holds its own HTTP/2 connection to Apple, authenticated with a
  provider JWT signed by the team's `.p8` key, and sends whenever it creates a notification
  (`services/notifications.ts`), in the bell's own words and to the bell's own link.
- **Offline audio** (D138): the currently-playing track downloads to `expo-file-system` the first
  time and plays from that local copy after; a library-wide "save for offline" for audio is not
  built (the web app's existing one only fills Cache Storage, which native playback does not read).
- Identity, authorisation, the API surface and spoiler gating (sections 5, 10-12) are exactly as
  the browser sees them: the WebView is a browser, as far as the server is concerned.

See `apps/mobile/README.md` for how the pieces fit together and how to build, run and archive it,
and `docs/DECISIONS.md` D130-D139 for why each was built the way it was.
