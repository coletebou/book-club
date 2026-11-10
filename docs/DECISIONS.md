# Decisions

Each major choice, the alternatives considered and why they lost. Newest entries are appended at the
end; superseded entries are marked, not deleted. Format: **Decision** · Context · Alternatives
rejected · Consequences.

---

## D1. One origin, one process: SPA, API, WebSocket and media served together

**Decision.** A single Node process serves the SPA, `/api`, `/ws`, `/media` and tus uploads from one
origin.

**Context.** v1 split the app across Cloudflare Pages, an API on a VPS, R2 and Atlas. Most of its
production bugs were seams between them: covers blocked by CORP across subdomains, audio that could
not seek until Range was forwarded through a proxy, cookie-domain and redirect-loop fixes, and a
deploy that depended on a private network reaching the API host.

**Rejected.** *Static host + API + object store (v1)*: four providers, CORS/CORP/cookie seams,
public-cache leaks. *Microservices*: nonsense for ten users. *Serverless functions*: WebSocket
presence and long uploads fit badly, and cold starts hurt "instant".

**Consequences.** One container, one volume, one TLS name. No CORS at all. Horizontal scaling is not
a goal (presence is in memory); a single small VPS serves a club of ten many times over.

## D2. TypeScript on Node 24 for server and client

**Decision.** TypeScript everywhere, Node 24 LTS on the server.

**Rejected.** *Go*: a lovely single binary, but the timeline maths, schemas and EPUB rules would be
written twice and could drift between client and server (positions must agree exactly). *Elixir /
Phoenix*: Presence is built in, but a second language for a small project. *Bun / Deno*: v1 used Bun;
Node 24 is the boring, long-supported choice and has a built-in SQLite driver.

**Consequences.** `packages/shared` and `packages/epub` run unchanged on both sides, and the server
recomputes every timeline position from its locator with the same code the client used.

## D3. Fastify for HTTP

**Decision.** Fastify 5 with zod schemas, `@fastify/websocket`, `@fastify/cookie`, `@fastify/static`.

**Rejected.** *Express 5*: slower, weaker typing, no first-class `inject` for tests. *Hono*: great
typed client, but tus and raw streaming need the underlying Node request anyway, and WebSocket on
Node is an add-on. *Plain `node:http`*: too much hand-rolled plumbing.

**Consequences.** `app.inject()` gives fast, real integration tests of every route without opening a
port; hooks give one place for auth, origin checks and security headers.

## D4. REST + shared zod contracts instead of tRPC

**Decision.** Resource-shaped JSON endpoints whose request and response bodies are zod schemas in
`packages/shared`; a small typed client in the web app.

**Rejected.** *tRPC (v1)*: couples client builds to server types, hides URLs (harder to cache in the
service worker and to test with plain HTTP), batch requests complicate offline caching. *GraphQL*:
overkill.

**Consequences.** Every GET the reader needs offline is a stable URL the service worker can cache;
E2E helpers and integration tests use plain `fetch`.

## D5. SQLite through `node:sqlite`

**Decision.** One SQLite database in WAL mode via Node's built-in `node:sqlite`, raw SQL in small
typed repositories, numbered SQL migrations tracked with `PRAGMA user_version`.

**Rejected.** *MongoDB Atlas (v1)*: an external service, network latency, and no transactions where
we need them (read-range merges). *Postgres*: a second container to run and back up for ten users.
*better-sqlite3*: excellent, but a native module to compile in Docker and CI; `node:sqlite` (SQLite
3.51 in Node 24.15) has the same synchronous model and an online `backup()`. *An ORM (Drizzle,
Prisma)*: more machinery than ten tables need, and harder to reason about exact SQL.

**Consequences.** Backup is a consistent snapshot of one file. If `node:sqlite` ever regresses, the
repository layer is the only place to swap in better-sqlite3 (near-identical API).

## D6. Files on the local filesystem behind a small blob-store interface

**Decision.** Originals in `DATA_DIR/blobs`, normalised EPUBs in `DATA_DIR/pubs`, derived images in
`DATA_DIR/derived`, all on the same volume as the database.

**Rejected.** *R2/S3 with presigned URLs (v1)*: CORS, presigned-URL expiry, public-cache mistakes,
and a separate service to back up. *MinIO in compose*: an S3 API with none of S3's benefits on one
host. *Blobs in SQLite*: bloats the database and every backup.

**Consequences.** Range requests are served straight from disk. The `BlobStore` interface keeps an
S3 driver possible later.

## D7. tus for resumable uploads

**Decision.** tus 1.0 (`@tus/server` + `@tus/file-store`, `tus-js-client`), 8 MiB chunks, unlimited
retries with back-off, resume fingerprints in localStorage.

**Rejected.** *Single PUT per file (v1)*: a 1 GB folder on hotel Wi-Fi starts over on every drop.
*S3 multipart with presigned parts*: needs object storage (D6). *Home-made chunk protocol*: tus is a
small, open, well-tested protocol with maintained client and server; reinventing it buys nothing.

**Consequences.** An upload cut off at 600 MB continues at 600 MB, including after a reload once the
same files are re-selected. Partial uploads live in `DATA_DIR/uploads` and are expired after 7 days.

## D8. Our own EPUB engine: server-side normalisation + a CSS-columns paginator

**Decision.** The server parses and normalises EPUBs into a clean publication; the client renders
sections in a sandboxed iframe with CSS multi-column pagination that we own.

**Rejected.** *epub.js (v1)*: effectively unmaintained; its `locations` are 1024-character chunks,
not pages, and regenerating them concatenates (v1's doubled totals); v1 needed
`allowScriptedContent: true` and fuzzy TOC fixes. *foliate-js*: high quality but not packaged for
npm, and its progress is estimated from byte sizes, not laid-out pages. *Readium navigator*: large,
built for a different scale of problem.

**Consequences.** We control pagination (real pages, measured), anchors (text offsets that agree
byte for byte between server and client because both walk the same normalised XHTML), security (no
scripts ever run) and TOC resolution. The cost is an engine to maintain; it is covered by unit tests
of the pure parts and by E2E tests of the layout.

## D9. Real layout pages, measured per layout signature and cached

**Decision.** "Page X of Y" is computed from laid-out columns of every section at the current page
size and typography, measured in a hidden iframe, cached in IndexedDB per edition and layout
signature, and recomputed from scratch when the signature changes.

**Rejected.** *epub.js locations (v1)*: not pages, and doubled on regeneration. *Per-chapter pages
(v1 fallback)*: restart every chapter, not what Cole asked for. *Estimated pages from character
counts*: drift from what is on screen; "page 47" would not be a real page. *Publisher page-lists*:
rare in EPUBs, absent from Gutenberg.

**Consequences.** Like Apple Books: pages are personal to the device and settings, stable across
reloads, and correct after a font change. Shared positions use the timeline (D11), never page
numbers.

## D10. A club reads a book; formats are editions of it

**Decision.** `books` own `editions` (EPUB, PDF, audio). Progress, comments and reactions belong to
the book.

**Rejected.** *A book per file (v1)*: an audiobook and an EPUB of the same novel would be two books
with two discussions and two progress bars. *Merging only in the UI*: comments and progress would
still be split underneath.

**Consequences.** Uploading an audiobook offers to attach it to the matching book. The reader can
switch format and carry the position across.

## D11. A book timeline `t ∈ [0,1]` with per-edition sync maps

**Decision.** Every position is stored as a book timeline value `t` plus the native locator it was
made at. Each edition maps its linear measure to `t` through monotone tie points: linear for the
reference edition, chapter boundaries for the others, sentence-level after forced alignment.

**Rejected.** *Raw percentage per format*: 50 % of the audio is not 50 % of the text when the EPUB
has a licence appendix or a long preface; comments would land in the wrong place. *Per-format
progress only (v1)*: no shared bar. *Only forced alignment*: needs heavy speech recognition at
upload time and fails on books without a matching text; chapter alignment works immediately and is
upgraded later.

**Consequences.** The club bar, presence, comment placement, spoiler gating and format switching
all use one coordinate, computed by one piece of shared code.

## D12. Spoiler gating by read ranges, enforced by the server

**Decision.** The server keeps, per member and book, the union of the timeline intervals actually
displayed or heard, and returns a comment's text and quote only when its position is inside them
(or the viewer wrote it). Otherwise it returns a marker: position, author, reaction emoji.

**Rejected.** *Current position*: re-reading chapter 1 would hide everything again. *Furthest position
(high-water mark)*: one accidental tap on the last chapter in the TOC would reveal every comment in
the book. *Client-side hiding*: the text would still be in the response; one curious tap on
"inspect" ends the promise.

**Consequences.** Jumping ahead never reveals the skipped part. The visible page always counts as
read (you can see its text anyway). A member can deliberately mark "read up to here".

## D13. Reaction emoji are visible ahead of the reader; text never is

**Decision.** For a not-yet-reached comment, the marker shows who and which emoji (😱 😢 😡 😂 ❤️ 🤯,
v1's set) but not the text, not the quoted passage, and nothing for text-only comments except a
neutral dot.

**Rejected.** *Hide everything ahead*: loses v1's explicit "spoiler-free sentiment markers" design,
the anticipation Cole designed for. *Show text blurred*: still sent to the client.

## D14. Identity: invite-link accounts by default, an upstream-JWT adapter for the upstream identity provider

*Its upstream-JWT adapter is superseded by D116 (the upstream's sign-in grant); the invite-link accounts stand.*

**Decision.** Standalone mode creates accounts only through club invites (display name, email,
password with scrypt). An optional adapter trusts an upstream JWT cookie (v1's upstream `accessToken`,
HS256 with issuer and audience) and creates a local session from it.

**Rejected.** *Upstream JWT only (v1)*: the app could not run, or be tested, without the upstream.
*Magic links*: need SMTP, and on iOS the link opens in Safari, not in the home-screen app, which has
its own cookie jar. *Passkeys only*: ideal on iPhone but not testable in Playwright's WebKit and
awkward on shared devices; left as a later addition. *OAuth with Google/Apple*: another account,
another provider, exactly what Cole wanted to avoid.

**Consequences.** Nobody creates an account unless they are joining a club; with the adapter on,
nobody creates one at all. Password resets are owner-issued links (no email to configure).

## D15. Opaque database sessions, not JWTs

**Decision.** A random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie, stored as a sha256 hash,
180-day sliding expiry.

**Rejected.** *JWT sessions*: cannot be revoked (removing a member or "sign out everywhere" would not
take effect until expiry), and v1 passed a JWT in a WebSocket URL query string. *Short sessions*: the
home-screen app would keep asking people to sign in.

## D16. WebSocket presence, in memory

**Decision.** One `/ws` socket per tab; club subscriptions with membership checks; in-memory presence
with heartbeats; throttled position reports (≤ 4/s).

**Rejected.** *Server-Sent Events + POST*: workable, but presence is two-way chatter and WS is
simpler for it. *Socket.IO*: heavy and unnecessary. *Polling*: cannot meet "a friend's marker moves
within 2 seconds" cheaply. *Persisted presence*: presence is ephemeral by nature (v1 agreed).

## D17. React 19 + Vite, CSS modules over design tokens

**Decision.** React 19 SPA built with Vite, route-level code splitting, TanStack Query for server
state, plain CSS modules on top of a token sheet (dark greys, golds, blacks, whites).

**Rejected.** *Svelte/Solid/Preact*: smaller runtimes, but React's testing and accessibility tooling
are the most mature and the bundle cost is manageable with splitting (Lighthouse ≥ 85 on mobile is
the bar). *Tailwind*: fine, but tokens + CSS modules keep the reading surface's styles explicit.
*Next.js/SSR*: no SEO needs; a static shell is faster to cache for offline.

## D18. pdf.js for PDF

**Decision.** `pdfjs-dist`, lazy-loaded only when a PDF is opened or uploaded.

**Rejected.** *Browser's built-in PDF viewer in an iframe*: no hooks for position, comments or
presence, and iOS shows a single scrolled document. *Server-rendered page images*: heavy, loses
selectable text.

## D19. A hand-written service worker with per-book Cache Storage

**Decision.** `vite-plugin-pwa` in `injectManifest` mode: Workbox precaches the shell; our own fetch
handlers serve API reads network-first and media cache-first from per-edition caches.

**Rejected.** *Blobs in IndexedDB (v1)*: Range requests against blob URLs do not reach the service
worker and audio cannot stream from them; Cache Storage keeps real responses. *`generateSW`*:
not enough control over auth-sensitive caching.

## D20. Offline progress outbox; last-writer-wins positions, unioned read ranges

**Decision.** Progress written offline is queued in IndexedDB and replayed; the server takes the
newest position by client timestamp and unions read ranges.

**Rejected.** *Server receive time*: an old offline queue would overwrite a newer position from
another device. *Furthest position wins*: breaks re-reading. *Reject offline writes*: loses reading.

**Consequences.** Replays are idempotent and order-independent. Clock skew between a member's
devices can only reorder that member's own positions.

## D21. Outsiders get 404, anonymous requests get 401

**Decision.** Any book, file, cover, comment, progress, upload or presence channel outside your clubs
answers 404.

**Rejected.** *403*: confirms that the id exists.

## D22. Media is `Cache-Control: private` and cleared on sign-out

**Decision.** Auth-gated responses are never `public`; sign-out clears caches (Clear-Site-Data plus
explicit Cache Storage and IndexedDB deletion).

**Rejected.** *`public` (v1's original bug)*: a CDN or shared proxy could hand a club's files to
anyone. *`no-store`*: defeats offline reading and makes seeking re-download.

## D23. Password hashing with scrypt from `node:crypto`

**Decision.** scrypt (N = 2^17, r = 8, p = 1, 64-byte key, 16-byte salt), constant-time comparison,
parameters stored with the hash.

**Rejected.** *Argon2id*: marginally better, but a native dependency. *bcrypt*: 72-byte limit, native.

## D24. Docker Compose, one service, bound to 127.0.0.1

**Decision.** `compose.yaml` with project name `bookclubv2`, one `app` service, one named volume,
port `127.0.0.1:47100→8080`. Inside the container the server listens on all interfaces of the
container's own network namespace (required for publishing); on the host only loopback is published,
and the project uses its own bridge network.

**Rejected.** *`network_mode: host`*: less isolated on a shared box. *Running bare on the host*:
the "fresh clone, one command" goal wants a reproducible image.

## D25. Real-stack testing; no mocked backend

**Decision.** Integration tests use real SQLite files and real directories in temp folders; E2E
tests run against the Docker stack with several browser contexts; fixtures are public domain
(Gutenberg EPUB, LibriVox MP3s pinned by SHA-256) or generated (PDFs, synthetic tracks, the 1 GB
upload file, created and deleted per run).

**Rejected.** *Mocked repositories or HTTP*: hides exactly the integration bugs v1 shipped.

## D26. Gutenberg boilerplate is outside the story range

**Decision.** Sections Project Gutenberg marks as boilerplate (`pg-header`, `pg-footer`,
`.pg-boilerplate`, `*** START/END OF THE PROJECT GUTENBERG EBOOK`) and `linear="no"` spine items lie
outside the timeline's `[0, 1]`; they stay readable.

**Rejected.** *Whole-file percentages*: finishing Alice would read 88 %.

## D27. Book content: sanitised on ingest, CSP without scripts, sandboxed iframe with allow-scripts

**Decision.** Sections load from their server URL into an iframe with
`sandbox="allow-same-origin allow-scripts"`; every section is served with
`Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; …`
(no script source at all), after the server has removed scripts, event-handler attributes,
`javascript:` URLs, forms, plugins and remote resources.

**Context.** A spike (2026-10-23) showed that WebKit does not fire *parent-registered* event
listeners in an iframe sandboxed without `allow-scripts` (Chromium does), so taps, swipes, keys and
text selection would be dead on the iPhone. With `allow-scripts` and the CSP above, both engines fire
the parent's listeners while the book's own inline script, `onclick` and `onerror` never run.

**Rejected.** *Sandbox without `allow-scripts`*: no input on iOS. *A transparent input layer over
the iframe*: kills text selection, which is how you comment on a passage. *Blob URLs for sections*:
no response headers, so no CSP. *v1's `allowScriptedContent: true` with no sanitising*: any EPUB could
run script in the app's origin.

**Consequences.** Three layers (sanitiser, CSP, sandbox) and the first two each independently stop
script. The service worker caches the real responses, CSP header included, for offline reading.
The hidden frame that counts pages is sandboxed the same way: WebKit refuses to load a document
served by the service worker into a frame sandboxed without `allow-scripts` ("internal error"),
which left an offline book counting its pages forever (found by review round 2).

## D28. Book-wide pages count the story only, and relayouts keep the passage you navigated to

**Decision.** Page 1 is the page holding the story's first character (D26's story range): the
Gutenberg header, cover and licence still render but are not numbered. When a font, theme or window
change relays the book out, the reader stays on the page holding the anchor of the last real
navigation (a page turn, a jump, a link), not the first character of the previous page.

**Context.** Re-anchoring on "the first character currently on screen" drifts: each relayout lands
a few characters later, and three font toggles moved the reader most of a page. Numbering from the
start of the file made Alice "page 3" before a word of the story.

**Rejected.** *Numbering every spine item*: the licence becomes the last 12 pages of the book.
*Re-anchoring on the visible page*: drifts (see above).

## D29. Compressed delivery, with the work done ahead of time

**Decision.** The web build writes brotli (quality 11) and gzip (level 9) copies of every text asset
(`apps/web/scripts/precompress.mjs`); ingest writes the same copies next to each text file of an
EPUB, and a missing copy is made on first use and kept. `sendFile` negotiates `Accept-Encoding`,
sends the copy with `Content-Encoding`, `Vary: Accept-Encoding` and an ETag per encoding, and always
answers a `Range` request from the file itself. JSON answers of 1 KB or more are compressed on the
fly (brotli quality 5).

**Context.** The first Lighthouse mobile run scored performance 61: the 393 KB main script went out
uncompressed and first paint waited 3.5 s on simulated slow 4G. With compression (and D30) it
scores 95 to 97.

**Rejected.** *`@fastify/compress`*: compresses per request (CPU on every load of a static asset)
and does not distinguish range requests. *No compression behind a reverse proxy*: the stack must be
fast as one container (D24). *A CDN*: no external services, and the content is private.

**Consequences.** BREACH needs a cross-site page to read response sizes of credentialed requests;
the session cookie is `SameSite=Lax` and responses carry no secret next to attacker-controlled
text, so compressing API JSON is safe here.

## D30. The first download carries no schema library

**Decision.** The client never runs zod: the realtime client checks only that a frame is JSON with a
known `type` (the server's tests validate every message it sends against the shared schema), the
locator schemas live in `timeline/locator-schemas.ts` apart from the locator functions the reader
uses, and `@bookclub/shared` and `@bookclub/epub` declare `"sideEffects": false` so unused schema
modules drop out of the bundle.

**Context.** zod and the API schemas were a quarter of the main chunk (393 KB before, 289 KB after,
90 KB gzip).

**Rejected.** *Validating every frame with zod*: protects against our own server. *Loading the
validator lazily*: the first frames arrive before it.

## D31. Club-bar markers that are too close to tap become one group

**Decision.** Every target on the club bar is a 26 px square (WCAG 2.5.8 asks for 24) around its
mark, on two lanes that never overlap: friends on the line, reactions above it. Markers closer than
a target's width join one group (a stack of dots, or the first reaction with a count) placed at their
mean; tapping a group opens all of its notes in one sheet, spoiler-free for those ahead of you.
Tapping a single note you may read still takes you to its passage; tapping a note ahead of you never
moves you.

**Context.** Lighthouse flagged the 14 px dots and 18 px emoji; on an iPhone, four friends within a
few percent of each other were impossible to tap apart, and the reaction row overlapped the
chapter title.

**Rejected.** *One "who is where" button for the whole bar*: loses the at-a-glance reactions the v1
design was built around. *Bigger dots*: they overlap as soon as two friends read the same chapter.

## D32. Member colours are per-club slots, kept for as long as you stay

**Decision.** A membership row holds a palette slot, the first one no current member holds when you
join (migration 002 back-fills existing clubs in join order). Progress, presence and notes all use
it; a former member's notes keep a colour of their own (v1's hash of the user id).

**Context.** v1 hashed the user id into eight colours: four friends share a colour more often than
not (1 − 8·7·6·5/8⁴ ≈ 59 %), and on the club bar colour is how you tell friends apart.

**Rejected.** *Colour by position in the member list*: everyone after a leaver would change colour.
*More colours*: they stop being distinguishable on a dark background long before collisions stop.

## D33. Sign-up and invite previews are rate-limited per invite

**Decision.** Sign-in attempts are limited per IP and email; sign-up and invite previews per IP and
invite code, so a household behind one address can still join together.

**Rejected.** *Per IP only*: five friends on one Wi-Fi joining in the same minute would be refused.

## D34. A test may leave the WebKit project only for a documented engine limitation

**Decision.** The WebKit iPhone project runs every test except those tagged `@chromium-only`
(`grepInvert`, so they are not collected, rather than skipped). The one such test today asserts
that the browser itself seeks a track with `Range` requests answered by `206`: Playwright's Linux
WebKit plays media through GStreamer, which fetches the whole file with no `Range` header, unlike
Safari on iOS. A both-engine test checks the same server behaviour by making the range requests
directly. Every tag is listed with its reason in docs/RUNBOOK.md.

**Rejected.** *`test.skip` in WebKit*: counts as skipped, and hides the reason in code.

## D35. Lint: type-checked rules, `require-await` off

**Decision.** ESLint runs `recommendedTypeChecked` with zero warnings allowed, except
`@typescript-eslint/require-await`: Fastify hooks and handlers, tus callbacks and test helpers are
`async` by contract even when their body awaits nothing. `no-floating-promises` still catches the
dangerous case, a forgotten `await`.

**Rejected.** *ESLint `recommended` without type information*: it misses floating promises and
unsafe `any` flows, the bugs that matter most in code full of sockets and timers. *Satisfying
`require-await` by dropping `async`*: Fastify and tus treat a returned promise differently from a
plain return (a synchronous handler must call `reply.send` itself), so changing signatures to
please a lint rule would change behaviour. *Biome*: fast, but it has no type-aware rules.

## D36. The Docker build uses the host network and BuildKit caches

**Decision.** `compose.yaml` builds with `network: host`, and the Dockerfile mounts pnpm's store and
metadata caches (`--mount=type=cache`) and installs with `--prefer-offline`.

**Context.** On this shared host the bridge network drops long registry downloads (curl
"error (23)"); every rebuild re-downloading 700 MB also cost minutes.

**Rejected.** *Vendoring `node_modules` into the image context*: 500 MB of context and
platform-specific binaries (sharp, canvas) from the host.

## D37. Signing out forgets everything the device kept

**Decision.** Sign-out deletes every `bc-` cache and the IndexedDB stores from the page and tells
the service worker to do the same (`wipe`); the service worker also forgets everything by itself
whenever `/api/session` reports no user (a session that expired or was revoked elsewhere, or a sign
out in another tab).

**Context.** WebKit does not honour `Clear-Site-Data` for Cache Storage reliably; the E2E test that
signs out on a shared iPhone and signs in as someone else failed there until the service worker
forgot on its own.

**Rejected.** *`Clear-Site-Data` alone*: unreliable in WebKit (above), and it cannot reach the
device when the session ended somewhere else. *Keeping caches across sign-out for a faster next
sign-in*: on a shared phone the next person could open books and notes of a club they are not in.
*Per-person cache names without deleting*: the previous reader's books stay on a device they
handed over.

## D38. A dev stack next to the acceptance stack

**Decision.** `scripts/dev-stack.sh [port]` runs the server from source against a snapshot of the
built web app with its own data directory and a seeded demo club; acceptance runs use the Docker
stack (`docker compose up -d --build --wait`).

**Rejected.** *Iterating on the Docker image*: a two-minute rebuild per change. *Serving
`apps/web/dist` directly*: a rebuild would pull assets from under a running stack.

## D39. What a book's files are served as is decided by us, and every one carries a CSP

**Decision.** Ingest decides each file's served type: items of the reading order are always
sanitised XHTML; other files go by extension, and only documents, style sheets, pictures (SVG
sanitised like a page) and fonts are served at all. The media route answers every book file with a
CSP: pages get `default-src 'none'` with no script source; anything else is
`default-src 'none'; …; sandbox`, so even opened on its own it can run nothing. Types an older
ingest stored from the EPUB's manifest are ignored outside that served set.

**Context.** Review found that a reading-order item declared `text/html;charset=utf-8` skipped
the sanitiser (an exact `text/html` match was expected) and was served raw without the CSP: script
in the app's origin (REVIEW SA1).

**Rejected.** *Trusting the manifest's media types*: they are the uploader's words. *Stricter
string matching of declared types*: one more parameter or alias and the hole is back. *Dropping
SVGs with anything suspicious (the old regex)*: easy to slip past, and it lost pictures.

## D40. Every member can share the invite link; owners renew it

**Decision.** The club's invite link shows for every member, so "can you add my partner?" needs no
owner. Only owners can renew it; removing someone renews it automatically, so the removed person's
copy stops working.

**Rejected.** *Owner-only invites (round 1)*: friction for the common case among friends, and v1's
plan had the invite on the dashboard for the club. *Per-member invites with approval*: machinery a
handful of friends does not need.

## D41. Going somewhere is not reading there

**Decision.** Opening a link (`?at=`, a note's "Go to passage", a note tapped on the club bar, a
deep link) is a look: presence shows where you are, but your saved place does not move and the page
is not counted as read until you turn a page there (or press Play in the audiobook, or write a note
there). A "Back to …" chip returns you to where you were reading. The link's place is used once
and dropped from the address, so a reload opens where you read.

**Context.** Following a friend's earlier note moved "Continue reading" back to it, and every
reload returned to the link (REVIEW CQ3, FR4) — a lost position, which the brief lists among the
things that must never happen.

**Rejected.** *Treating every display as reading (round 1)*. *Asking "Move your place here?"*: one
more question on every visit.

## D42. Finished means the ending and nearly all of the rest

**Decision.** A member has finished a book once their read ranges reach its end and cover at least
90 % of the story (`FINISHED_COVERAGE`). Reaching the last page by reading asks the server, and the
card says either "You finished the book" or "You reached the end … read about N %", and how many
notes are still closed to you. Friends see your real place, with a Finished badge.

**Rejected.** *Touching the last page (round 1)*: jumping to the end "finished" the book, told you
every note was open (it was not) and labelled you Finished for good. *100 %*: one skipped page or a
device that never synced would keep you unfinished forever.

## D43. Touch input is read from pointer events, measured on screen

**Decision.** In the reader frame, taps and swipes are recognised from pointer events (WebKit sends
no `click` for a tap on plain text in a frame), the tap zone is measured on screen (a tap during a
page slide went the wrong way when measured in the frame's own coordinates), and the frame allows
only vertical panning and pinch (`touch-action: pan-y pinch-zoom`), so a horizontal swipe reaches us
instead of being cancelled. A click without a pointer gesture (assistive technology) still works.

**Rejected.** *Click handlers (round 1)*: dead on the iPhone. *Touch events*: no mouse or pen.

## D44. A shared device forgets the last person before the next one starts

**Decision.** Reading kept on the device (the outbox and saved places) is stamped with whose it is,
is never sent under anyone else's session, and is not kept at all while nobody is signed in. When
the signed-in person changes, or a session ends elsewhere (expired, reset, signed out on another
device), the player stops, the lock screen is cleared and every cache is wiped before the next
session's realtime and outbox start. Sign-out sends unsent reading first, refuses to pretend
offline (the session can only end on the server), and offers "Sign out anyway" when reading
cannot be sent.

**Context.** REVIEW SA3/SA5: an audiobook kept reporting after sign-out and the next person's
session sent it, merging the last listener's read ranges (and revealed notes) into theirs.

**Rejected.** *Discarding unsent reading at sign-out*: loses reading done offline, and a lost
position is one of the things that must never happen. *Sending it under whichever session is
current*: that was the bug. *One person per device*: friends do share an iPad.

## D45. A book belongs to one club; identical files are stored once

**Decision.** Each book lives in exactly one club, with that club's progress, notes and presence.
Someone in two clubs reading the same book uploads it to each (it takes seconds: the same file),
and the blob store keeps identical content once (matched by SHA-256 and size), deleting a file only
when no book refers to it any more.

**Context.** v1's model let a book belong to several clubs (`Book.clubIds`), but its comments and
progress were per book: two clubs reading one book would have seen each other's notes and
positions, which breaks the privacy of a club.

**Rejected.** *Books shared across clubs with per-club layers*: every query and push would need a
club scope beyond the book, for a case (one person in two clubs on the same book) that a second
upload covers. *Storing duplicates*: an audiobook folder twice is a gigabyte twice.

## D46. Sentence-level sync by forced alignment, with recognition outside the app

**Decision.** A speech recogniser (faster-whisper, `tools/align/transcribe.py`) writes what it
heard in each track with word timings; the app lines that up with the EPUB's own text measure by
unique-word anchors and small edit-distance alignments between them, times every sentence, and
refines the sync map of whichever edition the timeline does not rest on. The transcript is
uploaded by an owner, made by the server when `TRANSCRIBE_COMMAND` is set (its own job queue), or
shipped with the demo. Details and the measured error: docs/ALIGNMENT.md.

**Context.** Chapter-level sync is off by ten seconds at the median and by half a minute late in a
chapter (measured): a listener and a reader "in the same place" were a paragraph apart, and a
note made while listening appeared a paragraph early or late for readers.

**Rejected.** *Recognition inside the server image*: a gigabyte of models and Python for a feature
a small club uses once per book, and an hour of CPU on a small host; it stays optional and
pluggable. *Acoustic forced alignment (wav2vec2 CTC, Aeneas)*: more exact at the phoneme level,
but heavier, and sentence level is what reading along needs; the measured error is a tenth of a
second. *Aligning by duration (characters per second)*: narrators speed up and pause; that is the
chapter-level map's error inside a chapter. *A separate "read-along" timeline*: two coordinates
would drift; the one timeline (D11) simply gets more tie points.

**Consequences.** Everything that uses the timeline (the club bar, presence, notes, spoiler
gating, switching formats) gains sentence accuracy without changing. The EPUB reader marks the
narrated sentence and follows the narrator; the listen page shows the sentence being read.

## D47. When a sync map changes, what was placed with it moves, and nobody reads more than before

**Decision.** When forced alignment (or its removal) changes an edition's map, every note and
saved place made in that edition is placed again from its locator. Read ranges are kept per book,
not per format, so for members whose place is in that edition each range is replaced by the part
that both the old and the new map agree was read.

**Context.** A note made at 12:30 of track 3 must stay at 12:30 of track 3; its timeline value
changes. A listener's read range was recorded through the old map and may reach a little further
than what the new map says they heard.

**Rejected.** *Leaving read ranges as they are*: a listener could see a few notes on the passage
just ahead of them, which is the one thing the club must never do (D12). *Re-reading ranges
through the new map alone*: right for ranges heard, wrong for any part read in another format.
*Read ranges per format*: the exact answer, but a larger change for a case that only arises when a
transcript is added to an audiobook already in use (the demo and the normal flow align right after
upload). (Since D63, reading is kept per edition as well, and notes open from that; the merged
ranges still follow this rule for progress and the club bar.)

**Consequences.** At worst a listener has a few seconds of a passage they heard counted as unread
until they hear it again: a note there stays a marker a little longer.

## D48. Replies sit at their note's place, one level deep

**Decision.** A note can be answered (`POST /api/comments/:id/replies`). A reply copies its note's
position, so it is gated exactly like the note: a friend who has not got there sees markers, never
the words; you can only answer a note you can read; answering a reply answers its note (one level
of conversation). The note's author always reads the answers to it. A deleted note with replies
stays, without its words, for the conversation under it.

**Rejected.** *Replies with a position of their own* (where the replier was): a friend reading ahead
could answer a note with a spoiler for a later chapter, and it would show at the note's passage.
*Deep threads*: a handful of friends talk in a line, not a tree, and a tree is hard to read on a
phone. *Deleting the conversation with its note*: friends' words would go with someone else's.

**Consequences.** The book's note count, markers, the club bar and the moments count notes, not
replies; replies show under their note in the book page's discussion and in the reader's sheet.

## D49. Notifications for the two moments a friend's reading touches yours

**Decision.** In-app notifications, kept per person and pushed live over the WebSocket to their open
devices: someone answered your note (or a conversation you are in), and a friend got to your note
(the moment it opened for them; once per friend and note). A bell in the header lists them;
opening it marks them read.

**Rejected.** *Web Push*: it goes through Apple's and Google's push services, which the brief does
not allow, and it would need the words on a lock screen to be useful. *E-mail*: the app sends no
mail (D14). *Telling everyone about every note*: the club bar and the moments already show where
notes are; a notification is for what concerns you.

**Consequences.** A notification never carries anything its reader could not already read: the
reply's words go only to people in the conversation (who have read the note), and "got to your
note" carries no words at all.

## D50. A long book opens at its page at once; page numbers follow in time slices

**Decision.** The reader shows the saved page as soon as its section is laid out, and counts the
book's pages in a hidden frame afterwards, yielding to the reader every 40 ms of work rather than
before every section. Measured on *War and Peace* in docs/PERFORMANCE.md.

**Rejected.** *Waiting for the page count before showing anything*: ten seconds of nothing for a
long book. *Estimated page numbers while counting*: "page 1,334 of about 1,700" changes under the
reader's eyes, the thing v1's numbers did wrong. *Counting on the server*: pages depend on the
device's screen and fonts. *Prefetching sections for the counter*: measured slower; opening a book
already keeps its files on the device.

**Consequences.** A 4,000-page book is readable in about a second at the saved place; its exact
numbers come within seconds the first time and at once afterwards.

## D51. Deploying: Caddy in front, backups beside, a drill that restores

**Decision.** `deploy/compose.yaml` runs the app's `runtime` image with no published port, Caddy
in front of it (automatic HTTPS from Let's Encrypt, HSTS, WebSockets and uploads passed through),
and a backup service using the app's own `bookclub backup` on a timer with a retention count.
`scripts/deploy-drill.sh` rehearses it on one machine with Caddy's internal certificate authority,
down to deleting every volume and restoring.

**Rejected.** *nginx with certbot*: two programs and a renewal timer for what Caddy does alone.
*Cloudflare tunnels or a hosted platform*: an external account, and v1's fragile private-network
path was one of its lessons. *Volume snapshots instead of `bookclub backup`*: a copy of a live
SQLite file can be torn; `VACUUM INTO` is consistent. *Backups inside the data volume*: lost with it.

**Consequences.** One host, one command, one directory of archives to copy off the machine; the
restore path is exercised, not just written down.

## D52. Continuing with the upstream: v1's cookie flow, a way back out, and a stand-in to test it

*Superseded by D116: the upstream no longer shares its cookie, so the cookie flow, its hold and the
stand-in issuing v1's token are gone. The protections for upstream accounts stand.*

**Decision.** "Continue with the upstream" goes to `GET /api/auth/upstream?next=…` on this server. If
the browser already carries a valid upstream cookie, a local session starts and it goes on to
`next` (a same-app path only); if not, it is sent to the upstream sign-in page with `returnTo`
pointing back at that route, as v1's `redirectToLogin()` did with id.example.com. Back without a
usable identity (a deactivated account, cookies refused), the sign-in page says so rather than
sending the browser round again. Signing out here sets a `bc_upstream_hold` cookie when an
upstream cookie is present, so that cookie no longer signs this device in by itself; choosing
"Continue with the upstream" clears it. Ended sessions are remembered (`ended_sessions`, until their
cookie would have expired): a request already on its way with the session being signed out (the
page's socket is closed first, and the page asks who is signed in before the sign-out's answer
has cleared the cookie; seen in an E2E trace) gets no new session from the upstream cookie, and
sets the hold itself. The same holds every other device after "Sign out everywhere".
Hardening from the security review (REVIEW.md SA29 to SA36): the adapter needs the issuer and the
audience it accepts and a 32-character secret, and refuses tokens without an expiry; over HTTPS
the session cookie is `__Host-bc_session`, which a sibling subdomain of the shared cookie domain
cannot plant; only `/api/` requests start a session from the upstream cookie, at most 50 live
sessions per person; and an upstream account in no club cannot start one: as with local accounts,
a club lets you in first. The demo stack runs a stand-in for the upstream
(`tools/fake-upstream/server.mjs`, a sign-in form issuing v1's HS256 token with v1's claims, issuer
and audience), so the whole flow runs in both browsers on every
E2E run. On loopback, two ports of one host share cookies, standing in for v1's `.example.com`
cookie domain; the demo gives the cookie a name of its own rather than v1's `accessToken`,
because every app on Cole's `localhost` would share (and could overwrite) a cookie of that name.

**Rejected.** *A plain link to the upstream page (the first version)*: a friend already signed in
at the upstream made a pointless trip there, and a login address with its own query string got a second
`?`. *Ignoring sign-out (v1 had none)*: with the upstream cookie still there, "Sign out" signed the
person straight back in on the next request. *Signing out of the upstream too*: Book Club cannot end
another site's session, and on a phone the friend probably wants to stay signed in there. *Hiding
local sign-up when an upstream is configured*: a friend without an upstream account could not join.
*Letting any upstream account start clubs (v1 did)*: anyone with an account there could store books
here uninvited, which is open sign-up by another door (INTENT: invite-only is the feature).
*Testing only with tokens minted in the test*: proves the verifier, not the redirects, cookies and
pages a real browser goes through. *Running the stand-in only during tests*: the demo's button
would lead nowhere the rest of the time.

**Consequences.** A friend with an upstream account never makes an account here, can sign out here
and stay out, and gets back in with one tap. A real deployment serves Book Club on a subdomain of
the upstream's cookie domain (docs/DEPLOY.md).

## D53. The next stop: how far to read before talking it over

**Decision.** Stretch item 7 ("anything else that makes reading together more delightful"). Any
member can set the book's next stop: the end of a chapter (or the end of the book), and perhaps
a day ("The end of Chapter 6, by Sunday"). It is a place on the shared timeline, so it is the same
for readers and listeners: a gold flag on every club bar, a line on the library card ("1 of 3
there"), and on the book page who is there, how many chapters each has to go and, for you, about
how long that is reading the EPUB or listening to the audiobook (from the formats' own sync maps,
240 words a minute for reading). Turning the page past it greets you with who is there already.
One per book (`meeting_points`, migration 006); setting, moving or clearing it is live for
everyone through `book:changed`. Front matter a book's contents also list (a title page, an
edition note, the contents) is not a stop and does not count as a chapter.

**Rejected.** *A calendar with invitations and RSVPs*: the friends already have a way to agree
on an evening; what the app knows that a calendar does not is the book. *Per-person goals or
streaks*: pressure on the slower reader (INTENT). *A notification for every change*: a stop has no
note to point at, and the library and the bar show it at once. *Owners only*: the friends are
equals; anyone sets it, the page says who did.

**Consequences.** The club's oldest habit (read to here by Thursday) lives where the reading is,
gives nothing away, and tells a listener and a reader alike how far they have to go.

## D54. Chapters inside an audio file are its units

**Decision.** A file that marks chapters inside it (an M4B audiobook, an MP3 with ID3 chapter
frames) gives one unit per chapter, at its start in the edition's milliseconds, instead of one
unit for the file. Units are what the chapter matching lines up with the book's chapters and what
the player lists, so a single-file audiobook gets a chapter map as good as a folder of tracks and
a list of its chapters to go to.

**Rejected.** *Splitting the file into one file per chapter at upload*: re-encoding, or cutting
AAC at chapter marks, for nothing the player cannot do by seeking. *Keeping one unit per file*:
the whole book would sit on one linear stretch of the timeline, minutes off by the middle.

**Consequences.** The player's list shows chapters when there are more units than files; tapping
one plays its file from the chapter's start.

## D55. Arriving somewhere by listening is judged against the clock

**Decision.** The player greets you at the next stop (D53) when listening carries you past it:
between two moments of the player, playback got no further than the time that passed allows at
its speed (plus a second and a half for the element's update rhythm), and it was playing, or
paused only at a track's end while the next one loads. A seek, a track chosen from the list, or a
move while paused is a jump, never an arrival. The rule is a pure function with its own tests
(`apps/web/src/player/arrival.ts`).

**Rejected.** *A fixed step on the timeline* ("moved less than 1 % of the book"): the same step
is minutes of a long audiobook and a single update of a short track, so it misjudges one or the
other (it did, on the test audiobook's two-second tracks). *Only the end of a track*: it misses a
stop in the middle of one (a percentage). *The heard spans the player reports to the server*:
they close every five seconds, so the greeting would come late, after the moment.

**Consequences.** A phone that slept with the screen locked while playing still arrives (the
clock moved as far as the audio did). Arrival in the PDF is a page turn onto the page past the
stop, as in the EPUB.

## D56. A cover thumbnail's drawing is part of its name

**Decision.** How thumbnails are drawn has a version (`COVER_DRAWING`, now 2: a cover squarer
than 4:5 is shown whole on a blurred, darkened copy of itself instead of being cropped to 2:3).
It is in the cached file's name, the ETag and the cover URL that books carry, so a new drawing
reaches every browser.

**Rejected.** *Clearing the derived cache on upgrade*: browsers keep a cover URL for good
(`immutable`), so they would never ask again. *Hashing the rendered file into the URL*: building
a book's summary would mean rendering or reading its thumbnail. *Cropping to the centre, as
before*: almost all audiobook art is square, so a listen-only book lost its title on the shelf.

## D57. The book's end is a moment, deleting asks first

**Decision.** "You finished the book" is shown once per person, book and device, and once more on
finishing for real after reaching the end with parts skipped (kept in local storage; with none,
it shows). Pages after the story (a licence) never become your saved place. Deleting a note or a
reply, and clearing the club's next stop, ask first with the browser's own confirmation, which
says whose note goes ("Delete Ana’s note for everyone in the club?").

**Rejected.** *A server-side flag for the end card*: state on the server for a moment that
matters on one screen. *An undo toast instead of a confirmation*: deleting removes the note for
everyone at once (live), so an undo would mean soft-deleted notes that friends' screens show and
hide again. *A custom confirmation dialog*: more code than the native one, which is accessible
and works the same on an iPhone.

## D58. A chapter from the contents is a look, and friends see you where you read

**Decision.** Choosing a chapter from the contents, in the EPUB or the PDF, is a look (D41), like
following a link or visiting a friend's note: the reader shows the chapter with a "Back to" chip,
your saved place (and a listener's moment in the audiobook) stays, and reading on there (a page
turn) makes it your place, counting the page you looked at as read. Back returns to the very
character you left. During any look, friends' bars and presence keep showing you where you read,
not where you glance.

**Rejected.** *A jump, as before*: one curious tap moved your place for good, the audiobook's
too, told friends you were chapters ahead and counted you at the next stop. *A jump with a Back
chip*: the place would still be lost if you closed the app before pressing it. *Saving after a
while on the page*: a timer is guesswork about whether you are reading. *Showing a look as your
presence*: a glance at the last chapter would tell the club you are there.

**Consequences.** A note on the page you looked at opens when you read on from it. The tests that
used the contents to move now turn a page there.

## D59. The server's recogniser: two runs at most, never after the owner's no

**Decision.** With TRANSCRIBE_COMMAND set, each audiobook gets at most two runs of the recogniser,
counted as they begin and kept across restarts (migration 007), and none once its owner has
removed its transcript. A run the server stops as it shuts down is given back; shutting down never
waits for the queue. The recogniser runs alone, in a process group of its own, stopped as a group.

**Rejected.** *Retrying at every start* (as before): a file the recogniser cannot handle would run
for hours at each restart. *Never retrying*: a passing failure (memory, a cut-off model download,
a full disk) would be final. *Counting only failures*: a recogniser that brings the server down
would never count. *A memory limit set by the server*: speech libraries reserve large address
space, so it would break legitimate runs; the owner can wrap the command or limit the container.

## D60. Untrusted audio is read in a worker thread, against the clock

**Decision.** An audio file's tags, duration and chapters are read by music-metadata in a worker
thread (`ingest/track-worker.ts`, bundled beside the server as `dist/track-worker.mjs`), one worker
per edition with a 512 MB heap, under time limits: chapters are asked for only from MP4 files (the
only format whose chapter track the parser reads separately), for 20 s; a plain read gets 60 s plus
a second per 256 KB. A read that runs over is stopped and done again without chapters; one that
still runs over fails the edition with a clear message. At most 500 chapters per file and 2000
units per edition are kept.

**Rejected.** *Parsing on the main thread, as before*: one crafted file held the whole server for
seconds, at every restart. *A child process per file*: about as safe, slower to start, and more to
package. *A worker per file*: about 140 ms each to start. *A fixed time limit*: honest long VBR MP3s
take tens of seconds to measure. *Truncating units past the cap*: it would skew alignment; one unit
per file keeps the timeline right.

## D61. An alignment that cannot be judged is a straight line, or refused

**Decision.** Before trusting an alignment of an edition's units to the book's chapters, its pace is
checked on both sides: each stretch between matched units is measured in the book's timeline and
in the edition's own measure, short stretches are pooled until they reach 2 % of either side, and
the alignment is refused if any pooled stretch is more than four times faster or slower than the
median. A refused alignment falls back to a linear map. Fewer than two stretches to compare is a
straight line by construction, and kept.

**Rejected.** *Accepting what cannot be judged (as before)*: eleven chapters squeezed into the first
33 seconds of a ten-hour audiobook passed, and a listener 33 s in was shown every reader's notes up
to chapter 11. *Refusing every short alignment*: one- and two-chapter books would lose their map for
nothing.

## D62. A look ends where reading takes over

**Decision.** A look (D41, D58: a chapter from the contents, a link, a friend's note) ends in four
ways only: Back; "Read from here"; turning a page, or opening or writing a note, while looking
*ahead* of your place (that is reading on there); and, behind your place, reading forward through
it (you are back to reading where you were). Paging around behind your place, or writing a note
there, keeps the look: your place stays, friends still see you there, and Back returns to the
very character. Back and "Read from here" sit on the club bar, never over the page.

**Rejected.** *Any page turn ends a look* (D58 as first built): flipping back to find a passage
lost your place after one turn. *No page turn ends a look*: a friend who jumps to chapter 3 to
start reading there would read page after page without any of it counting, notes locked as she
read, and her place left behind. *A timer*: guesswork about whether someone is reading.

## D63. Across formats a note opens a little late, never early

**Decision.** Reading is kept per edition as well as merged, in each edition's own measure
(characters, pages, milliseconds; migration 008). A note opens for a member who read its place in
the edition it was made in, exactly; from any other edition, only once they have read every place
the passage may really be: where the maps put it, give or take the margin between the two maps
(60 s of a chapter-aligned audiobook, which covers the 44 s worst error measured against the real
narration; one PDF page; 2,000 characters between two EPUBs; and at least a tenth of the chapter
around the place, since a chapter map's error grows with the chapter: security review round 5
found a note opening two minutes early on half-hour chapters with a fixed minute), never past a
chapter start the editions were matched at, and with no margin where a trusted forced alignment
holds. Reading from
before the migration counts as from another format.

**Rejected.** *One merged list of timeline ranges, as before*: a listener met readers' notes 8 to
22 s before the narrator read them. *A margin on every comparison*: notes between two listeners of
one audiobook would open a minute late for nothing. *Guessing old reading's format from the last
edition used*: a member who switched formats would get the wrong one. *An uncapped margin*: a
chapter's first minute could never open. *Trusting a forced alignment everywhere*: tracks it did not
trust keep the chapter map's error.

*Bundling a speech recogniser in the image, on by default, to make every audiobook exact*: about
400 MB more image, a model fetched at build time, and an hour or more of a small host's CPU for each
audiobook; it stays opt-in (`TRANSCRIBE_COMMAND`, or a transcript the owner adds).

**Consequences.** On a club's own audiobook a reader's note reaches a listener a minute or two after
the narrator reads it (fidelity review round 7 measured 71 s with a minute's margin; on chapters of
20 minutes a tenth is two minutes), and is told as it opens; adding a transcript makes it exact.

## D64. On iOS the lock screen skips back and ahead; chapters change in the app

**Decision.** The player offers play, pause, stop, seeking and the skip-back and skip-ahead
actions (15 and 30 s) everywhere, and the previous and next chapter as tracks everywhere except on
an iPhone or iPad (`player/media.ts`). There, chapters change from the track list and the
chapter buttons in the app.

**Context.** iOS puts track buttons where the skip buttons go whenever a page offers both, and an
audiobook listener with the phone in a pocket wants the skips, as Apple's Books gives them; a
chapter is a tap away in the app. Fidelity review round 7 flagged the risk; it cannot be seen in
an emulator, so this follows Apple's documented behaviour of the remote command centre.

**Rejected.** *Both everywhere* (as before): on an iPhone the skips would likely never show.
*Skips only, everywhere*: headphones and car controls on Android and desktops have track buttons
that would then do nothing.

## D65. Listening paused and played on again is one stretch heard

**Decision.** Pieces of an audiobook heard within two seconds of each other join into one as they
are saved, and when the spoiler gate reads reading kept before this (`LISTENING_JOIN_MS`,
`services/gating.ts`). In text and PDF editions pieces still join only where they touch.

**Context.** WebKit resumes playback a few milliseconds past where it paused, so a listener who
paused and played on had two stretches saved, and the cross-format margin (D63) was taken off both
ends of each: around every pause a minute or more never counted as heard, and a reader's note
there never opened (fidelity review round 7).

**Rejected.** *No margin at the ends of a stretch*: the margin is what keeps the chapter map's
error from spoiling. *Joining anything closer than the smallest skip (15 s)*: a skip forward is
exactly what must not count as heard. *Saving the paused place as where Play resumes*: the browser,
not the app, decides where playback starts again.

## D66. EPUBs are read in a worker thread, against the clock

**Decision.** An uploaded EPUB is unpacked, parsed and sanitised in a worker thread (the one that
reads transcripts, `services/align-worker.ts`), with a minute plus a second per megabyte of the
file and a 1 GB heap. A book over either fails with "This EPUB is too large or too complex to
read."; an EPUB's own reason for refusing itself (DRM, no container) still reaches the member.

**Context.** Even with every parsing path linear (D68), crafted markup costs about a second per
MiB on the server's thread, and an archive may unpack to 200 times its size: a 100 KiB upload
could hold every request for 8 to 17 s. A heavy test book held the event loop 985 ms inline; read
in the worker, the longest stall is under 250 ms (`ingest.test` "EPUBs made to cost the server").

**Rejected.** *Tighter limits alone*: honest illustrated books are large, and the time is the
risk, not the size. *A child process*: as safe, slower to start, more to package. *A worker kept
alive for all books*: its memory would stay with it; one worker per book is freed with it.

## D67. Transcripts are read and lined up in worker threads, within limits

**Decision.** A transcript is parsed, checked and matched to the tracks in a worker (30 s,
512 MB), and the alignment runs in another (60 s, 768 MB). Before its body is read an upload must
come from the owner, give its length (411), weigh at most 32 MiB and hold no more words than eight
a second of the measured audio plus 10,000 (413); the server reads two at once (503, try again) and
an owner may send ten an hour (429). A transcript that ran out of its limits is not tried again
until a new one is kept.

**Context.** Security review round 5 (SA60): a crafted transcript held the server's thread for
seconds. War and Peace with a 61-hour transcript (15.8 MB) now reads in 1.0 s and aligns in 3.7 s
off the main thread; inline that was a 4 s stall.

**Rejected.** *64 MiB*: a 61-hour book's transcript is 16 MB. *A cap on words from the transcript's
own durations*: they are the uploader's claim; the server's measured durations are not. *A
long-lived worker pool*: one worker per task frees its memory after each. *Writing the words from a
worker too*: a second database writer for about 9 ms a megabyte, once per upload.

## D68. A book's documents are bounded, and read in linear time

**Decision.** In `packages/epub`: contents entries are matched to sections through maps built once
and capped at 10,000 (five times the server's 2,000 units, shallowest kept); one case-insensitive
index finds every file; documents nested deeper than 1,024 levels or holding over a million nodes
and attributes are refused; the tree walk is iterative; no style, `@import` or SVG-size pattern
backtracks; a spine longer than the archive's entry cap is refused; and the 200:1 compression
limit applies to the whole archive once it unpacks past 1 MiB. Documents the package wrote itself
are exempt, so books read before these limits keep their text.

**Context.** Security review round 5 (SA61, SA64): 50,000 dangling contents entries took 15 s,
2,000 nested NCX points 143 s, and a 2 KB file nested 140,000 deep overflowed the stack.

**Rejected.** *Flattening deep documents*: the parser's own cost per tag still grows with depth.
*A lower depth (256)*: sloppy tag soup in real books would be refused. *Truncating a long reading
order*: the end of the book would silently go. *A 2,000-entry contents cap*: a Bible-sized
contents (2,130 entries in a test) would be cut where the reader shows it whole.

## D70. A place saved on another device is your place on this one

**Decision.** When the club hears of a place of yours saved somewhere else while a reader or the
player is open here, it is your place here too: the EPUB reader keeps the page in front of you as
a look (D62), says "You read on to Chapter 8 · 67% on another device", and offers "Continue at
Chapter 8 · 67%" or "Stay here"; a paused player moves there. A place counts as from elsewhere
only if it is newer than the first one this screen heard of, differs from where this screen is,
and is none of the places this device saved or opened at (`lib/saved-here.ts`: the reader's pages
and the player's listening alike; another tab is another device).

**Context.** Fidelity review round 8: a phone left open at page 104 while the laptop read on to
67 % saved page 104 again at its next tap, and Ana's marker went back for everyone. Saved places
are last-writer-wins by the device's clock, so the stale device always won.

**Rejected.** *Refusing an older place on the server*: re-reading a chapter on purpose is moving
your place back, and the server cannot tell the two apart. *Jumping the phone there without a
word*: the page under your thumb would change while you read it. *A device id sent with every
save*: the same effect, a schema change in every format, and a tab still has to know its own.

## D71. Uploads must arrive in time, one transcript each at a time

**Decision.** Every request has ten minutes to come in whole (Fastify's `requestTimeout`; its
default is never). A transcript's body has its own deadline, the longer of 60 s and its length
at 64 KiB/s, after which it is answered 408 and its connection closed; each user holds at most one
of the two transcript places (a second upload of theirs is refused from its headers, 429), and a
place is given back exactly once, however the upload ends. A read-along that runs out of its time
or memory keeps the one it had and is tried once more half an hour later.

**Context.** Code and security review round 6 (SA76): two uploads that sent a byte and waited kept
every other transcript out for good, and SA74's justification ("Node ends a request after 300 s")
was wrong, since Fastify turns that off.

**Rejected.** *Node's 300 s*: shorter than a 32 MiB transcript's own deadline on slow Wi-Fi.
*`connectionTimeout`*: it would cut paused media and idle WebSockets. *A throughput check per
window*: more code, and no better against a client that trickles just fast enough. *Freeing the
place when the connection closes*: a client could send 32 MiB, hang up, and queue more bodies.
*Retrying a read-along with doubled limits, or until it succeeds*: a crafted transcript would keep
a worker busy for ever (SA60).

## D69. A note or reply also waits for where its writer had read to

**Decision.** A comment with words keeps a horizon (migration 010): the furthest its writer had
read, in the edition they read furthest in and in its own measure (their current edition for
reading kept only on the timeline), less the page they had on screen (2,000 EPUB characters, a PDF
page, a minute of listening), kept only when it is past the comment's place. Its words open once a
member has read both its place and its horizon, each judged as a note there: exactly in that
edition, with D63's margins from another. Until then a marker says where the writer was ("Cleo
replied from Chapter 9 · it opens when you get there") in the book, the sheet, live pushes and
notifications. You answer only a note you can read; the note's author reads its answers by her own
reading, like anyone. A reaction alone, or a deleted comment, has no horizon. This supersedes D48's
"the note's author always reads the answers to it".

**Context.** Fidelity review round 8 reproduced it: a reply copies its note's place (D48), so
Cleo, who had finished, answered Ana's chapter-1 note about chapter 9; Cole, in chapter 2, read it,
and so did Ana in a toast. A note written while paging back behind your place (D62) had the same
gap.

**Rejected.** *Ignoring the writer's reading (D48)*: the faster reader spoils through the
conversation itself. *A same-chapter exemption*: a chapter's end spoils its start. *Tap to
reveal*: the words would already be on the device (D12). *The furthest place exactly*: pages differ
by device, so ordinary laptop notes would wait up to 2.5 phone pages, held on the friend's own
page. *Requiring everything between note and horizon to be read*: a skipped page would hold an
answer with no visible reason. *Always the current edition*: reading furthest in another format
would be judged exactly there, up to a minute early.

**Consequences.** Measured on the Alice EPUB with War and Peace's page sizes: a phone writer's notes
never get a horizon; a laptop writer's get one 15 % of the time, and 4 % of those open one page
later for a phone friend, never more. Pages of 3,700 characters (a small font on a tall screen) can
hold a note two phone pages. Comments made before this have no horizon. Its writer is told under
it that friends read it once they have read to its horizon, and the friend it waited for is told
as it opens (fidelity review round 9: neither side knew). A friend answering from further on may
say the answer is only about the note's passage; it then opens with the note. Waiting stays the
default: an answer that does not say so cannot spoil.

## D72. A peek past where you have read is a look until you have read there

**Decision.** A look (D41, D58, D62) at a page more than a page beyond the furthest point you
have read becomes reading there only once you have read three pages there (each page counts once,
as you turn on from it), written a note there, or pressed "Read from here" (also offered by a
friend's locked note opened there: a marker sits where a finger turns the page, so opening one is
asked, not taken for reading; fidelity review round 10). Until then
the "Back to …" chip stays, nothing is saved or counted as read, friends see you at your place,
and the next stop does not count you; when reading takes over, the pages read in the look count as
read. Nearer than that, or behind where you have read, D62 is unchanged. A link inside the book is
a look too, and so is a chapter chosen from the player's track list, until you press Play.

**Context.** Fidelity review round 9's must-fix: at Chapter 1 · 3 %, choosing CHAPTER X from the
contents and tapping once saved "Chapter 10 · 77 %" as her place, removed the chip, moved her
marker for everyone and counted her at the next stop: D58's "one curious tap" again, let back in
by D62. The track list started playing and saved the place at once.

**Rejected.** *A timer*: guesswork about whether you are reading (D58). *Counting every page
turn*: flipping between two pages would count as three. *Measuring from your place rather than
your furthest point*: re-reading a chapter would take three pages each time. *Previous and next
track as looks*: they would stop playback at every skip, as the lock screen's do not (D64).

**Consequences.** With no place to return to, any page turn is still reading. Fourteen E2E tests
now turn three pages, press "Read from here" or press Play where they turned one page or tapped a
track (an intended change); none of their assertions went.

## D73. Numbered parts are not chapters; a straight line is judged as one

**Decision.** A number match pairs only numbers of the same kind: "Chapter 3", "03 - …" and
LibriVox's "alice_03_carroll" are chapters; Part, Track, Disc/CD, Volume, Book and Side numbers are
their own. A count, number or title match must reach 0.9 of the book from its first matched chapter
(the recording's side is always all of it), and a number match must not leave a unit numbered past
the last chapter it matched. A refused edition is lined up with the book from start to end only
(D61's straight line) and keeps its own unit names, and its owner is told on the book page, with
"Match to chapters". The cross-format margin is a tenth of the stretch the map interpolates, which
for a straight line is a tenth of the book.

**Context.** Fidelity review round 10's must-fix: the LibriVox Alice cut into eight parts named
"Part k" was matched to chapters I-VIII (it passed D61's pace check), its map ended at chapter IX,
the trial in Part 8 sat at 63 %, and a reader at chapter IX read a listener's note from the last
chapter. Measured shares from the first matched chapter: LibriVox Alice and the tiny fixture 1.000,
eleven equal parts 0.919, ten 0.847, eight 0.680, two 0.156. A straight line is off by up to 3.06 %
of the book at chapter starts (the LibriVox audio), more than the old margin of about 0.9 %.

**Rejected.** *Changing `chapterNumber`*: it orders uploaded tracks. *Naming rules alone*: bare
numbers look like LibriVox's chapter files. *The span alone*: thirteen parts pass it. *0.95*: an
unnumbered epilogue or afterword would fail it. *Characters a second*: they vary with narrator and
language. *A one-minute or one-chapter margin on a straight line*: smaller than its measured error.
*Never opening notes across such an edition*: friends could not talk across formats at all.

**Consequences.** Chapter-per-file audiobooks match as before. A partial audiobook, or files named
only by number, may need matching by hand; on a straight-line edition notes from other formats open
about a tenth of the book late (some 18 minutes of listening for Alice), never early. Editions
already lined up keep their map until they are read again.

## D74. Numbered files are chapters again; a PDF without bookmarks is lined up by its headings

**Decision.** A file named or tagged only by its number keeps it ("01") and numbers a chapter;
"Track 01" still numbers a track, and a part, disc or side facing a numbered chapter disagrees.
Front matter (the chapters before the first numbered one, or short opening ones, within the first
tenth of the book: three short entries in the Alice EPUB) may be left out to pair units in order,
once the number and title matches fail. A PDF without bookmarks is read in the worker for the book's
chapter headings at the top of its pages, which become its units. A straight line's margin is 6 %
of the book (D73's tenth was three times its measured error). Owners are told of every format
lined up only as a straight line, and the "Match to chapters" dialog fills in what it can.

**Context.** Fidelity review round 11's must-fixes, both from D73: `01.mp3` became "Track 1" and the
EPUB's fifteen entries hid its twelve chapters, so a plain numbered audiobook was a straight line
and a note opened 20 minutes of listening late (now 107 s); a PDF without bookmarks was a straight
line too and a note opened after page 54.5 (now 44.0, on the bookmarked pages). A straight line is
off by at most 3.5 % of the book (3.06 % at chapter starts in the LibriVox audio, 2.65 % in the PDF,
plus 0.41 % inside chapters).

**Rejected.** *Reading "Track N" as a chapter*: a CD's tracks would match. *Leaving front matter out
on the edition's side*: the same. *Headings anywhere on a page*: references in the text and the
contents pages would match. *Reading page text on the server's thread*: pdf.js cannot be stopped
mid-page. *A tenth of the book*: three times the error.

**Consequences.** Numbered files show "01" until matched. A PDF whose chapters start mid-page stays a
straight line, its owner told. Notes across a straight line open about 6 % of the book late, never
early. Twelve "Part 1"…"Part 12" files no longer pair one to one with a twelve-chapter book (D73
would have): parts are not chapters, and the owner can match them by hand.

## D75. A PDF is lined up with its text line by line, as an audiobook with what was heard

**Decision.** A PDF's text is read once, in the worker that finds its headings (D74), as lines top
down, each at the top of its type (the PDF locator's `y`), and kept beside the edition. It is lined
up with the book's EPUB as a transcript is (D46): normalised words, unique four-word anchors in
order, edit distance between them, a word counting only inside a run of four, words broken by a
hyphen at a line's end rejoined. A page is trusted when half its words are lined up and its lines
stay inside the stretch their chapter map interpolates (on a straight line, 6 % of the book); with
more than one tie in twenty out of place, nothing is. The result refines the map of whichever
edition the timeline does not rest on, with a tie per printed line, as a forced alignment: no
cross-format margin where it holds (D63), chained through the EPUB with an audiobook's. A PDF note
covers its whole printed line. It runs as a PDF or EPUB finishes reading, whenever the book's
editions change, and once at a start for PDFs read before.

**Context.** Fidelity review round 12's must-fix: with one point per chapter, notes between the
EPUB and the PDF sat up to eleven lines off and opened a page or two late, and listening from the
PDF started 40 s early. Now every word of 2,055 independently located lines lands on its own line
(with the chapter map 4.2 %, up to 31 lines off), and listening starts within 1.04 s before a
page's first word (with the chapter map a median 21.5 s early).

**Rejected.** *A finer chapter map, or characters per page*: still interpolation, a paragraph off.
*Trusting the text regardless of the chapter map*: a text layer could move notes across the book,
which a transcript may not (D46); a partial PDF has its chapters matched by hand first (D73). *A
few points a page*: the gate judges a PDF note by its line. *Judging a PDF note at its `y` alone*:
up to a line early. *Aligning on the queue after the ingest*: the demo's readers, placed right
after, would move under them (D47).

**Consequences.** Notes between the EPUB and the PDF open with their page, to the line, never early;
a PDF note waits for its whole printed line (one EPUB page late when that line runs over a page's
end). Other texts keep their chapter maps and margins. A map holds a point per printed line (Alice:
2,547 points, 86 KB). Not covered: two-column pages, text layers unlike the print, and quotes over
several lines, which are judged by their first line. A PDF is ready to read once it is read, and lined up a moment later in the
same job (Alice: about a second), as an audiobook is ready before its read-along; readers take the
refined map from the change that follows, and anything placed meanwhile is retimed with it.

## D76. A tag music-metadata stops short in is read again, unsynchronised first

**Decision.** When a file's ID3v2 tag says it is unsynchronised, or music-metadata warns
"Non-zero bytes found in ID3v2 padding", the tag is read again by our own reader
(`packages/shared/src/media/id3.ts`), in the track worker and in the browser for the upload form:
only the tag's bytes (its declared size, at most the largest picture kept and 1 MiB beside it),
resynchronised as a whole in ID3v2.2 and 2.3 and frame by frame in 2.4, then walked frame by frame
with every length checked against the bytes there are. Its title, album, artist or album artist,
track number and picture (the front cover first) win over music-metadata's; duration, chapters
and the rest stay music-metadata's. The upload form drops a trailing "(version N)", LibriVox's
number for a later recording of a work, from the title it fills in, and leaves out a picture in the
tags larger than a cover may be.

**Context.** Fidelity review round 13's must-fix: LibriVox's "A Christmas Carol (version 7)" has
ID3v2.3 tags unsynchronised as a whole, their text in UTF-16, whose byte-order mark FF FE is written
FF 00 FE. music-metadata 12.2.3 (and 12.3.0) never applies a tag's unsynchronisation: it walks the
frames where they lie, and the first zero put in ends the tag. Tracks took their 30-character ID3v1
titles ("02 - Stave 2: The First of the") and no cover. Read again, all five tags give their full
titles and the 76,509-byte JPEG; `fixtures/audio/carol-tiny` is tagged frame for frame as they are.

**Rejected.** *A newer music-metadata*: 12.3.0 reads the tag the same way. *Patching it*: a parser
fork to carry through every upgrade, for one flag. *Reading every tag ourselves*: music-metadata
reads chapters, other frames and other formats well; the second reading only fills what it lost.
*Resynchronising a tag that does not say it is unsynchronised*: every JPEG's FF 00 bytes would be
destroyed; read again as declared, such a tag gives what music-metadata gave. *Reading it again on
the server's thread*: resynchronising up to 33 MiB a track is the worker's work (D60). *Dropping
every parenthesis from a title*: "(Dramatic Reading)" and "(Abridged)" are part of it.

**Consequences.** LibriVox audiobooks get their full track titles, their covers from the tags and
the title "A Christmas Carol". A tag is read again only when unsynchronised or stopped short in, for
one more read of its bytes (77 KB for LibriVox's). From the sources the server bundles the track
worker in memory with esbuild, as the aligner's: 60–90 ms once per process. Compressed and
encrypted frames are passed over, and a v2.4 tag with plain (not syncsafe) frame sizes is read no
further than music-metadata reads it. An edition's stored album keeps its "(version 7)"; nothing
shows it.

## D77. A book's chapters are the entries of its contents that start chapters

**Decision.** An EPUB's contents list more than its chapters, and the book's chapters (what the
club stops at, counts pages in, names places by, and matches other formats to) are worked out from
them by `chaptersFromContents`, from two facts the parser now records for each entry: whether its
place holds nothing but its own title (no more than twelve letters beside it before the next entry
starts), and whether it is a picture's caption (its heading repeats the description of the picture
right above it). A caption is no chapter. Under a heading that holds only its title and is not a
part, a book or a volume, the entries below it are its sections, unless they number chapters
themselves or the heading would then hold more than 40 % of the story: a stave's subtitle and
picture, a story's three parts. Its subtitle joins its name ("STAVE ONE. MARLEY’S GHOST."). A
chapter's number alone and the subtitle right after it are one chapter; a caption printed in a
chapter's heading leaves its name ("He rode a black horse. CHAPTER III." → "CHAPTER III."). The
contents keep every entry for the reader to go to, saying which start chapters; the page in a
chapter counts from those. "Stave" and "canto" number chapters, and tens and units written in
words read whole ("TWENTY-ONE"). A place in the front matter (frontMatterCount, D74) is named
"Before Stave 1", and the front matter offers no stop. A match the club owner makes by hand is held
to the pace a match the server finds is (plausiblePace, D73): one that would hear a track over far
too little of the book, or far too much, is refused, naming the track. An owner whose format has
units placed between the matched ones, matched to no chapter, is told how many.

**Context.** Fidelity review round 13 brought a club's own book: Gutenberg's illustrated A
Christmas Carol and LibriVox's recording of it. Its 23 contents entries were 23 chapters: the
edition's note named a friend's first page, the stops offered "the end of PREFACE" and, for each
stave, the end of its subtitle or of its picture (a stop at 48 % for a stave ending at 74 %), and
the page count started again at each picture. "STAVE ONE." numbered nothing, so the five tracks
("Stave 2: The First of the", cut at 30 characters) were matched by their words: two of them, the
other three placed between, notes across formats some 18 pages late, and nobody told. Matched by
hand, the last track was heard between "STAVE FIVE." and its subtitle "THE END OF IT.", 16
characters on: a friend on the stave's first page read a note made at the book's end. Checked on
29 Gutenberg books: the Carol's five staves, Sherlock Holmes's twelve stories without their parts,
Moby-Dick's two-line chapter names, Pride and Prejudice's chapters without their captions, and the
other twenty-five, War and Peace, Anna Karenina and the Inferno among them, as before.

**Rejected.** *Chapters as the contents list them, as before*: the review's findings. *The
shallowest level only*: the Carol's staves are at the top, but so are its title page's lines, and
War and Peace lists its books and chapters side by side. *Dropping short entries*: a chapter's
heading is short, and its subtitle holds the chapter. *Recognising captions by their italics or a
class*: Gutenberg's are a heading like any other; what marks them is the picture they repeat.
*Reading the pages for chapter headings, as for a PDF (D74)*: an EPUB says where its headings
are; what it lists besides them is what needs telling apart. *Trusting a match made by hand
whatever it implies*: it placed every member's notes for every other.

**Consequences.** Labels, stops, chapters to go, page counts, the chapter-end moment and the
matching of other formats see the Carol's five staves; its tracks are matched by number, each heard
over its stave. Books read before keep the chapters they were given until their EPUB is read again.
Not covered: contents whose captions repeat no picture's description (they stay chapters), and a
part named without a number, holding only its title, over unnumbered chapters and under 40 % of
the story (it is taken for one chapter with them).

## D78. A note says when it opens: to its writer as it is written, to a friend while it waits

**Decision.** A note, like a reply (D69), may be said to be only about its passage (`aboutHere`): it
then has no horizon and opens at its place; a note not said so waits as before, and a reaction
alone never waits. The note form tells a writer who has read more than FURTHER_ON (0.005 of the
timeline, the threshold the answers use, now shared) past what is in front of them (the page's end;
the moment heard) where they have read to, named as the held notice names it, and that friends read
the note once they have read that far too; it offers "Post", which waits, and "Post, only about
this passage". Otherwise it says what it said before, with one button. The book page shows a writer
the held notice the note sheet shows. A friend's note with no horizon whose place your reading on
the shared timeline holds, yet closed, says who made it, in which format and about here, and that
it opens a little further on, once you are surely past it (D63), on the note sheet, the book page
and the club bar; "You have not read this far yet." stays for a note ahead of you, and one in a part
you went past without reading says "You have not read this part yet." When a note closed that way,
or held by its writer's horizon, opens behind the page in front of you, the reader says so in a
toast; the player cues a note that opened while you listened however far back it is by then, and
says how far ("4 min back"). A stretch heard from just after a chapter start the edition was matched
at (within the join gap: the player starts a chapter chosen from the track list a few milliseconds
in) is placed from that start, as exactly as the chapter is.

**Context.** Fidelity review round 13 (S2): Cole, who had finished the book, welcomed a new friend
on page 4; the note waited for Chapter 12 while the form had told him friends who had not read this
far would see only a marker, the book page showed no hold, and only an answer could be said to be
about its passage, so the organiser could not leave notes for friends just starting. M2: a reader on
the very page of a listener's 😢 was told "You have not read this far yet.", and the player cued a
note that opened late only within 90 s of its place, so a listener on twenty-minute chapters, whose
margin is two minutes, was never told. Testing that end to end found that a chapter started from
the track list, 7 ms in, had its first minute (the margin) never surely heard, and a reader's note
there never opened for that listener.

**Rejected.** *Telling the writer only after posting*: the choice belongs at Post, as for answers.
*Only about this passage by default*: a note that does not say so cannot spoil (D69). *Measuring
from the note's place*: the page on screen is read as the note is written (D12) and holds nothing;
on Alice a phone page (about 860 characters) is more than FURTHER_ON (about 730), so every note from
the top of a page would read as written from further on. *Asking the server how long a note would
wait*: the answers' threshold is close enough for a warning, and the held notice after posting is
exact. *Judging "about here" by your furthest place alone*: a note in a part you skipped would
promise to open a little further on, which it does not. *A toast for every note that opens*: one
ahead of you opens on the page you read it on, and "I've already read up to here" counts what it
opened. *Starting the player exactly at a chapter's first millisecond instead*: any seek, resume or
rounding a moment after a chapter start would bring the unheard minute back.

**Consequences.** The form judges a share of the timeline, the server a printed page (HORIZON_PAGE):
on Alice a phone writer one page back from where they have read is told the note will wait when the
server keeps no horizon, and a laptop writer's note at the top of their page may be held a few
characters without a word before posting (D69's 15 %), which its held notice then says. "About
here" is judged from the reading this device last heard from the server; a note whose place you
read in another format just before switching, within the margin and before your first page in the
new format, says it opens a little further on but waits until that part is read again. A listener
who starts within two seconds of a matched chapter start is taken to have heard those two seconds
(the recording's announcement).

## D79. The deploy image carries a speech recogniser, on by default

**Decision.** The deploy kit builds its image with `TRANSCRIBER_MODEL=base.en` and 2 threads: faster-whisper
1.1.1, its packages locked by hash, on Debian's Python, and the base.en model fetched at build time
and checked against pinned SHA-256s. The image sets `TRANSCRIBE_COMMAND`, so the server transcribes
each new audiobook itself (D59's queue and limits), as its own user, at `nice -n 19`, offline, in
ten-minute windows, and lines it up sentence by sentence (D46): notes between readers and listeners
then open at their sentence, without D63's margin. A transcript the owner gives (or removes) while
the recogniser reads that audiobook stops the run; an audiobook longer than `TRANSCRIBE_MAX_HOURS`
(100 h) is left to its owner. `BOOKCLUB_TRANSCRIBER_MODEL=` leaves the recogniser out, the image
then the old one layer for layer; `BOOKCLUB_TRANSCRIBE_COMMAND=` keeps it but runs nothing. The demo
and E2E stack stays without it; the dev stack uses this host's recogniser. This supersedes D46's and
D63's rejection of a recogniser in the image.

**Context.** Fidelity review round 13 brought A Christmas Carol (five tracks of 18 to 63 minutes):
without a transcript, a note between a reader and a listener opened a tenth of a chapter late, six
iPhone pages, and a stock deployment never transcribed by itself. Measured on three LibriVox Alice
chapters, pinned to one core (a 2-vCPU host) or two: base.en with 2 threads runs at 8.1 times the
audio's speed on 2 vCPUs (Alice in 22 minutes) and 13.4 on 4, matches 97.2 % of the chapters' words,
and puts sentence starts 0.16 s off at the median and 1.08 s at the 95th percentile, in under 1 GB;
small.en runs at 3.0 and 5.1 times, matches 97.6 %, 0.10 s / 0.56 s off, in 1.3 GB. D63 estimated
400 MB and an hour or more of CPU per audiobook; measured, 561 MB and 22 minutes for Alice.

**Rejected.** *Keeping it opt-in*: no deployment transcribes unless its owner builds an image of
their own, so a club's own audiobook keeps the chapter map's margin. *small.en by default*: an hour
for Alice and about an hour and a half for A Christmas Carol on 2 vCPUs, for 0.4 points more of the
words. *4 threads*: 10 % slower than 2 on 2 vCPUs, and no faster on 4 (12.9 against 13.4). *A
sidecar container*: the server already runs the recogniser as a child with the track files, its
time limits and a process group of its own (D59); a container beside it would need the data volume
shared and a way to call and stop it, for the same CPU. *A hosted speech API*: no external services,
and the audio is the club's. *whisper.cpp or another engine*: every alignment measurement was made
with faster-whisper's word timings; another engine would have to be measured again. *Debian's ffmpeg
for decoding*: 481 MB more, when PyAV decodes the same samples. *Each track taken whole*: about 1 MB
of memory per second of audio, 3 to 4 GB for an hour-long track.

**Consequences.** The image is 561 MB larger unpacked (532 MB to 1.35 GB in `docker image ls`) and
260 MB more to download, and builds from scratch in 58 s against 51 s. An audiobook of up to about
eight hours is lined up within the hour after upload on a 2-vCPU host, using the CPU at the lowest
priority and about 1 GB of memory meanwhile; until then its notes keep the chapter map's margin. The
drill transcribes an audiobook in the built image and checks the recogniser's user and priority.
Untrusted audio now reaches FFmpeg's demuxers by default, limited to the server's audio formats and
to the file itself. An old `deploy/.env` with an empty `BOOKCLUB_TRANSCRIBE_COMMAND` line turns it off.
Owners can still upload transcripts. Not measured: a physical 2-vCPU host, aarch64, a full ten-hour
transcription.

## D80. A note at a place you have not read comes to you only roughly placed

**Decision.** A friend's note closed to you at a place you have not read (on the shared timeline,
as your reading stands) comes from the server with its place rounded to half a per cent of the book
(`ROUGH_STEP`), never outside its chapter, the matching place in its edition, and `approx: true`;
its passage, quote and words stay out as before (D12). A note closed at a place you have read
(by a cross-format margin, D63, or its writer's horizon, D69) keeps its exact place, and an open
note always has it. The reader asks for the exact places of the closed notes on the page in
front of it (`GET /api/books/:id/places`: an EPUB section's characters, at most MAX_PAGE_CHARS, or
a PDF page) and marks them on their lines, as on any page you look at (D72); the player does not
treat a roughly placed note as a place to arrive at; the club bar places it, a pixel or two off.
Lists come in the order of the places each friend is given.

**Context.** Fidelity review round 14: as a friend at 15 % of Alice, `GET /api/books/:id/comments`
gave Cleo's hidden 😱 its exact place in the text and its percentage to 17 digits; looked up in the
EPUB the friend can download, that place was "we're all mad here", the very passage the note
quotes. The app never showed it, but anyone curious could, which is what gating on the server
was for (D12).

**Rejected.** *No margin marker for a roughly placed note*: going far ahead, you see who reacted on
which line, and may read from there to open it (D72); the page on screen holds that line anyway.
*Leaving the place out of a closed note*: the club bar is how friends see that
someone gasped somewhere ahead, and the chapter its notes are in. *Rounding every closed note*: a
note held only by a margin or a horizon is at a place you have read, and saying it is "about
here" (D78) needs its place. *A coarser step (a chapter)*: markers would pile up at chapter starts on
the bar. *Rounding on the client*: the exact place would still be on the wire.

**Consequences.** From the list, a note ahead of you could be anywhere within half a per cent of
the book (in Alice about a phone page); the club bar draws it up to two pixels off on a phone. Its
line is told for the page you look at, a page at a time, as the screen shows it; its words come as
it opens. Someone set on finding every note's line can still ask page by page, as looking ahead
page by page would show them.

## D81. The reader's contents and headings follow the book's chapters

**Decision.** The reader's contents list the entries that start the book's chapters (D77), by the
names the club uses, and mark as current the last that starts at or before your page, by place in
the book rather than by file. A chapter named by its numeral alone is "Chapter 2" in labels and
stops and "Chapter II" in a heading. A place before the story's first chapter is "Before Chapter 1"
in the reader's header as in labels, and the footer counts no chapter there. A percentage is
rounded down, but not past what a place carried between two formats' maps falls short by.

**Context.** Fidelity review round 14: Gatsby's contents on chapter II marked "V", Pride and
Prejudice's at XLV "LIV" (several chapters share one file: the last of the file was marked); the
contents still listed P&P's captions in its chapter names and the Carol's subtitles and pictures;
Gatsby's chapters "I" to "IX" read "You are at I · 0%" and "The end of I"; P&P's first screen said
"Section page 3 of 176" (the first file's pages) under the heading "PRIDE. and PREJUDICE"; a PDF
place at 8 % opened in the EPUB as 7 %.

**Rejected.** *Listing every entry, as the book's own contents do*: its pictures and subtitles are
what the club's chapters leave out, and the reader is where they confused. *Taking any numeral
alone for a chapter's number when matching*: a story's parts ("I.", "II.") under its title would
number chapters, and the story would fall apart into them again (D77); only the names change.

**Consequences.** A publication read before chapters were marked lists every entry, as before. A
lone Roman numeral counts in capitals up to CD; "Mix" is a word.

## D82. A question before something is done for good is the app's own

**Decision.** Deleting a note, a reply, a format, a transcript or a book, removing a member, leaving
a club, clearing the next stop, stopping an upload and "I've already read up to here" ask in a
dialog of the app's own: `confirmAction({ title, body, confirm, cancel, danger })` resolves to the
answer. It is an alert dialog on the app's Modal, named by its question and described by its line
(on a phone, the bottom sheet with its two answers side by side); the safe answer has the focus;
Escape, the close button and the backdrop answer no. Questions come one at a time in the order
asked, as the browser's did; going back answers no; the code that asked can take a question back
(an upload that ends while "Stop this upload?" is open). A dialog opened over another takes the
keyboard until it closes. The questions are drawn by a React root of their own, so any code asks
as it asked the browser. This supersedes D57's rejection of a custom dialog.

**Context.** Fidelity review round 14 (FR133): on an iPhone the browser's confirmation is a grey
system alert headed with the site's address, out of keeping with the calm, polished brief.

**Rejected.** *The browser's confirm()* (D57): that look, and one string for question and
consequence. *The `<dialog>` element*: a second dialog system beside the Modal, which already traps
focus and gives it back (v1's bug, tested). *A provider and a `useConfirm` hook*: the shell would
host it and every caller render it; the note sheet and the note helper ask where no hook is. *Undo
toasts*: a deleted note goes for everyone at once (D57).

**Consequences.** E2E answers a question by its role and button (`e2e/helpers/confirm.ts`). A
question stays open over a navigation made by code, answering for the page it was asked on; its
dialog has no app context (router, queries) and needs none.

## D83. With several clubs, home opens on the book you read last

**Decision.** With two clubs or more, `/` shows first the book you read or heard last, whichever
club it is in, with its club named and one tap from your place ("Read on" opens the reader, "Listen
on" the player), as a library does. Then each club: its name, its covers in its library's order
(yours first; four, then "+N") and a line about who is reading what: friends in one of its books
right now ("Ana is reading “Alice” now"), else those reading the book a friend read last; listening
is said as listening, a mix as "in". The page waits for every club's books (the libraries' own
cache) so nothing moves under the thumb; a club whose books cannot be had shows without them. One
club still opens straight; from 720 px clubs sit side by side.

**Context.** Fidelity review round 14 (FR131): with a second club `/` was a bare list of names, and
opening the app was no longer one tap to your place (INTENT, "Opening it").

**Rejected.** *Opening the club of the book read last*: the other clubs a tap and a Back away, and
someone reading in two clubs landing in either by turns. *A home summary endpoint*: one request
instead of one per club for two or three clubs, whose answers the libraries reuse. *Each club's
full book cards*: a screen of bars per club on a phone. *Ordering clubs by your reading*: the
banner leads to the last one already.

**Consequences.** Home asks for each club's books and follows each club's presence while it is
open; offline it shows what the device kept.

## D84. An invite opened by a member opens the club

**Decision.** Someone signed in who opens an invite to a club they are in reads "You are already in
<club>" and gets one button, "Open the club". Membership is found in the browser: the code is the
invite one of their clubs shows its members (D40). When their clubs cannot be loaded, the page
offers to join as before, which for a member only opens the club.

**Context.** Fidelity review round 14 (FR134): a member opening the link was asked to "Join … Join
as Ana", which only opened the club.

**Rejected.** *A `member` field on the public preview*: a server change for what the browser holds,
on an endpoint for people signed out and rate-limited per invite (D33). *Accepting on opening*: a
write on a page view. *Matching by club name*: names repeat.

**Consequences.** Signed in, an invite page first loads the person's clubs and each one's details
(cached for the club pages); a replaced link still says it has expired.

## D85. A notification lands on its note, marked, with the focus

**Decision.** A notification still opens `#note-<note>`, its conversation; for a reply, the router
state names the reply. Once on the page, the note or the reply is brought to the middle of the
screen, marked (a gold wash that fades in 2.4 s inside a gold ring) and focused (tabindex -1), so a
screen reader reads it; the mark goes with the focus. With less motion the wash stays, unfaded.

**Context.** Fidelity review round 14 (FR134): a notification opened the book page at its note
without saying which it was, and a reply's at the note, not the reply.

**Rejected.** *CSS `:target`*: pushState does not set it. *The reply's id in the address*: the
address names the conversation, and a reply deleted since still lands on its note. *A mark that
times out*: gone before a screen reader user or a glance back finds it. *A mark without the focus*:
nothing for a screen reader.

**Consequences.** Replies carry `data-comment`, as notes do; finding and marking the target is
`lib/note-link.ts`.

## D86. A chapter is named with its part; the reader keeps to its own front matter; listening from the page

**Decision.** Five changes from one review of novels other than Alice:

- *Parts.* Where a book numbers its chapters afresh in each part, book or volume (Crime and
  Punishment, War and Peace), every chapter is named with its division wherever the club sees a
  name: "Part 2, Chapter 1" in places, next stops, the matching dialog and the stop card; "Part 2 ·
  CHAPTER I" over the page. A division is a heading numbered as a part, book or volume, or an
  unnumbered heading after the front matter followed by a chapter ("Epilogue"). Ordinals are
  numbers ("Book the First", "the twentieth"); a year span at a heading's end ("1805–1812") is not.
  A book numbered straight through keeps its short names.
- *Front matter.* The reader decides what lies before the story from its EPUB's own chapter
  starts, so an EPUB added to an audiobook says "Before Chapter 1" there and counts no chapter
  page, as one uploaded first does.
- *Contents.* The reader's contents list nothing after the story (Gutenberg's licence), and of the
  front matter only what holds two pages or more and is not the book's own printed contents or
  list of pictures: a preface stays, a title page's lines go.
- *Listening from the page.* Where the book has an audiobook, the reader has a headphones button,
  "Listen from your place": it saves the place and opens the player there.
- *Rows of stars.* A row of stars between scenes is marked by the server with its widest line's
  width, in em (`--bc-row`); the reader draws it on one line, 0.15 em closer, and no larger than
  the page holds. Page counts a device keeps are keyed to the reader's stylesheet as well as the
  page and the settings.

**Context.** Fidelity review round 15 (FR135, FR136, FR139, FR141): "The end of Chapter 1" six
times in the next stop's choices, the stop chosen read as another; "THE MILLENNIUM FULCRUM EDITION
3.0" over an EPUB added to an audiobook, with "1 of 2 in chapter"; the licence "ahead of you" in
the contents; Alice's rows of stars broken across a phone's page; three taps from a page to its
recording.

**Rejected.** *Numbering chapters through the whole book* ("Chapter 37"): not the book's names; a
club says "Part 3, Chapter 2". *Telling repeats apart by a percentage*: six choices still read
"The end of Chapter 1". *Naming the part everywhere*: longer names in books that need none.
*Front matter from the book's chapters*: they may come from an audiobook's tracks, and the pages
are the EPUB's. *No front matter in the contents*: a 40-page preface is reading. *For the stars,
word spacing alone*: at 200 % on an iPhone a row was 392 px in a 325 px page; *letting rows wrap*:
pages of broken rows; *replacing them with a drawn rule*: the book's text and every offset in it
would change; *measuring in the browser after layout*: page totals must come from the stylesheet
alone, in the counting frame too; *CSS `attr()` in `calc()`*: WebKit has no typed `attr()`.
*Bumping the layout version by hand*: two stylesheet changes went in without it.

**Consequences.** `chapterNames` and `divisionAt` in `packages/shared/src/timeline/chapters.ts`;
`listedContents` in `apps/web/src/reader/epub/contents.ts`; the row's width is written for books
added from now on, and a row without it is drawn at the page's type size, still on one line.
Gutenberg's Crime and Punishment (#2554) is a test fixture.

## D87. A one-time code signs you in where you are not

**Decision.** Someone signed in can get a sign-in code in Settings ("Sign in on another device"):
eight digits, shown in two fours, working once, for ten minutes. Typed under "Sign in with a code"
on the sign-in page, it signs that browser in as them. Only a person's newest code works; a new
password, a reset or signing out everywhere retires it. The server keeps a hash of it, claims it
in one statement (of two requests with the same code one wins), and limits tries: ten per address
and fifty wrong ones from all addresses together in fifteen minutes; codes made, ten per person.
In the app opened from the Home Screen, the sign-in page says how to get one, under Continue with
the upstream.

**Context.** Fidelity review round 15 named a risk it could not run: on an iPhone, the app on the
Home Screen has cookies of its own, and iOS may finish another site's sign-in (the upstream's) in a
sheet whose cookies are not the app's. An upstream friend has no password to type there, so the
installed app could not be theirs at all. A code made in Safari, where they are signed in, reaches
the app whatever iOS does with the sheet; it also signs in a second phone or a laptop.

**Rejected.** *Signing in through a pop-up window that posts back*: in a Home Screen app a pop-up
opens the same kind of sheet. *A link with a token, to open in the app*: iOS opens links in
Safari, not in a Home Screen app. *A password for upstream friends*: the one identity is theirs
already (D14). *Longer codes (letters, more digits)*: typed by hand on a phone; ten minutes, one
use, the newest only and the limits keep guessing far slower than codes expire. *An in-memory
code store*: a restart would lose a code someone is typing, and the database already holds
one-time links (reset links) the same way.

**Consequences.** Migration 011 (`sign_in_codes`); `repos/codes.ts`; `POST /api/auth/codes` (signed
in) and `POST /api/auth/code`; Settings' "Sign in on another device"; the sign-in page's code form
and Home Screen hint. Not tried on a physical iPhone; the flow is tested with two browsers that
share no cookies, an upstream friend's included.

## D88. A sheet keeps to the part of the screen still seen

**Decision.** While a dialog is open, its backdrop is fitted to the visual viewport: its top and
bottom to what is seen of the page (`--seen-top`, `--seen-bottom`), the sheet no taller than that
(`--seen-height`), so on a phone with the keyboard up the sheet sits above the keys, scrolling
inside itself, its text box and Post button within reach. Zoomed in, the page is left as it is.

**Context.** Fidelity review round 15 read that nothing adjusted for the on-screen keyboard: iOS
shortens only the visual viewport when the keyboard opens, so a bottom sheet fixed to the page
keeps its lower part, the note composer's Post button included, under the keys.

**Rejected.** *The viewport's `interactive-widget=resizes-content`*: Chrome on Android honours it,
iOS Safari does not. *Scrolling the focused field into view only*: the button under it stays under
the keys. *A sheet at the top of the screen on phones*: away from the thumb, and the keyboard still
covers a long one. *Watching focus and guessing the keyboard's height*: the visual viewport says
what is seen, keyboard or not.

**Consequences.** `useSeenArea` in `components/Modal.tsx`, for every dialog. Tested with a phone's
visual viewport in the unit tests and with a shorter screen in both browser projects; not tried
with a physical iPhone's keyboard.

## D89. A toast can be used, and covers nothing you need

**Decision.** A toast may carry one action ("Show") and a dismiss button. Plain toasts last 4 s,
errors 6 s, toasts with an action 10 s; one with an action is held while the pointer rests on it,
while it has the focus or while a newer toast is over it, then keeps the rest of its time (at
least 2 s). One toast is on screen at a time, the newest, unless you are pointing at or focused in
the one already there; Escape and the dismiss button give the focus back where it was. The region
is a polite live region named "Messages". Toasts come in over the app's top bar, the reader's
header or the player's, at most two lines and 40 px tall, between the bar's buttons on a computer;
in the reader on a computer during a look they sit at the foot between the page arrows, unless a
card or a dialog is up. "Show" opens the note's sheet in the reader of that book (readers register
through `lib/note-opener.ts`); anywhere else it goes to the note on the book page, naming the
answer, as the bell does. An answer held for where its writer had read to (D78) is told only to the
note's writer and those who replied to it, naming it: "Ana’s answer to Cole’s note in Chapter 3 is
open now" ("to your note" for its writer).

**Context.** Fidelity review round 15 (FR137): a reply reached you in the reader only as a 3.5 s
toast you could not tap, and the reader has no bell; everyone an answer opened for was told,
without saying which; on a computer the toast covered the next stop's card.

**Rejected.** *Toasts at the bottom, as before*: they covered the stop and chapter-end cards, the
player and the phone's bottom sheets. *Queueing toasts until a card goes*: messages arrive late,
and the timing hides where they went. *Holding plain toasts on hover*: one left over something a
click was aimed at would never go. *A bell in the reader*: a phone's header has no room for it.

**Consequences.** On a phone during a look, a toast covers "Read from here" for its few seconds
(the way back, in the footer, stays clear), and it covers the reader header's buttons while it
shows. Long reply previews are cut at two lines on screen; a screen reader hears all of them.

## D90. Your own marker stays at your place; friends there sit beside it

**Decision.** On the club bar your marker is always a target of its own, at your exact place.
Friends whose targets would overlap it are one group beside it, on their side if there is room,
else on the other; a group that new group would overlap joins it. With everyone at a new book's
start: your marker, then the friends. `layoutMembers` is tested on many random clubs: no two
targets overlap, everyone is there once, you are at your place.

**Context.** Fidelity review round 15 (FR138): straight after an upload, the group's "+3" was drawn
over your own marker, on the first view of every new book.

**Rejected.** *Your marker drawn over the group*: two targets on one spot. *Holding every group
inside the track's ends*: more than was asked, and it moves friends' groups everywhere.

**Consequences.** A friend just ahead of or behind you is drawn up to one target's width from
their exact place; the bar's tip and its label say where they really are.

## D91. During a look, the way back sits in the reader's header or footer, never on the bar

**Decision.** On a computer, both of a look's buttons (D62) sit in the reader's header, where the
chapter's name was, between the header's buttons. On a phone "Read from here" sits in the header's
middle, and "Back to …" in the footer between the page arrows, in place of the page numbers while
you look. The read-along's "Follow the narrator" chip takes the same header place. The header's
buttons, the page arrows, the club bar and the page stay clear.

**Context.** Fidelity review round 15 (FR138): the chip covered the middle of the club bar.

**Rejected.** *A row of its own*: it changes the page's height, and the EPUB would be paged again.
*The whole header on phones*: the note button is used during a look (notes-further.spec). *Over
the page's first line*: it covers text.

**Consequences.** On a phone, the page numbers (and, with audio, the footer player's link) are
hidden while you look.

## D92. The next stop says whose notes it shows, and its choices give each chapter's title

**Decision.** The stop card's button says "Show Ana’s note" or "Show Ana’s 2 notes"; from several
friends "Show 3 notes", the names in its accessible name. The "Read up to" choices add the title of
the chapter each stop ends, beyond its number ("The end of Chapter 7 · A Mad Tea-Party"), a title
set in capitals said calmly (`calmCaps`, D86); where a part's heading and its first chapter start
together, the chapter's title. The stops and the labels they are saved with are `meetingStops`'
own.

**Context.** Fidelity review round 15 (FR140): "Show the note" said not whose; the choices gave no
chapter titles, even in Alice.

**Rejected.** *Titles in the saved label*: it is stored and shown elsewhere, in places, notices
and the book page. *Names on the button with several writers*: too long for a phone's footer.

**Consequences.** Only the chooser's option text changed; meeting.spec and carol.spec choose by it.

## D93. A place at a chapter's start opens at that chapter in every format

**Decision.** A place opened in another format is translated through the timeline as before, but
a place at the very start of a chapter, in the format it was saved in, never opens before that
chapter in the other: where translating it would land before the other format's own start of the
chapter (its unit, which the chapter match pairs with it), it opens there. "At the start" is in the
saved format's own measure: from 300 characters before an EPUB's chapter heading to 1,500 after it,
from a quarter of a PDF page above its heading to a page after it, from a second before a track's
start to a minute into it. Before, little, since going on to the chapter skips that much at most;
after, more, since it never moves a place back. The same holds when the reader opens, when the
player opens, from the reader's headphones, and when a place moved on another device (D70) is
taken up here; a place the club's progress tells by its format and t alone is first placed in that
format.

**Context.** Fidelity review round 16 (FR142, must-fix): from the EPUB's first page of Chapter VI
the audiobook played the last seconds of Chapter V and the PDF opened on Chapter V's last page. A
chapter's first words sit a hair apart in each format's map: the EPUB's at its heading, a lined-up
PDF's at its page's first printed line (its title page and Chapter I's first page both at the
story's start), a transcribed audiobook's at the first word the recogniser matched, after "Chapter
six" or LibriVox's preamble. Alice's Chapter VI starts at 0.4034334, 0.4034375 and 0.4035086.

**Rejected.** *Snapping any place near a chapter boundary*: a reader on the last lines of a chapter
would be moved past them. *Moving every format's chapter starts to one t*: the maps are lined up
word by word (D46, D75) and are right inside the chapter; only the chapter's very start differs.
*Comparing on the timeline*: a lined-up PDF's title page and its first chapter's page share a t;
the comparison is made in the format's own measure. *A fixed margin on the timeline*: a tenth of a
thousandth of War and Peace is pages.

**Consequences.** `translatePlace` and `startPosition` in `apps/web/src/reader/position.ts`, used by
both readers and the player. Tested for every chapter of Alice in both browser projects, from the
EPUB to the audiobook and the PDF and from the audiobook to the PDF (e2e `chapter-switch.spec`).

## D94. In the reader and the player, a toast goes where it covers no control

**Decision.** Where a toast goes in the reader and the player is worked out on the screen as it
is, and again as it changes (`components/toast-place.ts`): in the header's middle when its buttons
leave 260 px or more (a computer; the player on a phone, whose header has two buttons); on a
computer during a look, at the foot between the page arrows, unless a card or the footer player is
there; otherwise (a phone's reader always) just under the header and the club bar, or under the
PDF's view panel when it is open, over the top of the page's text and clear of the margin's note
markers. With a dialog open, and everywhere else in the app, D89's place and all of D89's other
rules stand. What is scrolled out of sight does not count.

**Context.** Fidelity review round 16 (FR143): on a phone a toast lay over Back, Listen, Contents,
Reading settings and Leave a note for its ten seconds, and over "Stay here"; on a computer, two
more were found covered (the reader's "Listen from your place" in windows under 952 px; the look's
buttons or the player's link with a card or the footer player).

**Rejected.** *At the foot on a phone*: the page arrows, the way back, the player and the cards are
there. *Between a phone reader's header buttons*: about 140 px is left. *A row of its own*: the EPUB
would be paged again (D91). *Fixed offsets in CSS*: the PDF's markers move with its page's size and
its panel's height varies. *Over the top of the player*: its track list scrolls under it.

**Consequences.** On a phone a toast covers the page's first line or two for its few seconds. The
region says where it is (`data-place`: `bar`, `header`, `foot`, `page`).

## D95. Asked "only about this passage?" only while a friend is behind

**Decision.** A note or an answer written from further on (D69) asks whether it is only about this
passage only while some friend has read less far than its writer (by more than half a per cent),
and names them: "Ana and Ben have not read as far as you: your answer waits until they have, unless
it is only about this passage." With everyone past, there is one Send, and the answer still waits
for anyone who joins later. Where an answer waits until is named by the chapter of the last place
its writer had read, the page it is held back by (D69) added back.

**Context.** Fidelity review round 16 (FR144): asked whenever the writer was a little past the
note, though all three friends were past them; the posted reply then said "read to Chapter 2" of a
writer in Chapter 3 (its hold point, a page back from Chapter 3's start, was named).

**Rejected.** *Asking whenever the writer is past the note* (as D78 had it): the question changed
nothing. *Posting such notes as only about this passage, unasked*: a friend who joins later would be
spoiled. *Asking the server who would be held*: the club's progress is already on the screen.
*Naming the place kept*: the writer was not there.

**Consequences.** A friend within half a per cent counts as having read as far, so in a very long
book they may wait a few pages without the writer being asked, as D78 accepted. With everyone past,
the writer still sees "Friends read this once they have read to Chapter 3".

## D96. An upload waiting for the connection goes on as soon as it is back

**Decision.** When the browser says it is online again, or the page comes back on screen with a
network, a file waiting on a lost connection stops its pending retry and goes on from the server's
offset at once, nothing re-created, its back-off from zero again (`lib/online.ts`
`onConnectionBack`, `upload/uploader.ts`); finishing the import tries again at once too. Server
errors keep their back-off.

**Context.** Fidelity review round 16 (FR145): "Paused at 99%: waiting for the connection" stayed
for 37 s after the network came back; retries waited up to 30 s and nothing listened for `online`.

**Rejected.** *Shorter delays*: they would hammer dead Wi-Fi or a struggling server. *Restarting
the same tus upload*: its retry count is its own, and the next wait could be 30 s again. *Cutting
server errors' waits short too*: a server in trouble is given its time.

**Consequences.** An `online` that comes early costs a try or two; an unreachable server is tried
again whenever the page comes back on screen.

## D97. A book's card offers its first step

**Decision.** A book you have not started offers "Start reading" on its card when it has an EPUB or
a PDF (opening the reader as it opens for a newcomer, the EPUB first, at the story's start) and
"Start listening" when it is audio only; with a place, "Read on" or "Listen on" as before (D83).

**Context.** Fidelity review round 16 (FR146): new members went cover, book page, Read.

**Rejected.** *The format the book page highlights*: it may be an audiobook or a PDF added first,
and the card has no list of formats.

**Consequences.** For a book whose PDF came first, the card opens the EPUB while the book page
highlights "Read the PDF".

## D98. The upload form fills in the title a club calls the book

**Decision.** From a file's own title, the upload form fills in the part before its first ";" or
":" where that part is a title of its own ("Frankenstein; or, The Modern Prometheus" →
"Frankenstein", "Jane Eyre: An Autobiography" → "Jane Eyre"), and drops a trailing "in Prose" or
"in Verse" ("A Christmas Carol in Prose; Being a Ghost Story of Christmas" → "A Christmas Carol").
What the owner types is kept as typed; the server keeps what the form sends.

**Context.** Fidelity review round 16 (FR147): Gutenberg's whole title page was filled in.

**Rejected.** *Doing it when the server reads the file*: the owner's title is kept as given. *Cutting
at a comma or a dash*: "Hamlet, Prince of Denmark". *Always dropping "in Verse"*: "Fables in Verse"
is a title.

**Consequences.** Books already added keep their titles.

## D99. A note written with no network is kept at once

**Decision.** With `navigator.onLine` false, a note is kept on the device at once ("No network:
this is kept on this device…", D42); a request that fails gets one more try after 300 ms, then the
note is kept. No timeout: a slow network still posts.

**Context.** Fidelity review round 16 (FR148): "Posting…" for about 3 s first (three tries, 800 ms
and 1.6 s apart).

**Rejected.** *A request timeout*: it would fail a slow network that works. *No second try*: a
connection that drops and comes straight back would keep a note it could pin.

**Consequences.** A note kept after a one-off drop is pinned by the outbox within 15 s.

## D100. A reaction alone says it has no words; the stop card says it in fewer

**Decision.** A friend's reaction with no words, ahead of you, reads "Ana reacted 😱 here, with no
words.", with no lock and no "read from here to open it", on the book page and in the note sheet,
from another format too. The next stop's card says "You're at the next stop, with Ana and Cleo.",
on a phone in up to three lines of slightly smaller type inside the footer.

**Context.** Fidelity review round 16 (FR147): "A reaction waits here. You will see it when you get
there." beside the reaction already shown; the card's line cut at "Ana and Cleo are…".

**Rejected.** *Saying a reaction opens when you get there*: there is nothing more to open. *A bare
"Show" on the card's button*: D92 names whose notes.

**Consequences.** None beyond the words.

## D101. No Web Push yet: the bell, the live toasts, and push left for the deployment

**Decision.** Notifications stay in the app (D49): the bell, kept per person, and toasts pushed live
over the WebSocket to every open screen, with Show (D89, D94). Web Push is the deployment's next
step, not this build's: the server would make its own VAPID keys (no account anywhere), keep each
device's subscription, and send the same words the bell shows, which never carry anything its
reader could not already read (D49).

**Context.** Fidelity review round 17 (FR158) read that notifications wait until the app is
opened, and that Web Push needs no account; D49 had rejected it as something "the brief does not
allow", which was not exact: the brief forbids accounts on outside services and this work reaching
them, not a deployed app's use of them.

**Rejected.** *Web Push now*: a browser can only subscribe through its maker's push service
(Google's for Chrome, Apple's for Safari), so neither a subscription nor a delivery could be made
or tested end to end from this box without reaching those services, and an untested sender is not
one to hand over. On an iPhone it works only once the app is on the Home Screen and the friend has
allowed it, so the bell is needed beside it either way. *Polling for news in the background*: iOS
gives a web app no background time.

**Consequences.** Web Push, with what it needs, is left among the next steps. A friend away
from the app learns of a reply when they next open it; open, within a second.

## D102. The browser's pdf.js gets what the server's has, from the app itself

**Decision.** pdf.js's decoders (OpenJPEG for JPEG 2000, JBIG2, with their JavaScript fallbacks),
its colour-profile engine and CMYK profile, the 14 standard fonts and the CJK character maps are
copied into the web build under `/assets/pdfjs-<version>/` (`apps/web/pdfjs-resources.ts`) and
served from the app's own origin, immutable; the reader and the upload form open every PDF through
`lib/pdf.ts` `openPdf` with them. The service worker answers them from a cache of their own, and
keeping a PDF for offline reading stores them all first. The server's pdf.js gets the maps too.

**Context.** Fidelity review round 17 (FR149, must-fix): every page of a scanned PDF (JPEG 2000,
as archive.org and Google Books make them) was drawn white in both engines ("JpxError: OpenJPEG
failed to initialize").

**Rejected.** *Precaching them*: 3.5 MB more on every member's phone, most of whom never open a
PDF. *A CDN*: the content security policy is the app's own origin, and offline needs them on the
device. *Caching them only as they are fetched*: pages not drawn yet would be white offline.
*Fetching them on the page's own thread*: pdf.js then turns colour profiles off.

**Consequences.** The first PDF kept on a device costs 3.5 MB once (again after a pdf.js upgrade,
the old files dropped); a PDF is listed as kept only once these are in.

## D103. A cover is never a blank drawing

**Decision.** A picture with ink on at most 1 in 2,000 of its pixels (ink: more than 48 of 255
shades from its commonest shade; `looksBlank`, shared) is no cover. The upload form does not send
one ("The cover is made from the PDF once it is uploaded"); the server refuses one and draws the
page with its own pdf.js; a page it draws blank gives the book a made cover.

**Context.** Fidelity review round 17 (FR149): a scan's blank preview became its white cover.

**Rejected.** *A threshold on the pixels' spread*: a scan's grain looks like a line of text.
*Always leaving the cover to the server*: the preview is there before the upload, at no cost to it.

**Consequences.** A cover of one flat colour gives way to a made one.

## D104. A scan's chapters are found through its OCR

**Decision.** Where a PDF has no bookmarks, the server's heading finder (D74) reads the first ten
lines of each page, sizes each line by the size most of its characters have (OCR sizes each word
by its own box), takes a first line naming a chapter with a page number for a running head, never
a heading, and looks past running heads, short lines and lines set apart from the text, never past
a line of body text; it allows OCR's misreadings only in lines set well apart above the text,
reads "Doctor" and "Dr." alike, and names each heading found by the book's own chapter title.

**Context.** Fidelity review round 17 (FR149): the 1886 scan's contents were its raw OCR ("STORY
OF THE DOOR. 7", six pages late) and 6 of its 10 chapters. Now all ten, each on its first page.

**Rejected.** *Printing the line found, tidied*: OCR's typos stay, and running heads still match.
*Matching every line loosely*: body lines echo titles, and it costs seconds. *Telling running heads
by repetition alone*: a chapter's first page repeats its title too.

**Consequences.** About a second for a worst case of 365 chapters, in the worker; headings matched
exactly are named as before.

## D105. The upload form fills in an author as people say them

**Decision.** "Stevenson, Robert Louis, 1850-1894" fills in as "Robert Louis Stevenson": names
inverted as libraries write them, with life dates, initials with their fuller form, particles ("de
la Mare"), Sir and Jr., several names between semicolons. "Lewis Carroll, John Tenniel" is left as
it is; what the owner types is kept (D98).

**Context.** Fidelity review round 17 (FR149).

**Rejected.** *Turning a name round at any comma*: two names in a list. *Doing it on the server*:
the owner's words are kept as given (D98).

**Consequences.** Books already added keep their authors.

## D106. A title set in sentence case is filled in in title case

**Decision.** Only a title in sentence case ("The strange case of Dr. Jekyll and Mr. Hyde") is
filled in in title case ("The Strange Case of Dr. Jekyll and Mr. Hyde"), small words low, "Dr.",
"Mr.", a word like "iPhone" and name particles as they are; "A Christmas Carol" is as it is, and a
non-English EPUB keeps its own.

**Context.** Fidelity review round 17 (FR157).

**Rejected.** *Title case for every title*: a title styled small ("the waste land") would change.
*Doing it on the server*: D98.

**Consequences.** A PDF or a recording says no language, so a non-English title in sentence case
there is set in title case.

## D107. The screen stays on while files upload

**Decision.** While files upload or the import finishes, the app holds a screen wake lock
(`lib/wake-lock.ts`), asks for it again when the page comes back on screen, and lets it go when
done, failed or stopped. For uploads of 20 MB or more the dialog says once: "Keep this screen on
until it finishes. If your phone locks, the upload pauses and goes on when you come back."

**Context.** Fidelity review round 17 (FR156): iOS stops Safari's page when the screen locks, and
a 1 GB upload on hotel Wi-Fi outlasts the auto-lock.

**Rejected.** *The words for every upload*: a 3 MB file is done before they are read. *The words
only where there is no wake lock*: the side button still locks the phone.

**Consequences.** Where a browser has no wake lock, the words alone.

## D108. The demo's first evening

**Decision.** In the demo club Cole and Ana read the EPUB, Ben listens, and Cleo, furthest on, reads
the PDF: the bar still shows a reader of each format and a listener.

**Context.** Fidelity review round 17 (FR153): Cole's own place was in the PDF, which on an iPhone
opened at about 10 px text.

**Rejected.** *Ana in the PDF*: the Lighthouse run reads as Ana.

**Consequences.** The seed's tests say who reads what.

## D109. An EPUB's story is what the book marks as its story

**Decision.** Besides Gutenberg's header and licence (D26, unchanged), an EPUB's story range leaves
out what the book itself marks as not story where it opens or ends the book: before it, a title
page, half-title, imprint, copyright page, series page, its printed contents and lists; after it,
those and its colophon and credits, notes, appendices, afterword, acknowledgments, bibliography,
glossary, index, about the author, previews and "also by" (`packages/epub/src/matter.ts`). The
marks are, strongest first, the book's `epub:type` values and DPUB-ARIA `doc-*` roles on `<body>`
and inside it (the innermost that names a kind decides, so an epilogue inside back matter stays
story; where one element says two things, story wins); then its landmarks and EPUB 2 guide, from a
document's start only and only where the contents list nothing deeper in it (a "cover" mark is not
taken, title-page marks only on documents of at most 5 % of the book); then the landmarks'
front/body/back matter. Only the runs of marked matter at the very start and end are cut, at
document boundaries; text between stretches of story, and unmarked text, never are; prefaces,
forewords, introductions, dedications and epigraphs are reading; marks that would leave less than
half of the range are not taken. What follows the story stays readable: its pages are numbered "—",
the header says "After the story", and the contents list it apart, after the story
(`Publication.backMatter`; Gutenberg's licence is never listed there). A page wholly before the
story is named by the chapter it comes before.

**Context.** Fidelity review round 17 (FR150, must-fix): Standard Ebooks' Jekyll ends with a
Colophon and an Uncopyright: the story's last page was 65 of 69 at 97 %, "You finished the book"
came on the Uncopyright's last page, and both were chapters in the header, contents and places.

**Rejected.** *Cutting by headings' words* ("Colophon", "About the Author"): words in a story.
*Leaving appendices and notes in the story*: 100 % and "finished" would come after them. *Cutting
inside a document*: the reader's pages and places are by document. *Trusting a landmark anywhere
in a document*: Gutenberg's landmarks point into the middle of files.

**Consequences.** The 36 Gutenberg books of the corpus keep their story ranges and contents. A
book already in a club keeps its old range until its EPUB is read again.

## D110. A recording is lined up with the story's reading only

**Decision.** The forced alignment (D46) leaves out what no narrator reads: the front matter's
scraps and the printed contents and lists that the reader's contents leave out (D86's rule, shared
as `readingContents().unread`) and the matter outside the story (D109); prefaces are aligned. A
recording's first words, before its first aligned sentence and within its first 90 s, are tied to
that sentence, not to the story's start.

**Context.** Fidelity review round 17 (FR154): at 0:00 of a newly transcribed LibriVox recording
the read-along's sentence was the contents page's last entry: LibriVox's preamble had matched it.

**Rejected.** *Ignoring a track's first seconds*: the narrator's chapter title is in them.
*Aligning the contents too and skipping it after*: the preamble's words still match it first.

**Consequences.** At 0:00 the read-along has the story's first sentence ("STORY OF THE DOOR", 32 s
into the track, after the preamble).

## D111. A cover is shown whole

**Decision.** Thumbnails stay 2:3. A cover within 1 % of that shape fills the frame; a squarer one
keeps D56's blurred backdrop; a taller one is drawn whole, centred on the app's dark ground at its
sides. `COVER_DRAWING` 3 gives every cover a new address, so browsers replace kept copies. The lock
screen takes the same thumbnails.

**Context.** Fidelity review round 17 (FR151): Gutenberg's Jekyll cover (500×862) was cut to 2:3,
losing "THE STRANGE CASE OF DR. JEKYLL AND" on the shelf, book page, player and lock screen.

**Rejected.** *Frames of each cover's own shape*: shelves of mixed heights. *A blurred backdrop for
tall covers*: on a thin strip at each side it reads as a smear.

**Consequences.** Every cover is drawn again once, as its address changes.

## D112. The chapters inside a track

**Decision.** Where a forced alignment hears a chapter's first sentence inside a track (in a track
it trusts), the edition keeps that start, and the track lists its `chapters`: the track list shows
them under a track that holds more than one, each starting playback at its place; the title, the
mini player and the lock screen name the last chapter heard starting at or before the playhead (a
track's first minute counts as its first chapter). A track named as a range ("Chapters 04 to 06")
keeps its own name until its chapters are heard. Where the audiobook came first, its tracks are the
book's chapters, and there are no entries under them.

**Context.** Fidelity review round 17 (FR152): LibriVox's 4-track Jekyll ("Chapter 01 to 03"…)
showed four track names, and the player named the track, even once read along sentence by sentence.

**Rejected.** *Chapters from the tracks' names*: "Chapter 01 to 03" says what, not where. *Splitting
the track into a track per chapter*: the files are the friend's, and seeking within one is exact.

**Consequences.** With the reviewer's pairing all ten chapters are heard and listed under their
tracks; "Search for Mr. Hyde" starts at 16:44 of the first.

## D113. The player says it once; nothing on the bar covers the next stop's flag

**Decision.** The player's subtitle names the track beside the author only where its name says
more than the chapter does (a range, a part, a disc). On the club bar the next stop's flag sits in
the notes' lane; note bubbles and their "+N" move along the lane to stay clear of it; members'
markers are placed as D90 says.

**Context.** Fidelity review round 17 (FR157): "01 - STORY OF THE DOOR · Robert Louis Stevenson"
under "STORY OF THE DOOR"; "+1" over the next stop's flag on a new book's bar.

**Rejected.** *Never naming the track*: a range or a part says where you are in the files.

**Consequences.** None beyond the bar's and the player's words.

## D114. A chapter starts where its text is heard; a track's closing words are the chapter it ends

**Decision.** In the forced alignment (D46) a sentence is timed by the longest run of its matched
words heard one after another in one track, at most four words apart, and ends inside its track. A
chapter starts in the first track that says 20 of its words (half of them, for a short chapter);
what an earlier track's end says of it stays unaligned. A track's closing words, within 90 s of its
end, stay at its last sentence where the next track's first sentence is at most 300 characters on,
so the credits are in the chapter the track ends. Each track's points are simplified on their own.
Read-alongs record the version of these rules (2); one lined up by older rules is lined up again
once, when the server starts.

**Context.** Fidelity review round 18 (FR160, must-fix): LibriVox's "End of chapter 1" was heard
as Chapter II's heading 7 s before the track's end, so Chapter II was listed twice and the credits
played under it; The Time Machine's track 9 listed a phantom "XIII. The Trap of the White Sphinx"
from common words at its end.

**Rejected.** *Telling credits by their words*: English and LibriVox only. *Asking for half of a
sentence's words*: it drops sung lines and nine of The Time Machine's sentences. *Tying each track's
opening to its first sentence*: a chapter's start went to the previous track's last millisecond.
*Simplifying across tracks*: it smoothed the closing point away.

**Consequences.** Alice: 1,597 sentences aligned (the 1,598th was the phantom), every chapter heard
in its own track within 36 s of its start. A chapter whose first words end a track starts in the
next one. Clubs' recordings are lined up again once after the upgrade.

## D115. A track is named by the chapter it holds

**Decision.** The server keeps the chapter each track opens with, from its first sentence lined up,
else its chapter match. A track holding one chapter is named by it in the track list, the title,
the mini player, the lock screen, the note composer ("Pinned at … in …") and friends' labels; one
holding several keeps its own name, tidied, with the chapters under it (D112); where nothing better
is known, the tag is shown tidied: a track number before a name that only numbers its chapter is
dropped ("01 - Chapter I" → "Chapter I"), other tags keep theirs. A title that only numbers its
chapter is never matched by title.

**Context.** Fidelity review round 18 (FR161, FR164): lined up with a club's own Time Machine, "06 -
Chapter 6" stayed in the title and lock screen while its header said "IX. The Morlocks". Tidying
showed a wrong match: "Chapter II" scores 0.5 against "II. The Machine" by their numeral alone.

**Rejected.** *Dropping the number from every tag*: the chapter match pairs by it (D74). *Working
out tracks' chapters in the browser*: the read-along comes a track at a time.

**Consequences.** The Time Machine's tracks read as the book's chapters (Chapter I with I and II
under it, III, IV, …, Epilogue). A recording numbered as the book but in fewer files than chapters
maps in a straight line until it is lined up.

## D116. Continuing with the upstream through its sign-in grant

**Decision.** "Continue with the upstream" uses the upstream's app sign-in grant for client `book-club`, the
one its other apps use: an authorization code with PKCE (S256) for a
callback the upstream has fixed, `https://books.example.org/api/auth/upstream/callback`.
`GET /api/auth/upstream?next=…`, from this app's own pages only (`Sec-Fetch-Site: cross-site` or
`same-site` gets the sign-in page), makes a state and a code verifier (32 random bytes each), keeps
them with `next` and an expiry in a ten-minute cookie of this host's (`__Host-bc_upstream` over
HTTPS, HttpOnly, SameSite=Lax) and sends the browser to `UPSTREAM_START_URL` with the state and the
verifier's SHA-256. The upstream signs the person in on its own pages and sends the browser back with
the state and a code good once, for 90 seconds, or with `error=failed` (without the state when it
lost its own transaction). The callback spends the cookie whatever it brings. It refuses an
`error`, and otherwise needs the cookie, in time, with the same state (compared in constant time);
then the server posts
`{ code, codeVerifier }` to `UPSTREAM_EXCHANGE_URL` (no redirect followed, 10 seconds, at most
16 KiB of answer read) and is told `{ id, name, email, emailVerified }`. The person is upserted by
`upstream:<id>` as before: the name trimmed and cut to 60 characters (else the address's name,
else "Reader"; the upstream's "Phone User" stays as it is), the address only if the upstream verified it and
no account here has it. Every refusal
lands on the sign-in page's "The upstream did not sign you in here", and is logged at warn without the
code, the verifier or the cookie; the request log cuts both out of the callback's address. After
`SIGNIN_ATTEMPTS` codes that did not sign anyone in, one address has none redeemed for the rest of
15 minutes (those that did are not counted). Signing out here simply signs
out: nothing signs anyone in from the upstream unless they choose Continue, which brings them back
without a form while they are signed in at the upstream. This supersedes D52's cookie flow and its hold
(and the `ended_sessions` record the hold needed, no longer written) and D14's JWT adapter. D14's
invite-link accounts stand, and so do D52's protections for upstream accounts: no club of their
own before an invite, name and password upstream, no reset link, never a local account's address
(that last one is superseded by D228 for an address the upstream has verified: the sign-in joins
the account that has it).

The server will not start with any of the cookie adapter's settings (`UPSTREAM_JWT_SECRET`,
`UPSTREAM_JWT_ISSUER`, `UPSTREAM_JWT_AUDIENCE`, `UPSTREAM_COOKIE`, `UPSTREAM_LOGIN_URL`), and the
deploy kit's compose file refuses their `BOOKCLUB_UPSTREAM_*` lines before anything on the host
changes: either would leave Continue off without a word. The two addresses are separate settings
because the browser and the server may reach the upstream by different names (in the demo stack, the
stand-in's published port and its compose name). The stand-in (`tools/fake-upstream/server.mjs`) is
the upstream's grant and nothing else: a sign-in form and a host-only session of its own, a signed
transaction cookie, single-use codes bound to their challenge, the exchange. The demo is reached
as 127.0.0.1 and as localhost, and a browser keeps cookies per name, so on loopback the browser
goes to the stand-in by the name it came to Book Club by and the stand-in sends it back by that
name, to the cookie; a start address that is not on loopback is never changed.

**Context.** A change to the upstream (merged 2026-07-15) made its session cookies host-only on
id.example.com (15-minute access tokens), so no other subdomain receives one.
D52's adapter has signed nobody in since, nor has v1's; on the production site, where v2 has run since
2026-10-25, it was found dead and switched off. The upstream's half of the grant lives in its own
repository.

**Rejected.** *Asking the upstream to share a cookie again*: it made them host-only on purpose, and a
parent-domain cookie reaches every tenant site on `*.example.com`. *A secret shared with the upstream to
check signed tokens (v1's way)*: an upstream key on Book Club's host, and every token a bearer one.
*OpenID Connect with ID tokens*: the upstream runs no such provider, and the grant its other apps use
answers who the person is, which is all Book Club needs. *Redeeming the code from the browser*:
the verifier would be in the page, and the upstream's exchange is not for browsers. *Keeping sign-ins
under way on the server instead of in a cookie*: state for a ten-minute trip, to be cleaned up and
tied to the browser anyway; the cookie is this host's alone (`__Host-`), and what it holds is of no
use without a code that comes back to that browser. *Keeping D52's hold*: nothing signs a device in
by itself now, so there is nothing to hold off. *Letting a sibling subdomain's page start a sign-in
(D52 let `same-site` through for the upstream's pages, which shared the cookie)*: the upstream's tenants'
sites are same-site, and could sign someone back in after they signed out here. *Following the
exchange's redirects, or reading its answer whole*: the code would go where the upstream did not send
it, and an answer could hold the server. *Redeeming every code that comes back*: each exchange
spends the upstream's budget for this server's one address (about 90 in 15 minutes, shared by all of
Book Club's sign-ins), and anyone can send made-up codes with a sign-in of their own under way.
*Counting the sign-ins that work too*: everyone behind one address (a household, the demo stack,
whose browsers all reach the app from one address) would be held up after ten; going round again
and again needs an upstream account and the upstream's pages each time, which the upstream limits per address.

**Consequences.** Continue with the upstream works on the production site once the upstream serves the grant and
the site's `deploy/.env` has `BOOKCLUB_UPSTREAM_START_URL` and `BOOKCLUB_UPSTREAM_EXCHANGE_URL`
(docs/DEPLOY.md, "One identity"). The upstream sends codes for `book-club` to that host only, so no other
deployment can use it. No upstream secret is kept here, the upstream keeps no session for Book Club, and
Book Club's sessions stand on their own as before: an account deactivated, banned (403) or in its
deletion window (409) at the upstream is refused its next sign-in here, and restores or appeals on
the upstream, but keeps the sessions it has here until an owner removes it. Past the upstream's limit for
this server's address (429), sign-ins are refused until its window has passed. Each sign-in goes through
the upstream's pages, with a form only when the person is not signed in there.

## D117. An illuminated-manuscript look: parchment, ink, two themes

**Decision.** The whole web app is restyled after Cole's wiki, an
illuminated-manuscript / commonplace-book look, under a new palette in `apps/web/src/styles/base.css`:
`--desk`, `--paper`, `--paper-2`, `--paper-3` (parchment surfaces), `--ink`, `--ink-2`, `--ink-3`
(text), `--rule` (borders), `--sanguine`/`--sanguine-2` (a brick-red accent, wash variants), and
`--verdigris` (a quieter green accent). Two themes carry it: "vellum" (light, the default) and
"lucerna" (dark, lamplight; D118 picks between them). Every token name the app already had
(`--bg`, `--surface`, `--text`, `--gold`, `--danger`, `--radius`, `--font-ui`, …) is kept and
aliased onto the new palette, so every other screen and every other workstream's code that reads
those tokens repaints with the new look without any of it changing. Rectangular surfaces (cards,
modals, toasts, inputs) move from the old 8/12/20 px radii to a crisper 2/3/6 px, matching the
manuscript's ruled-box feel; round tap targets (buttons, chips, avatars, icon buttons) stay fully
round — Cole's instruction was taste, not a museum piece, and a phone's circular tap targets read
better than a boxy "commonplace-book" literalism would. A small number of literal colours that
could not be token aliases (the app bar's frosted glass, a radial highlight, a few glows) move to
`color-mix(in srgb, var(--token) X%, transparent)` so they track the active theme too.

**Context.** Fetched the wiki's home page and its one stylesheet
(`/_astro/Base.*.css`) directly and read it closely: the exact hex values, the `data-theme`
attribute mechanism, the token names, and which of a near-duplicate pair of accent colours
(`--sanguine` vs `--sanguine-2`) the wiki actually uses as real text versus as a decorative stroke
only (see D124). Re-used that palette verbatim rather than inventing a similar one, since the brief
asked for *this* look specifically and the wiki's own values are already proven: paper grain,
shadow, and type-scale tokens too.

**Rejected.** *A single always-dark theme, recoloured* (what the app had before): drops half of
"follows the system" (D118) for no gain. *Keeping the old 8/12/20 px radii*: reads as a rounded
app-UI kit sitting on top of a manuscript palette, not a manuscript; the crisp radii is what makes
the card/toast/modal surfaces look like ruled leaves rather than cards with a new coat of paint.
*Inventing a new palette inspired by the wiki rather than reusing its values*: more work, no
benefit, and risks missing the contrast tuning the wiki already has.

**Consequences.** Every screen (sign-in, invite, library, club, book page, upload, both readers,
the audiobook player, notes/discussion, notifications, meeting point, people/presence, settings,
dialogs, toasts, splash, offline states) repaints from this one file. D118–D124 cover the theme
switch, the type, and the few things that needed more than a token value to change.

## D118. The app theme follows the system, with a saved override, set before first paint

**Decision.** `<html data-theme>` is "vellum" or "lucerna" (D117), chosen the same way the wiki
does: the reader's saved choice (`localStorage['bookclub:theme']`) if there is one, else
`prefers-color-scheme`. It is set by a classic, external, same-origin script,
`apps/web/public/theme-init.js`, the first thing in `<head>` — not inline, because the CSP this
server sends (`script-src 'self' 'wasm-unsafe-eval'`, no `unsafe-inline`, no hash;
`apps/server/src/routes/static.ts`) would silently never run an inline one, and nothing in this
task calls for loosening that CSP. `apps/web/src/lib/theme.ts` (`loadTheme`, `saveTheme`,
`applyTheme`, `useAppTheme`) mirrors the same logic for a live change from Settings (a new
"Appearance" section, `SettingsPage.tsx`), and keeps the painted theme in step with the system
while the reader's choice is "match device". Two `<meta name="theme-color">` tags (one per
`prefers-color-scheme`) replace the old single dark one; `color-scheme` is `light dark`.

**Context.** The wiki's own inline script (`localStorage.getItem('codex-theme') ||
matchMedia(...).matches ? 'lucerna' : 'vellum'`) was read directly from the fetched page; its site
has no CSP at all, so it can inline this. Checked `apps/server/src/routes/static.ts`'s `appCsp`
before writing anything, confirming `script-src` has no exception that would let an inline block
run.

**Rejected.** *Adding a CSP nonce or hash for one inline script*: touches the server's security
posture for a styling change, and a tiny external file does the same job with no such cost (one
extra same-origin request, cached after the first load like `sw.js` already is). *Defaulting to
"lucerna" for everyone, as before*: throws away "follows the system" for every new sign-in.
*Deciding the theme only in React, after mount*: paints the wrong theme for a frame (a visible
flash) on every load; the whole point of the wiki's technique is painting it before the first paint.

**Consequences.** A first-time visitor gets whichever theme matches their device; anyone who picks
one in Settings keeps it until they pick "Match device" again. `theme-init.js` and the font files
(D119) are globbed into the service worker's precache (`vite-plugin-pwa`'s existing
`globPatterns` already covers `js` and `woff2`), so this works offline too.

## D119. Self-hosted type: EB Garamond, Cinzel, Italianno, JetBrains Mono, Latin only

**Decision.** Four faces, one origin, Latin and Latin Extended subsets only (no Cyrillic, Greek or
Vietnamese glyph files ship): EB Garamond Variable (running text, `--font-text`), Cinzel (display
and small-caps-feel labels, `--font-display`), Italianno (a hand flourish, `--font-hand`, used
sparingly — D120), JetBrains Mono Variable (`--font-mono`). Sourced from the named `@fontsource`
packages (kept as `devDependencies` in `apps/web/package.json` for provenance and the OFL
licence), but the actual `.woff2` files are hand-picked (only the Latin/Latin-Extended, normal and
(for EB Garamond) italic ones) and committed under `apps/web/public/fonts/`, with a hand-written
`apps/web/src/styles/fonts.css` of `@font-face` rules rather than importing the packages' own CSS.
`font-display: swap` throughout; the EB Garamond Latin-normal file is `<link rel=preload>`'d in
`index.html`; the type scale (`--step--1`…`--step-3`, clamp()-based) and `--measure: 40rem` come
from the wiki's own tokens.

**Context.** Each `@fontsource` package's own `wght.css`/`index.css` references every subset's
`.woff2` (Cyrillic, Greek, Vietnamese, Latin, Latin Extended) via `url()`; because Vite resolves
and copies every `url()`-referenced asset a CSS file imports into the build regardless of whether
the browser's `unicode-range` would ever fetch it at runtime, importing those files whole would
ship glyphs for scripts this app never needs. The static (non-variable) packages happen to expose
a `latin.css`/`latin-ext.css` entry point that avoids this; the two variable ones (EB Garamond,
JetBrains Mono) do not, which is why their `@font-face` rules are hand-copied instead of imported.

**Rejected.** *Importing each package's full CSS*: ships four scripts' worth of glyphs nobody
reads. *A Google Fonts or other CDN link*: "one origin, no CDN" was explicit in the brief, and
self-hosting is also what the wiki itself does. *Shipping every weight each face offers*: Cinzel
ships 400 and 700 only (what the restyled headings and the wordmark actually use); Italianno ships
400 (its only weight); JetBrains Mono ships one static file (its variable weight axis covers every
weight an element might ask for).

**Consequences.** About 400 KB of font files total, none of which loads unless its script or style
is actually used on the page (the browser skips a `unicode-range` it never needs, and
`font-display: swap` means a slow font load never blocks text from appearing). D122 covers getting
EB Garamond into the EPUB reader's iframe, a separate document that cannot see the app shell's
`<style>`.

## D120. The hand flourish and the folio label, used sparingly

**Decision.** `--font-hand` (Italianno) is wired into the token system (D119) but not placed
anywhere in this pass: the brief's "with taste… not a museum" stood against adding a flourish
without a specific, considered place for one, and inventing one was out of scope for a token and
font pass. `.folio-label` (`apps/web/src/styles/base.css`) is the one concrete decorative utility
added: a small, uppercase, letter-spaced `--font-display` tag, the way the wiki marks a running
head or a kicker — defined, but likewise not forced onto existing copy (the reader's page-number
read-out, "Page 47 / 312", keeps its exact text and only gained the surrounding palette; renaming
it to a folio-style "f. 47r" was weighed and rejected, next).

**Context.** The brief gives "f. 12r" as an *example* of the aesthetic system ("folio-style
labels… rules and ornaments… used with taste"), not a mandate to rename every page number. Several
tests assert the page reader's exact numbering strings and `data-total`/`data-page` attributes
(`reader-pages.spec`, `layout.test.ts`); nothing about the look required changing what they say.

**Rejected.** *Renaming "Page 47 / 312" to a folio form*: changes a reader-facing string with no
look-only justification, for a feature this workstream was not asked to revisit, and would touch
tests outside the look's scope. *Adding Italianno somewhere just to use it*: decoration without a
reason reads as the "museum piece" the brief warned against; better to leave the hook in the token
system for whichever future screen earns it.

**Consequences.** `--font-hand` and `.folio-label` are available tokens/utilities for later work
(this app's own future screens, or another workstream) without this pass forcing a specific use of
either into existing, tested copy.

## D121. The reader's four themes, renamed and recoloured to match

**Decision.** The EPUB/PDF reading-surface themes (`apps/web/src/reader/epub/layout.ts`,
`ThemeName`) are renamed from `night`/`day` to `lucerna`/`vellum` — the same two names as the
app's own light/dark theme (D117/D118) — and `dusk`/`sepia` keep their names; all four are
recoloured from the manuscript palette. The default reader theme changes from `night` to
`lucerna` to match. All four pass WCAG AA (≥4.5:1) for their body text and muted-caption colour
against their own background.

**Context.** `ThemeName` is a plain string union read dynamically everywhere it is used
(`theme-${name}` CSS classes in `EpubReader.tsx`/`PdfReader.tsx`, `Object.keys(THEMES)` in
`panels.tsx`), so the rename needed no changes there; only the two app.css selectors that hard-code
`.theme-night`/`.theme-day` (the PDF canvas filters) and the handful of tests that assert the
literal theme-name strings (`layout.test.ts`, `settings.test.ts`, e2e `a11y.spec`;
`pdf-pwa-settings.spec` unaffected — it only names `sepia`) needed updating.

**Rejected.** *Keeping `night`/`day`*: leaves the reading surface's names disconnected from the
app's own theme names, after specifically choosing those names (D117) to read as one system.
*Adding a migration or a compatibility alias for the old names*: reader theme is a device-local
setting (`localStorage`, never synced to the server — confirmed nothing server-side references
`ThemeName`); `settings.ts`'s existing `Object.hasOwn(THEMES, …)` validation already resets an
unrecognised stored value to the default, so a device with `night` saved just resets once, with no
special-casing needed.

**Consequences.** `settings.test.ts` and `layout.test.ts` were updated (not skipped or weakened) to
assert the new names and colours, each with a comment pointing at this decision, per the rule
against changing a test without saying why the intended behaviour changed.

## D122. EB Garamond as the reader's serif, self-hosted into its own iframe

**Decision.** The EPUB reader's `serif` font choice (one of three the reader already offered;
`DEFAULT_SETTINGS.font === 'serif'`, unchanged) now resolves to `'EB Garamond Variable', 'EB
Garamond', ui-serif, …` instead of the OS's own serif, so a book read in the default font reads in
EB Garamond, matching the brief's "book text in EB Garamond by default. Keep the font choices
users have." Each EPUB section renders in its own sandboxed iframe (`epub/frame.ts`), a separate
document that does not inherit the app shell's `<style>`, so `readerCss()`
(`apps/web/src/reader/epub/layout.ts`) now also injects the EB Garamond `@font-face` rules
(`READER_FONT_FACES`, Latin/Latin-Extended, normal and italic) into every section's stylesheet. The
`.woff2` files are the same ones at the same `/fonts/...` URLs the app shell preloads (D119), so
the browser's cache serves every section after the first for free.

**Context.** Read `epub/frame.ts` and `epub/layout.ts` to confirm each section is a genuine new
`<iframe>` document (`sandbox="allow-same-origin allow-scripts"`, `iframe.src = url`), and that its
CSS is a plain `<style>` tag built from `readerCss()`'s template string — there is no built-in way
for it to see fonts declared in the parent document's stylesheet. Checked that the CSP
(`font-src 'self' data:`) is inherited by a `blob:`-sourced document from the context that created
the blob (the top page's own origin), so an absolute `/fonts/...` URL from inside the iframe
satisfies `'self'` even though the iframe's own origin is opaque.

**Rejected.** *Leaving the reader's "serif" choice as the OS font*: ships the whole font system
everywhere except the one place books are actually read, missing the brief's explicit requirement.
*A `<link>` to the font stylesheet inside each section's iframe*: an extra network round trip per
section load for a stylesheet that never changes; inlining the same handful of `@font-face` rules
costs a little under 2 KB of repeated text per section and no extra request. *Renaming the reader's
font choices, or adding a fourth*: out of scope — "keep the font choices users have."

**Consequences.** `layout.test.ts`'s check that choosing the publisher's own font leaves no
`font-family` *override* on the body had to be narrowed to just the `body { … }` rule (the
`@font-face` blocks always declare `font-family: 'EB Garamond Variable'`, which is correct and
unrelated to what the test was protecting — that the publisher's font is never forced on the
text); the pagination-safety test (the stylesheet's hash moves the layout signature, D86's
mechanism) needed no change, since it already hashes the whole stylesheet including the new rules.

## D123. `--radius` tightened; the manuscript's grain, shadow and rule tokens added

**Decision.** `--radius-s`/`--radius`/`--radius-l` move from 8/12/20 px to 2/3/6 px (see D117 for
why only rectangular surfaces, not round tap targets, change). New tokens land alongside the
aliases: `--shadow-paper` (the warm, ink-tinted shadow `--shadow` now points to), `--grain` (a
low-alpha SVG turbulence filter, the wiki's own, as the page background's paper-fibre texture),
`--measure` (40rem) and the `--step-*` clamp() type scale (D117/D119).

**Context.** The wiki defines a `--grain-opacity` token but never actually applies it anywhere in
its one stylesheet (confirmed by grep across every rule that uses `--grain`); it was dropped here
rather than carried over unused and undocumented.

**Rejected.** *Carrying over `--grain-opacity` unused, for parity with the wiki*: a dead token
invites a future reader to wire it up to nothing, or to assume it already does something.

**Consequences.** Cards, modals, toasts and form fields read as ruled parchment leaves rather than
a rounded app-UI kit; buttons, chips, avatars and icon buttons (`999px`, unchanged) keep comfortable
circular tap targets.

## D124. `--gold-strong`'s two shades swap which is "stronger" per theme, to hold AA

**Decision.** `--gold-strong` — read as a foreground text colour all over the app (`a { color:
var(--gold-strong) }` in `base.css`, plus a dozen more places) as well as a hover/emphasis
background — resolves to a *deep* sanguine (`#7a2c17`, darker than `--sanguine` itself) in vellum
(light), and to `--sanguine-2` (lighter than `--sanguine`) in lucerna (dark). `--gold` (the base,
non-emphasis token) stays `--sanguine` in both themes.

**Context.** The wiki's own CSS uses `--sanguine` for every real link/text colour and
`--sanguine-2` only for decoration (an underline stroke, a paragraph-mark glyph, a hand-written
flourish, two SVG strokes — confirmed by grep: it is never once a `color` on real body text).
Checked why: `--sanguine-2` (`#b8552f` in vellum) against `--paper` (`#f4ead2`) computes to about
4.0:1 — below the 4.5:1 WCAG AA floor for normal text — while `--sanguine` (`#93361c`) computes to
about 6.3:1. In lucerna the opposite holds: `--sanguine-2` (`#f2b08e`, lighter) has *more* contrast
against the dark paper than `--sanguine` does, so the wiki's own theme never needed to pick between
them for text. This app's pre-existing `--gold`/`--gold-strong` pair, inherited from the old
always-dark palette, is used as real text in many more places than the wiki's own markup is, so a
literal `--gold-strong: var(--sanguine-2)` in vellum would have shipped an AA failure on every link
in the light theme.

**Rejected.** *Aliasing `--gold-strong` to `--sanguine-2` in both themes, matching the wiki's token
names one-for-one*: fails AA in vellum, as above — axe would catch this on nearly every page.
*Making `--gold` and `--gold-strong` equal in vellum (no hover distinction)*: sidesteps the
contrast failure but silently drops the hover/emphasis affordance the token pair exists for.
*Auditing and hand-fixing each of the dozen or so call sites instead of the token*: more surface
area to get right, and the next new use of `--gold-strong` would be one audit away from the same
mistake; fixing the token once is correct for every present and future caller.

**Consequences.** `--gold`/`--gold-strong` keep meaning "base / emphasis" consistently in both
themes (the "stronger" one is always whichever reads with more contrast against that theme's
paper), and every existing caller — text, links, hover backgrounds, the skip link, the spinner's
accent — stays at ≥6:1 contrast without having been touched individually. `e2e/tests/polish.spec`'s
literal RGB expectations for `--gold-wash`/`--gold-dim` (unaffected by this decision, but repainted
by D117) were updated with a comment for the same reason.

## D125. Backups become an incremental, content-addressed set, bounded by what is in use

**Decision.** Daily backups (the `backup` compose service) move from fourteen FULL tarballs to one
incremental set: `bookclub backup --set DIR --keep N` writes a dated, gzip'd SQLite snapshot
(`VACUUM INTO`, checked with `PRAGMA integrity_check`) to `DIR/db/bookclub-<UTC>.db.gz` plus a
sidecar manifest, and copies each blob and publication file the snapshot needs into
`DIR/files/blobs/<sha256[0:2]>/<sha256>` and `DIR/files/pubs/<sha256[0:2]>/<sha256>` — content-
addressed stores shared by every snapshot, so a file already in its store, under the content it
holds now, is never copied again. The same command prunes to the newest `keep` snapshots (default
14, same `BOOKCLUB_BACKUP_KEEP`) and removes every stored file no kept snapshot's manifest still
names (`cli/backup-set.ts`). `deploy/compose.yaml`'s `backup` service now runs
`bookclub backup --set /backups --keep $keep`; its healthcheck looks for a snapshot under
`/backups/db` instead of a loose tarball.

**Context.** `apps/server/src/cli/backup.ts` (D51) copies the whole data directory into one
`.tar.gz` per run; the compose service keeps the newest 14. At 2.3 MB today that is nothing, but
Cole and a friend are about to upload the Red Rising series (six-plus audiobooks, roughly 0.5-1 GB
each, plus EPUBs): fourteen full copies of even one pass through that library is tens of GB, on a
shared production host with 30 GB free and other sites on the same disk. Full
copies also make the host's own nightly backup of `/opt` (outside this
repo) ship the same bloat every night.

**Rejected.** *Lower `BOOKCLUB_BACKUP_KEEP` instead*: buys time, not bounded; the next book series
blows through whatever number is picked. *rsync `--link-dest` hardlink trees*: needs every snapshot
on the same filesystem as the last, breaks the moment a backup directory is a different volume or
mount (D127 still needs one portable file, which a hardlink farm cannot be), and secure_delete-style
tooling and some backup transports (tar, rsync without `-H`, S3 sync) do not preserve hardlinks
anyway, silently duplicating the content they were meant to share. *Append-only, never pruned*:
solves today's problem and creates tomorrow's — the whole point is a backup that does not grow
without bound. *Deduplicate at the filesystem level (ZFS/Btrfs snapshots)*: a real option, but it
ties the backup format to a specific filesystem the production host does not run, and still needs
its own retention policy; the application already knows which files are which (blob ids, content
hashes), so dedup in `bookclub backup` is portable and host-independent.

**Consequences.** Local backup size now tracks what is actually stored (blobs database rows) times
roughly once, not `keep` times the whole library; deleting a book's files from the live store (D45,
D126) lets a prune eventually drop the backup set's copies too, once no kept snapshot still names
them. `bookclub backup --out`/`restore --from` (single-file, D127) are unchanged, still used by
`scripts/deploy-drill.sh` and for moving to a new host. Size math: a club's audiobooks and EPUBs
dominate; fourteen full copies of the Red Rising series (roughly 5 GB once) would be ~70 GB, where
the incremental set stays close to 5 GB regardless of `keep`, since each file is stored once and
pruned only once nothing needs it.

## D126. Publication files are content-addressed by a backup-computed sha256, not a mirrored path

**Decision.** `backupSet` (D125) stores publication files (an EPUB's unpacked chapters and
manifest, a PDF's printed text, `storage.ts`'s `pubs/<editionId>/…`) the same way as blobs — by
content, under `files/pubs/<sha256[0:2]>/<sha256>` — but the sha256 is computed by the backup
itself when it runs, since nothing in the database records one for these files (unlike `blobs.sha256`).
The snapshot's manifest maps `(editionId, path) → sha256` for restore.

**Context.** `storage.ts`'s own comment calls publication files, like blobs, "content-checked and
never modified", but reading `ingest/pipeline.ts` shows that is true only within one ingest: a
re-ingest (`ingestEpub`, `printedTextOf`) calls `storage.removePub`/`rm` on the whole directory and
rewrites it from the edition's still-immutable main blob. In the ordinary case the rewrite produces
the same bytes (same input, same deterministic parse), but a parser fix or a re-run with different
options can legitimately write different bytes at the same path. A backup that mirrored live paths
and overwrote its stored copy on a change would silently corrupt every older, still-kept snapshot
that names that path: its manifest would point at the SAME on-disk file, now holding the NEWER
content, and restoring that older snapshot would come back wrong without any error (there is no
recorded hash to catch it, since publication files have none).

**Rejected.** *Mirror the live path and overwrite on change*: the silent cross-snapshot corruption
above. *Re-back-up only the editions a re-ingest actually touched, tracked some other way*: more
moving parts (a change log, a trigger), still racy if a backup runs mid re-ingest, and does not
remove the need to detect a changed file — just moves where that detection has to live. *Leave
publication files out of the backup and regenerate them on restore*: turns a restore into a second
ingest pass (parser, worker limits, time, and a result that depends on the parser version at
restore time, not at backup time) — no longer "restore brings back exactly what was there", and a
PDF's printed text (`PRINTED_FILE`) is not even always regenerable without the recogniser/limits
used originally. *Hash only once and trust it forever*: the entire reason this decision exists is
that trusting a live path without checking content is what breaks.

**Consequences.** A pub file hashed daily costs little (these are the parsed/derived files — HTML,
JSON manifests, printed text — never the multi-hundred-MB audio blobs, which keep their recorded
hash and are never rehashed). Two snapshots that captured the same edition's unchanged publication
share one stored copy; a snapshot taken after a legitimate content change gets its own copy under
its own hash, and an older snapshot that still names the old hash keeps restoring the old bytes
until it is pruned. Verified directly in `apps/server/test/cli.test.ts` ("keeps an older snapshot
restorable after a publication file is rewritten with different bytes").

## D127. The one-file `backup --out`/`restore --from` stays exactly as it is, beside the set

**Decision.** `cli/backup.ts`'s single-file `bookclub backup [--out FILE]` and
`bookclub restore --from FILE [--force]` (D51) are unchanged — same tarball, same checks, same
code. The incremental set (D125) is a second, additional mode (`--set DIR` / `--from-set DIR`), not
a replacement.

**Context.** The brief for this work asked explicitly to "Keep the single-file `bookclub backup
--out x.tar.gz` / `restore x.tar.gz` working (drills, moving hosts)." `scripts/deploy-drill.sh`
already exercises it, and it is the only form that is one portable artifact: `scp` it to a new host,
or keep one beside a VM image, with nothing else to carry along.

**Rejected.** *Fold everything into one format*: an incremental set's whole value (D125) is files
shared, by content, across many snapshots and pruned independently — exactly the opposite of "one
file, self-contained". Making the set exportable as a single file would mean re-assembling a full
copy anyway, which is the thing being avoided. *Drop the single-file mode, keep only `--set`*:
breaks the drill and the documented "move to a new host" path, which want exactly one file, not a
directory tree whose files are shared with a store the new host does not have.

**Consequences.** Two code paths, two sets of tests, both exercised by `scripts/deploy-drill.sh`
(the single file as a quick manual backup and a scratch-directory restore check; the incremental
set for the real disaster-recovery drill). Operators choose the tool for the job: `--set` for the
daily, bounded, off-host-synced (D129) backup; `--out`/`--from` for a drill or a one-time move.

## D128. Retention stays N snapshots; the healthcheck now means "a snapshot under db/ exists"

**Decision.** `BOOKCLUB_BACKUP_KEEP` keeps its name and default (14), now counting incremental
snapshots instead of tarballs; `bookclub prune --set DIR --keep N` is also its own CLI command, for
an operator who lowers `keep` without waiting for the next scheduled backup. The `backup` service's
healthcheck (`deploy/compose.yaml`) looks for `bookclub-*.db.gz` under `/backups/db` younger than
the backup interval plus an hour, in place of the old `bookclub-*.tar.gz` glob on `/backups` itself.

**Context.** The old healthcheck and retention logic (`ls -1t ... | tail -n +$((keep+1)) | xargs rm`)
assumed every backup was one self-contained file at the top of `/backups`; the incremental set's
snapshots live under `/backups/db` and reference a shared `/backups/files` store that the naive
`ls`-and-`rm` approach would never prune correctly (it would delete snapshot manifests without
touching the files they alone referenced, or the reverse).

**Rejected.** *Keep the old shell one-liner, point it at `/backups/db`*: it would delete old
snapshot files correctly, but leave their referenced blobs and publication files in `/backups/files`
forever — defeating D125's whole purpose. *A separate cron/timer for pruning*: another moving part,
another thing to keep in sync with `keep`, when the backup run already knows the newest snapshot
it just wrote and can prune in the same step.

**Consequences.** `bookclub backup --set` always prunes after writing, so the set never grows past
roughly `keep` days' worth of *changed* content, not `keep` times the whole library (D125). A human
can also prune on demand (`bookclub prune --set DIR --keep N`), e.g. right after lowering `keep`,
without waiting a day. `pruneSet` never drops below one snapshot, even with `--keep 0`: a backup set
with zero backups in it is not a backup set.

## D129. Offsite copy to S3: a one-way, non-deleting sync of the already-bounded local set

**Decision.** `deploy/offsite/bookclub-offsite-s3.sh` plus `bookclub-offsite-s3.service` and
`.timer` (systemd, run as the deploy user, after the daily backup) `aws s3 sync` the incremental
backup set (D125) to `s3://$BOOKCLUB_OFFSITE_BUCKET/$BOOKCLUB_OFFSITE_PREFIX/` — `db/` to a
`daily/` prefix (so a lifecycle rule can expire it by age), `files/` to a `files/` prefix (content-
addressed, so sync is naturally incremental: an unchanged file is never re-uploaded). The `aws`
invocation is configurable (`BOOKCLUB_OFFSITE_AWS`, e.g. a wrapper that supplies the host's AWS
credentials), so it also runs as plain `aws --profile X` elsewhere. The sync never passes
`--delete`: the agent role it runs under is granted `s3:ListBucket` on the bucket and
`s3:PutObject`/`s3:GetObject` on `book-club/*` only — no delete action — so objects already offsite
are never at the mercy of a bug in this script or a compromised deploy-user credential. A failed
sync exits non-zero and logs to the journal; it never touches local data either way. The bucket and
its lifecycle/versioning/encryption, and the exact IAM policy statement, are documented in
`docs/DEPLOY.md` ("Offsite copy (S3)") as one-time admin commands, not run by this change: the
agent role cannot create buckets or touch IAM, and the bucket had not been created yet.

**Context.** Cole asked to "hook it up to S3": a second, independent offsite copy in AWS, beside
the host's own backup of `/opt` (D125's context) and separate from it. Tested for real
against a local MinIO container on a development host (`aws --endpoint-url`), including a full restore
drill (sync the set down, then `bookclub restore --from-set`).

**Rejected.** *`aws s3 sync --delete`, matched by a versioned bucket's noncurrent-version window as
the undo*: recoverable, but it requires `s3:DeleteObject` on the agent role, which that
role is deliberately not granted here — the automation that runs nightly, unattended, should not be
able to remove what is already safely offsite, even behind a recovery window. Local pruning (D128)
already bounds the LOCAL copy; the offsite copy is allowed to be the more conservative, accumulate-
only one, since an admin can clean it up by hand if it ever needs to shrink. *Sync the old single
full tarballs*: ~14x the data moved nightly, defeats the content-addressing that makes `aws s3 sync`
incremental in the first place. *A cron job instead of a systemd timer*: the host already uses
systemd (docs/DEPLOY.md's other services); a timer gets `journalctl` logs and `systemctl status` for
free. *Creating the bucket and IAM policy from this change*: the agent role that runs this work has
no bucket or IAM rights on this AWS account, by design (coordinator/admin action only); the exact
commands are written down instead of run.

**Consequences.** The local backup set stays bounded (D125, D128); the S3 copy, lacking delete
rights, instead relies on the bucket's lifecycle rule (`daily/` objects expire at 90 days) to bound
the snapshot history offsite, while `files/` objects (blobs, publication files) accumulate until an
admin with real IAM/S3 rights prunes them by hand — a known, deliberate tradeoff: automation here
can add and read, never delete, so a bug or a stolen deploy-user credential cannot erase the offsite
copy. Restoring from S3 is sync-down-then-`restore --from-set`, documented and drilled against
MinIO; restoring from the host's own backups or from S3 both land on the same `restore --from-set` code
path as a local disaster recovery (D125's drill).

## D160. Cal: native text and voice assistant, Claude as the one brain

**Decision.** Book Club gets a native AI assistant, Callimachus ("Cal"): a warm, erudite, concise
librarian persona (never twee), answering any question — the club's books or anything else — in
text and in voice. Text chat runs through the Anthropic API (`apps/server/src/cal/anthropic.ts`,
model `CAL_MODEL`, default `claude-opus-5-5`, configurable), streamed over SSE, with tool use
(`search_library`, `get_passage`, `whats_my_place`, Anthropic's server-side `web_search`) and
prompt caching on the system prompt and the fixed tool list. Voice (D167) runs the same brain:
speech-to-text, then the exact same `runChatTurn` text chat uses (same persona, same tools, same
spoiler rule), then streaming text-to-speech — never a separate speech-to-speech model with its
own instructions, so Cal cannot drift into a second mind with a second set of rules.

**Rejected.** *A speech-to-speech realtime model (OpenAI Realtime, Gemini Live, Grok voice) as the
voice brain*: lower turn latency, but a second system prompt, a second tool-calling surface and a
second place to enforce the spoiler rule to keep in lock-step with text chat forever; one brain
beat a faster but divergent one (measured latencies: D167). *A single global model string with no
config*: a server without a key must still boot and must never need a code change to swap
providers; `CAL_MODEL`/`CAL_EMBEDDING_PROVIDER`/`CAL_STT_PROVIDER`/`CAL_TTS_PROVIDER` are all env
vars (docs/DEPLOY.md). *Building Cal as an Anthropic Managed Agent (CMA)*: Cal's tools need this
server's own DB and the spoiler gate in-process; a session-per-sandbox model fits an agent with its
own filesystem, not a tool surface this tightly coupled to the app's own data.

**Consequences.** Without `ANTHROPIC_API_KEY` set, every Cal route 404s and the web app hides him
entirely (graceful absence, not a broken button). `CAL_TEST_FAKE_MODEL` (never set in production,
docs/DEPLOY.md) swaps in a deterministic stand-in (`cal/fake-model.ts`) so the E2E suite exercises
the real route, the real gate and real search without a key or real spend.

## D161. Hybrid search: FTS5 BM25 + brute-force cosine in a worker, fused by RRF

**Decision.** Every indexed chunk (a book edition's text, or something fed to Cal's shelf) gets a
row in `cal_chunks` plus an FTS5 virtual table (`cal_chunks_fts`, external-content, trigger-synced)
for BM25 search, and a float32 vector in `cal_embeddings` (one row per chunk, provider+model
tagged) for cosine search. A query runs both halves (`apps/server/src/cal/search.ts`) and fuses the
two ranked lists by reciprocal rank fusion (`packages/shared/src/cal/rrf.ts`, k=60, the paper's
default). Vector search is brute-force cosine (`apps/server/src/cal/vector-math.ts`): scored
inline below `INLINE_THRESHOLD` (1,500 candidates) and in a persistent worker thread above it
(`vector-search.ts`, the same "one worker, reused, request/response by id" shape as the existing
track reader and aligner workers), never sqlite-vec. Embeddings are pluggable
(`apps/server/src/cal/embeddings/`): OpenAI `text-embedding-3-small`/`-large` (default), Gemini
`gemini-embedding-001`, and a deterministic hashed-bag-of-words fake for tests (no network, no
key, same input always gives the same vector, and texts sharing words land closer together —
enough to exercise real cosine similarity in CI).

**Context.** `scripts/cal-bench.ts` measures brute-force cosine at 500 / 1,500 / 5,000 / 20,000 /
50,000 chunks, 1536-dim vectors (text-embedding-3-small's), run on a development host
(`pnpm --filter @bookclub/server exec tsx scripts/cal-bench.ts`); numbers recorded below once run.
A whole series the size of the brief's example (~1.5M words of public-domain text) chunks, at this
project's ~420-token windows, to roughly 1,500-5,000 chunks — inside or just past
`INLINE_THRESHOLD` — so most clubs, even an enthusiastic one with several long series and a full
shelf, stay well under "tens of thousands": the threshold is set from headroom, not from a club
that is expected to exist.

**Rejected.** *sqlite-vec from the start*: another native extension to build and ship for every
platform, for a brute-force scan this project's numbers show is fast enough at the sizes a handful
of friends' clubs reach; worth adopting only if a future measurement at real scale says otherwise
(the threshold and the scores are both in this decision precisely so that call can be made from
evidence later). *A separate vector database (e.g. a service of its own)*: one more container,
one more thing to back up, for data that fits in the SQLite file everything else already lives in.
*Reranking by the LLM on every search*: real latency and cost on every tool call; left optional
(`search_library`'s results are already RRF-fused and spoiler-gated; a future rerank pass can sit
on top without changing the stored data).

## D162. Cal's spoiler gate: reuse the reader's own gate, exclude unstarted series books entirely

**Decision.** Cal's book search (`apps/server/src/cal/gating.ts`, `CalGate`) returns a chunk only
when the asker has read every word it holds: it reuses `services/gating.ts`'s `Gate` class (a new
public `readSpans(reading)` accessor, additive, changes nothing existing) to get the asker's own
read spans on the book's timeline — the exact same spans the comment gate judges by — and requires
a chunk's `[t_start, t_end]` to be fully covered by them (`rangesCover`). A book that belongs to a
series (`books.series_id`/`series_order`, migration 012; a new `series` table an owner can create
and assign books to, or left to a book's own metadata when that exists) is left out of the
candidate set entirely — before full-text or vector search even runs on it — unless the asker has
ever opened any book of that series at all. Two overrides, both series-scoped only: a standing
per-user setting ("Cal may use the whole series", `cal_settings.whole_series`) and a per-question
toggle (`wholeSeries` on the chat request) each lift both the exclusion and the position filter for
every book of that series; neither touches a standalone book outside any series. Cal's system
prompt (`anthropic.ts`) binds the same rule on his own training knowledge: told the asker's place,
he must hold back what he knows of a famous book's plot beyond it, exactly as he holds back the
club's own text, unless told an override is on.

**Rejected.** *Filtering client-side after the model answers*: the model would have already read
the spoiler to produce the answer; nothing can be redacted from the output of an LLM that was
shown it. *A whole-series toggle that lifts gating for every book, not just the asker's series*:
tested explicitly (e2e/tests/cal.spec.ts) that a standalone book's gate holds with the flag on —
"whole series" must never become a general spoiler bypass by accident. *Trusting the model's own
`[[cite:ID]]` markers at face value*: a citation is re-verified against the gate and against the
set of chunk ids actually offered to the model this turn before it is ever shown to anyone
(`anthropic.ts`'s `citationFor`); a marker naming anything else is dropped silently, never
surfaced as an error that would itself leak that something exists there.

## D163. Cal's shelf: member-fed material, never spoiler-gated, fetched SSRF-safely

**Decision.** A member may feed Cal material beyond the club's books ("Cal's shelf",
`cal_shelf_items`): upload a PDF, EPUB, TXT or MD (20 MB cap, `MAX_SHELF_UPLOAD_BYTES`), or paste a
URL, fetched server-side (`apps/server/src/cal/safe-fetch.ts`): only http(s), every hostname (and
every redirect's) resolved and checked against private/loopback/link-local/unique-local/CGNAT
ranges before connecting, a 15 MB cap, a 15 s timeout, at most 5 redirects. Extraction is plain and
format-specific (`shelf-extract.ts`): an EPUB's spine text, a PDF's page text (pdf.js, the same
`openPdf` the book-ingest pipeline uses), a regex-based HTML-to-text strip for a fetched page (no
Readability dependency), or the file as-is for TXT/MD. Shelf chunks are indexed exactly like a
book's (same chunker, same embeddings) but carry no `t` and are therefore never spoiler-gated —
general material fed to Cal is not part of any book's story.

**Connect-time check (amended at merge, 2026-10-28).** The first version resolved and checked a
name, then let `fetch` resolve it again to connect: a gap a hostile DNS server can use (DNS
rebinding, public on the check, private on the connect). Every connection now goes through
`node:http`/`node:https` with `checkedLookup` as its `lookup`: the name is resolved once, at connect
time, every address must be public, and the socket connects to the very address that was checked;
redirects take the same path. The body is read under the cap as it streams (a chunked response
with no Content-Length could otherwise fill memory before the cap was checked), one timeout covers
the whole fetch, redirects included, and an IPv4 address written as IPv6 (`::ffff:10.0.0.1`,
NAT64's `64:ff9b::…`) is judged as the IPv4 address it is. Tested in `safe-fetch-rebinding.test.ts`
(a name that resolves to loopback is refused without a connection).

**Rejected.** *A second resolve-and-compare before connecting*: still two lookups, still a window.
*The `undici` package's `Agent` with a custom `connect.lookup`*: the same idea as `checkedLookup`
with a new dependency for it; `node:http` already takes a `lookup`.

## D164. Re-indexing and resumability: mirror the ingest pipeline's own pattern

**Decision.** Indexing runs on its own `ctx.calJobs` queue (the same `Jobs` class ingest's
`ctx.jobs` and transcription's `ctx.slowJobs` already use, one more instance of it) so a slow
embeddings call never holds up anyone's upload, and so `ctx.slowJobs.pending` keeps meaning
exactly what existing tests already assert it means (transcription and alignment work) rather
than gaining Cal's jobs as an unannounced side effect of installing Cal. `cal_index_status`
(migration 012) tracks each edition's indexing the way `editions.status` tracks
ingest itself; `resumeCalIndexing`/`resumeShelfIndexing` (app.ts, on boot) re-queue anything left
`pending`/`processing` by a restart, exactly as `resumeIngest` already does for ingest. An edition
is re-queued for indexing after: its own ingest finishes (after `realignAfterIngest`, so chunks
carry the edition's *final* sync map, not one about to be replaced); a manual chapter alignment
(`realign`); its audiobook transcript arrives or is removed. Old chunks of an edition are deleted
before it is re-indexed (`deleteChunksForEdition`), so a corrected upload or alignment never leaves
a stale chunk searchable.

**Rejected.** *Re-indexing on every nested forced-alignment refinement path*: a forced alignment
that only nudges an audiobook's sync map by tens of seconds (services/gating.ts's own documented
margins) changes which chunk a given word falls in by far less than the spoiler gate's own
tolerance; chasing every such path for an exact re-index was not worth the complexity against the
four triggers above, which cover ingest, manual realignment and transcript changes — the cases
that actually move a chunk's place by anything that matters. Documented here as a deliberate scope
cut, not a gap nobody noticed.

**Off the server's thread (amended at merge, 2026-10-28).** Indexing an audiobook read its whole
transcript (megabytes of JSON, hundreds of thousands of words) on the server's thread, through a
second, synchronous connection to the database whose busy wait, while the read-along kept the same
transcript, held every request: the responsiveness test (`readalong-limits.test.ts`, 400,000 words)
measured the longest stall at about 300 ms against master's 99. The transcript is now read, parsed
and made into atoms in the align worker (`transcript-atoms`, `TRANSCRIPT_ATOMS_LIMITS`), as every
other transcript read already was, and chunks go into the database a hundred per transaction with
the event loop let run between them (`insertChunksYielding`); the stall is master's again (95-99 ms).

## D165. Chunking: format-agnostic atoms, ~420-token windows, ~90-token overlap

**Decision.** One chunker (`packages/shared/src/cal/chunker.ts`, pure, unit-tested) works on
"atoms" — the smallest unit a caller can place on its source's own linear measure — so the same
code chunks an EPUB's paragraphs (from the normalised sections' own `bodyTextWithBreaks`, D27's
normalisation reused as-is), a PDF's printed lines (D75's own printed-text extraction), and an
audiobook's read-along or raw-transcript sentences (grouped by sentence-ending punctuation or a 3 s
silence). Windows close around 420 tokens (a 4-chars-per-token estimate), never exceed 500 (an
oversized atom is split at word boundaries, its sub-pieces' positions interpolated linearly across
the atom's own span), and the next window opens with the closed one's trailing ~90 tokens, so a
passage near a boundary is never orphaned from its context either side. A chunk's `t_start`/`t_end`
come from mapping its atoms' native positions through the edition's own sync map (`mToT`) — the
same map the spoiler gate reads positions through.

**Rejected.** *Sentence-level chunking*: too fine for a hybrid search result to carry enough
context on its own; paragraph/sentence-sized windows with overlap read better both to BM25 and to
an LLM deciding what to cite. *A fixed character-count window ignoring paragraph boundaries*: would
cut mid-sentence at arbitrary points, visibly worse to read in a citation's quote.

## D166. Conversations: private by default, final text only persisted (no tool scaffolding)

**Decision.** A conversation with Cal (`cal_conversations`/`cal_messages`) is private to its owner
by default; a later "share to club chat" is scoped out for now (tracked, docs/TRACEABILITY.md) —
posting a message is a different feature than changing this row's visibility, and the gap is
explicit rather than half-built. Only the final, user-facing text and citations of each turn are
stored — never the intermediate `tool_use`/`tool_result` scaffolding a turn generates internally
(anthropic.ts's tool loop runs fresh from history on every new message). Replaying history to
Claude on a later turn is therefore always plain alternating user/assistant text, which is valid
under the API's rules with no dangling tool-use block to repair.

**Rejected.** *Persisting the full raw tool loop per turn*: more storage and complexity for no
product benefit (nobody reads Cal's intermediate search calls back later), and it would need the
same rebuild-and-trim-and-pass-the-same-tool-ids care a long-running agent session needs, for a
chat feature that does not need it.

## D167. Voice: STT -> Claude -> TTS (architecture (b)), ElevenLabs and OpenAI measured

**Decision.** Voice follows architecture (b) from the brief, not (a): speech-to-text, the same text
chat brain (`runChatTurn`), then streaming text-to-speech, over one WebSocket per conversation
(`/ws/cal/voice`) — push-to-talk (`start`/`end` control messages) or hands-free (the client decides
when to send `end`, e.g. by its own silence detection), with `speakingStart`/`speakingEnd` messages
the client uses to duck or pause an audiobook, and a `bargeIn` message that aborts whatever is
still being generated or sent when the listener talks over Cal. Providers are pluggable
(`CAL_STT_PROVIDER`/`CAL_TTS_PROVIDER`, `apps/server/src/cal/voice/`): ElevenLabs (Scribe STT,
Flash v2.5 streaming TTS) and OpenAI (whisper-1, tts-1) were measured with real keys
(`scripts/cal-voice-bench.ts`, run on a development host, keys piped through the environment, never
argv); numbers recorded below once run. The default is chosen from those numbers.

**Context.** OpenAI Realtime, Gemini Live and Grok voice are speech-to-speech realtime models —
architecture (a). They were not benchmarked for latency: D160 already rejected architecture (a) on
a product-fit basis (one consistent persona/tools/spoiler-gate, not two), so their latency numbers
would not change the architecture choice, only which provider runs a design already set aside.
Benchmarking effort went to the providers that actually fit the chosen architecture.

**Rejected.** *A speech-to-speech realtime model*: see D160. *Picking a default without measuring*:
the brief asked for real numbers against real APIs, not a guess from reputation; `cal-voice-bench.ts`
exists specifically so this call is made from evidence.

## D168. Spend caps and rate limits: logged cost, a monthly cap per club, a per-minute cap per user

**Decision.** Every embedding batch, chat turn, and voice STT/TTS call logs its cost
(`cal_cost_log`, D161's embeddings and D167's voice providers each carry a published $/unit price,
checked 2026-10-28) against the club and user it was for. `CAL_MONTHLY_SPEND_CAP_USD` (default $20)
blocks a new chat or voice turn once a club's calendar-month total reaches it, with a plain message
telling the owner which env var to raise. `CAL_RATE_LIMIT_PER_MINUTE` (default 20, the existing
`RateLimiter` sliding-window class) caps how many turns one member may start per minute, text and
voice each with their own limiter instance.

**Rejected.** *A hard dollar-denominated enforcement at the provider level*: none of the providers
used here expose a per-key spend cap through their API; logging and gating in-app is the only lever
available, and is enough for the "small and cheap to run" club this app serves. *One shared limiter
for text and voice*: voice turns are heavier (audio bytes, STT+TTS calls); kept separate so a loud
voice session cannot also lock a member out of text chat.

## D169. Voice ducking: full pause, no auto-resume

**Decision.** When Cal starts speaking (the voice WS's `speakingStart`), the web app pauses
whatever audiobook is playing (`useAudio().pause()`) rather than lowering its volume; it does not
auto-resume when Cal stops. "Optional autopause on interruption" (the brief's own phrase for the
reading-together feature) already established pausing, not ducking, as this product's answer to
"something else needs the audio channel"; resuming automatically after a voice turn could restart
playback at a moment the listener did not choose, which is worse than making them tap play again.

**Rejected.** *Lowering volume instead of pausing*: still audible under Cal's voice, muddying both;
full pause is simpler and matches the existing interruption behaviour. *Auto-resume*: a surprising
autoplay the member did not ask for, especially were they to put the phone down mid-conversation.

---

### Measured numbers (run on a development host, 2026-10-28)

- **D161 (`scripts/cal-bench.ts`, brute-force cosine search time, 1536-dim, k=8, median of 3)**:

  | Chunks | Build (flatten) | Search |
  |---|---|---|
  | 500 | 0.6 ms | 6.5 ms |
  | 1,500 (`INLINE_THRESHOLD`) | 5.8 ms | 4.2 ms |
  | 5,000 | 23.0 ms | 19.8 ms |
  | 20,000 | 85.9 ms | 39.6 ms |
  | 50,000 | 216.5 ms | 95.0 ms |

  Even at 50,000 chunks (far past any club this app is built for, D161's own context above), a
  search is ~95 ms — well inside a tool call's budget. `INLINE_THRESHOLD` (1,500) is conservative
  by a wide margin; sqlite-vec would only earn its keep at a scale this app is not expected to
  reach.

- **D167 (`scripts/cal-voice-bench.ts`, real ElevenLabs and OpenAI keys, one TTS->STT round trip
  of a ~180-character reply)**:

  | Provider | TTS time-to-first-byte | TTS total | STT total | Round trip | Transcript fidelity |
  |---|---|---|---|---|---|
  | ElevenLabs (Scribe + Flash v2.5, voice "George") | 202 ms | 505 ms | 622 ms | 825 ms | 93% |
  | OpenAI (whisper-1 + tts-1) | 1,307 ms | 1,598 ms | 1,720 ms | 3,027 ms | 93% |

  ElevenLabs is roughly 3.7x faster to first audio and 3.7x faster round-trip, at equal
  transcription fidelity; **ElevenLabs is the default** (`CAL_STT_PROVIDER`/`CAL_TTS_PROVIDER`,
  already so in config.ts) on this evidence. The default voice (`ELEVENLABS_VOICE_ID`) is
  "George" (`JBFqnCBsd6RMkjVDRZzb`, "warm, captivating storyteller" in ElevenLabs' own library) —
  a deliberate match for Cal's librarian persona (D160), not an arbitrary default; the first
  voice tried, "Rachel", no longer exists as a named preset on current ElevenLabs accounts
  (`voice_not_found`), which is itself a small data point for keeping the voice id configurable
  per-deployment rather than hard-coding a name.

## D140. Media notes: one voice recording, 1-4 photos, or a short video, mutually exclusive

**Decision.** A note or reply (D48) may carry media besides its text: one voice recording, one
short video, or 1 to 4 photos (never a mix of kinds in one note). Media is uploaded ahead of the
note that will carry it, `POST /api/books/:bookId/media?kind=voice|photo|video`, a bounded
multipart request (`@fastify/multipart`, one file, a cap per kind: LIMITS.voiceNoteBytes,
photoNoteBytes, videoNoteBytes); the response's `id` is then named in `mediaIds` when the note or
reply is posted, which claims it (`attachMedia`, repos/comment-media.ts) inside the same
transaction that creates the comment. A comment with media and no text or reaction is allowed
(`CreateCommentBodySchema`'s refine widened); the database's own `CHECK (text IS NOT NULL OR
reaction IS NOT NULL)` is satisfied by storing an empty string rather than `NULL` for a media-only
note (D148), never by relaxing that constraint.

**Context.** Cole: "can leave voice notes, text notes, or image notes or video notes for the
people behind you." Each row of `comment_media` is one file (`idx` orders photos); `comment_id`
starts `NULL` and is claimed on posting, so an abandoned upload (composer closed, tab closed) is
swept up an hour later rather than orphaned for good (services/note-media-cleanup.ts).

**Rejected.** *tus for note media too*: tus (routes/imports.ts) is resumability for the
multi-hundred-megabyte audiobook uploads it was built for; a voice note or a photo is tens of
megabytes at most, far under what one request carries comfortably, and tus's upload-session
bookkeeping would be pure overhead here. *Uploading media inline with the note (one multipart
request carrying both)*: the composer needs to know a recording or a picture actually came through
*before* the note is posted (a failed transcode must not silently post a broken attachment), and
the two-step shape also makes "attach later" and re-recording cheap. *Letting a note mix kinds
(a voice note and two photos together)*: no one asked for it, and it complicates the viewer (which
player goes first?) for no real gain. *A JSON body with base64 bytes*: a third larger on the wire
for no reason, and Fastify's JSON body parser buffers the whole thing before this ever sees it.

**Consequences.** `packages/shared/src/api/schemas.ts` gained `NoteMediaKindSchema`,
`NoteMediaViewSchema` (the open view), `HiddenNoteMediaSchema` (kind only) and
`UploadedNoteMediaSchema`; `CreateCommentBodySchema` and `CreateReplyBodySchema` gained `mediaIds`
and no longer require text. Migration 013 adds `comment_media`. apps/web's composer
(NoteMediaComposer.tsx) locks to the first kind attached until every attachment is removed.

## D141. Voice and video made web-safe with ffmpeg; images with sharp; graceful without it

**Decision.** A photo is read and re-encoded with sharp (already in the server for covers,
ingest/covers.ts): resized to at most 1600×1600, re-encoded as JPEG, which drops EXIF entirely
(including the GPS tag a phone's camera roll carries) since nothing calls `.withMetadata()`. Voice
is transcoded to AAC/m4a and video to H.264/AAC mp4 plus a JPEG poster frame, with `ffmpeg` and
`ffprobe` (added to the `runtime` Docker image, D140's Dockerfile diff), because a recording made
on an iPhone is AAC/MP4 and one made in Chrome is WebM/Opus, and neither phone plays the other's
directly; dimensions and duration are read by `ffprobe`, never trusted from the upload. Detected
once per process (`spawnSync('ffmpeg', ['-version'])`, cached) rather than a config flag: there is
nothing to configure, only a binary to have or not. Without it, a voice note still works (served as
its own bytes, which the browser that recorded it always plays; cross-browser playback degrades)
but a video is refused outright with a clear reason, since there is no safe way to read an unknown
container's dimensions or cut a frame from it without a decoder.

**Context.** The brief: "process untrusted media in worker threads/subprocesses with time and
memory limits like the existing ingest"; "make a web-safe rendition... if the deploy image has it
(check the Dockerfile; add it if not, justified)". ffmpeg runs detached in its own process group,
exactly as the speech recogniser does (services/readalong.ts's `run`/`signalAll`/`stop`), killed on
a timeout sized to the file (60s + 4s/MB: generous for a clip at most five minutes long) rather than
left unbounded, with only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR` of the server's environment
(services/note-media.ts's `toolEnv`), none of its secrets.

**Rejected.** *A worker thread instead of a subprocess*: ffmpeg is already a separate, battle-tested
process with its own memory space; wrapping it in a worker thread would only add a second layer
with no benefit (the existing worker-thread limits, services/aligner.ts, are for *this server's
own* parsers, which have no process boundary of their own). *Requiring ffmpeg (refusing every
upload without it)*: this is a personal project that may run without it for a while; voice and
photo notes should not go dark for want of one package line. *fluent-ffmpeg or a similar wrapper
library*: a thin layer over `child_process.spawn` with its own API to learn, for two commands.
*Decoding video frames with sharp or @napi-rs/canvas instead of ffmpeg*: neither decodes video;
ffmpeg both decodes and its poster frame is one more flag on the same call that already transcodes.

**Consequences.** `apps/server/src/services/note-media.ts` holds all of this; `MAX_BYTES`,
`ffmpegAvailable` (and `setFfmpegAvailableForTests` for the test suite to force either answer).
The Dockerfile's `runtime` stage installs `ffmpeg`; the demo image inherits it. A deploy without
ffmpeg (an older box, until it is rebuilt) keeps voice and photo notes working; video notes fail
with "Video notes need ffmpeg on the server, which this deploy does not have," not a silent drop.

## D142. Media is processed inline in the upload request, not a background job

**Decision.** `POST /api/books/:bookId/media` validates, transcodes and stores a photo, voice
recording or video *before answering*: by the time the response comes back, `status` is `ready` or
`failed`, with a reason when it failed. Only the voice note's transcript (D143) runs in the
background.

**Context.** Clips are short by design (at most five minutes of voice, two of video, LIMITS):
ffmpeg's `veryfast` preset transcodes a clip like this in well under the length of the clip itself
on ordinary hardware, so the request simply takes a few seconds, not minutes. The composer can show
a real status at once (D140's `uploading` → `ready`/`failed`) rather than polling a job.

**Rejected.** *A job queue (ctx.jobs/ctx.slowJobs) for every upload, polled by the client*: right
for the audiobook ingest pipeline (minutes to hours of work on a file nobody is staring at) but
needless ceremony for a clip the person recording it is actively waiting on; polling would only
reconstruct, badly, what a synchronous answer already gives for free. *Processing after the note is
posted*: the note would exist with a status nobody could see yet, and a failed transcode would need
a second round trip to fix or delete it.

**Consequences.** A slow upload (a weak connection, a large photo) is simply a slow request; the
server's `requestTimeout` (ten minutes, app.ts) comfortably covers it. A future, much longer media
cap (not asked for here) would need to revisit this.

## D143. A voice note's transcript reuses the audiobook recogniser (D79), queued once there is a comment

**Decision.** When `TRANSCRIBE_COMMAND` is set (D79) and a voice note transcoded cleanly, its
upload is marked `transcriptStatus: 'queued'`; once the note or reply is actually posted and the
media claimed (`claimMedia`, routes/reading.ts), the server runs the same recogniser
(`tools/align/transcribe.py`'s `--out FILE track.m4a` contract) on the note's *original* blob in
the background (`ctx.slowJobs`), joins the recognised words into plain text
(`transcribeVoiceNote`, services/note-media.ts), and republishes the comment over the socket
(`comment:new`, the same event a delete's placeholder already reuses) so the transcript appears
live, under the player, without a page reload.

**Context.** The brief: "Voice notes get a transcript when the server's recogniser exists
(TRANSCRIBE_COMMAND, D79) so they are searchable and accessible; show it under the player." Queuing
only after the comment exists (not at upload time) means there is always a `comment_id` to
republish; using the *original*, not the transcoded, blob means the recogniser reads exactly what
was recorded, nothing ffmpeg's resampling may have changed.

**Rejected.** *A second recogniser command or model tuned for short clips*: one configuration knob
is enough; a five-minute note is well inside what the audiobook recogniser already reads in
windows (services/readalong.ts). *Transcribing before the note is posted (at upload time)*:
whisper's real-time factor is not guaranteed fast enough to hold the composer open for it, and
there would be nothing yet to republish it onto. *Searching transcripts (full-text search across
notes)*: not asked for in this round; the transcript is for reading and accessibility, kept as
plain text in `comment_media.transcript` so it is easy to add later.

**Consequences.** `tools/align/transcribe.py`'s existing one-file-is-one-track behaviour is reused
unchanged. A deploy without `TRANSCRIBE_COMMAND` simply never queues a transcript;
`transcriptStatus` stays `'none'`.

## D144. Media is gated exactly as a comment's words are, on its own private, uncached routes

**Decision.** `GET /media/notes/:mediaId/file` and `/poster` (routes/media.ts) check the same gate
(`Gate.isOpen`, services/gating.ts) that decides whether a comment's *text* reaches a member, on
*every* request, Range requests included (sendFile's byte-range support runs after the gate check,
never instead of it), and answer `private, no-store` always — not the `private, max-age=31536000,
immutable` every other gated file in this app gets, because that cache header is the explicit ask
("send private no-store cache headers so the service worker never caches a gated file"), and
because unlike a book's own files (whose gating, membership, never changes once you are in a
club), a *note's* gate opens and closes with your own reading, which changes by the minute.
Unattached media (not yet posted) is reachable only by whoever uploaded it, for the composer's own
preview. `CommentView`'s `media` field carries the *same* two-tier shape its text already has: the
full `NoteMediaView` (address, duration, dimensions, transcript) once open, or just `{ kind }` while
hidden — never a duration, a dimension or a thumbnail, any of which could leak pacing or content
the way D80 already worried a rough place could.

**Context.** The brief's one rule, restated for media: "no text, no transcript, no media bytes, no
thumbnails, no durations that leak." `services/gating.ts`'s `Gate` class already carries the whole
weight of deciding what is open; `toCommentView`/`gate.view` simply gained a `media` parameter
(repos/comment-media.ts's `mediaForComment(s)`, batched for the comments list and for progress's
`revealed`) rather than any new gating logic of their own.

**Rejected.** *A signed, time-limited URL for each media file (like a cloud bucket's)*: a fresh
signature for every comment list refresh, for no benefit over checking the gate live, which this
app already does for every other gated file. *Caching the gate's answer for a short while*: a
member's reading changes the moment they report new progress (PUT .../progress), and the point of
`no-store` is that the very next request reflects it, not a TTL's worth of staleness. *Baking the
media URL into the hidden marker too, disabled client-side*: the browser would fetch it anyway (an
`<img>` preloader, a service worker), and the server must refuse it regardless, so there is nothing
to gain and a dead link to maintain.

**Consequences.** Opening a club's "save offline" copy of a book (lib/offline.ts) does *not* cache
any note's media (it was never on the list of URLs that function downloads): a media note is
simply unavailable offline, by the same rule that keeps it uncached everywhere else; its text and
markers still work offline as before. `apps/server/src/repos/blobs.ts`'s orphan sweep
(`orphanBlobs`, `deleteUnusedBlobRow`) was extended to also check `comment_media`, so the existing
hourly blob sweep cannot delete a media note's bytes out from under a live comment.

## D145. "Reached" notifications batch per friend, per book, per chapter, while unread

**Decision.** `notifyReached` (services/notifications.ts) no longer makes one notification row per
note opened: while an unread `kind = 'reached'` row already exists for (friend, actor, book,
chapter), reaching another of that friend's notes in the same chapter bumps it in place
(`comment_id` moves to the newest one, `count` increments, `created_at` refreshes) instead of
adding a second; reading it frees the key (the unique index is partial, `WHERE read_at IS NULL`),
so a note reached later, after the bell was opened, is its own fresh notification. Pushes
(`notification:new` over the socket, and the toast it drives) are likewise sent once per
notification *touched*, not once per note, even within one batch.

**Context.** The brief: "fill gaps, keep it quiet (batch 'reached' notifications per friend per
chapter, no notification storms)." D49 already said "once per friend and note," which the old
`INSERT OR IGNORE` on `(user_id, comment_id, actor_id)` delivered, but says nothing about *several*
notes reached in one sweep (a whole chapter caught up after a day offline, or several notes read at
once by paging past them): that was, and without this change still would be, one notification row
and one socket push per note. Migration 013 adds `chapter_index` and `count` and replaces the old
unique index with one scoped to the chapter and to being unread.

**Rejected.** *Debouncing on the client (coalescing toasts in the UI)*: the bell's own list (not
just the live toast) would still fill with one row per note; the point is one row, durably, not
just a quieter moment on screen. *A time window (one notification per friend per book per hour)*:
chapter is the unit the rest of the product already uses for "where" (the club bar, the horizon
label); a time window would group unrelated moments (chapter 2 this morning, chapter 9 tonight)
under one roof for no reason. *Keeping D49's per-note rows and only changing how the bell displays
them (grouping client-side)*: every open device would still get a push per note, which is the storm
the brief is naming.

**Consequences.** `NotificationView` gained `count` (always 1 for a reply) and `mediaKind` (a
reply's attachment kind, shown unconditionally like the reaction emoji already is — modality, never
content). The client (`lib/queries.ts`'s `addNotification`) replaces a bumped notification in
place rather than ignoring the "duplicate" id it used to assume could not be an update.

## D146. Media notes are refused outright while offline; text notes still work offline

**Decision.** `NoteMediaComposer` disables every attach control the moment the browser reports
`offline` (and refuses to start one already in flight from going further), with "No connection:
voice, photo and video notes need one. Text still works offline." Text notes and reactions keep
working exactly as before (`lib/pending-notes.ts`, `lib/outbox.ts`): nothing about this touches
them.

**Context.** The brief offered the choice explicitly: "Offline outbox... must handle media notes
too, or explicitly refuse offline media with a clear message." A voice recording or a photo is
real bytes that must reach the server to be worth anything (there is no "pretend it posted" for a
30 MB file); queuing them offline would mean keeping multi-megabyte blobs in IndexedDB, replaying a
multipart upload later, and reconciling a note that already posted with text against media that
arrives minutes or hours afterwards — a second, parallel offline system next to the one that
already exists for text and progress.

**Rejected.** *An IndexedDB blob queue, uploaded on reconnect (mirroring lib/outbox.ts)*: real, and
worth doing later if a club's own offline reading habits call for it, but it is a project of its
own (storage quota, partial-upload resume, the same race the `clientId` idempotency key solves for
text but now for bytes too) that this round's time is better spent elsewhere, per the brief's own
permission to choose refusal. *Letting the recording happen offline and only refusing to post it*:
worse than refusing up front, since the five minutes just spent recording would be thrown away
at the end instead of before starting.

**Consequences.** A club member mid-flight (a plane, a tunnel) can still leave a text note or react;
a voice note, photo or video waits for a connection, with no silent data loss (nothing is recorded
that then cannot be saved) and no half-built queue to maintain.

## D147. Deleting a note deletes its media now, not on the next hourly sweep

**Decision.** `DELETE /api/comments/:commentId` (routes/reading.ts) removes the deleted comment's
media rows and the blobs nothing else still refers to in the same request (`deleteMediaOf`), the
way deleting a book or an edition already removes their blobs immediately (`removeFiles`,
routes/books.ts) rather than waiting for `removeOrphanBlobs`'s hourly pass. Club and book deletion
cascade at the database level (`comment_media.book_id` and `.comment_id` both
`REFERENCES ... ON DELETE CASCADE`), so the rows vanish with the book; the hourly orphan-blob sweep
(now comment_media-aware, D144) picks up their bytes afterwards, the same path a book's own files
already take when a book is deleted.

**Context.** The brief: "Deleting a note deletes its media; club/book deletion cascades." A note
kept as a placeholder for its replies (D48, softDeleteComment) still loses its media at once: a
placeholder shows no words, so it must show no bytes either.

**Rejected.** *Leaving media cleanup entirely to the hourly orphan sweep*: correct eventually, but
"deleted" should mean gone, not "gone within the hour," especially for a video that might be tens
of megabytes sitting needlessly on a small box's disk. *A foreign key with `ON DELETE CASCADE`
from `comments` straight through to deleting the blob files*: SQLite's cascade only deletes rows,
never files on disk; the blob files still need an explicit step, which `deleteMediaOf` is.

**Consequences.** Deleting a note or reply with media frees its disk space immediately, matching
the latency members already see for every other kind of file deletion in this app.

## D148. A media-only note satisfies the database's text-or-reaction rule with an empty string

**Decision.** `comments` has carried `CHECK (text IS NOT NULL OR reaction IS NOT NULL)` since
migration 001. A note or reply with media and neither text nor a reaction now stores `text = ''`
(empty, not `NULL`) rather than relaxing or rebuilding that constraint; every place that reads
`comment.text` already treats an empty string as "no text" (`hasText` in `toCommentView`, and the
UI's own `{c.text ? ... : null}` checks), so nothing downstream needed to change.

**Context.** Rebuilding `comments` to drop or loosen the `CHECK` would mean the classic SQLite
table-rebuild dance (create a new table, copy every row, drop the old one, rename, rebuild its two
indexes) while three other tables hold live foreign keys into it (`comment_media.comment_id`,
`notifications.comment_id`, `comments.parent_id` itself) and the server's connection runs with
`PRAGMA foreign_keys = ON` throughout, which `node:sqlite` cannot toggle mid-transaction (and every
migration runs inside one, db.ts's `migrate`). The empty-string trick sidesteps all of that for a
single, narrow, already-anticipated case (`CHECK` only ever asked "is there *something* here,"
never "is it non-empty").

**Rejected.** *The table rebuild, done carefully (foreign_keys off outside any transaction, as
SQLite's own docs prescribe)*: safe in principle, but a correctness-critical, hard-to-rehearse
migration for a problem a one-line convention already solves; not the ten-line fix the brief's
spirit asks for when a simpler one exists. *Making `reaction` or `text` nullable differently, or
adding a `has_media` column the `CHECK` could reference*: SQLite `CHECK` constraints cannot look at
another table (`comment_media` is populated *after* the comment row, in a separate statement,
specifically so retrying a post is idempotent), so no single-table `CHECK` can express "this note
has media" without first trusting a column this migration would still have to add and keep in sync
by hand.

**Consequences.** `insertComment`'s callers (routes/reading.ts) compute `text` as the real text,
or `''` when there is media and nothing else, or `null` otherwise (a reaction alone); every reader
of `comment.text` was already written to treat `''` as absent.

## D149. Voice is recorded live in the browser; photo and video come from the device's own picker

**Decision.** A voice note uses `MediaRecorder` directly (`components/VoiceRecorder.tsx`): a level
meter (a `Web Audio` `AnalyserNode` sampling the live stream), pause and resume, re-record, a
preview before attaching, and a hard stop at the cap (LIMITS.voiceNoteSeconds). A photo or video
instead comes from `<input type="file" accept="image/*|video/*" multiple capture>`: the browser's
own picker already offers "take a photo/video now" or "choose from the library" on a phone, with
no camera preview UI of this app's own to build, test across iOS Safari and Chrome, or maintain.
Either way, while recording live or playing a note's media back, the audiobook (if it was playing)
pauses, through `AudioProvider`'s own controller (`player/pauseWhile.ts`'s `usePauseAudiobookWhile`
hook), never a second `<audio>` element competing for the one real player's state, and resumes
after, exactly where it was, but only what it itself paused (never resuming a friend's own pause).

**Context.** The brief: "voice via MediaRecorder..., with level meter, pause/resume, re-record,
preview, max length"; "photos from library or camera (input accept/capture)"; "video from camera or
library." It did not ask for a live in-browser *video* recorder, and the file-input route for
photo and video is both less code and a better result: the OS's own camera app, with its own
flash, zoom and framing controls, rather than a reimplementation inside a `<video>` preview.

**Rejected.** *MediaRecorder for video too, with a live `getUserMedia` preview*: strictly more
capable (one continuous flow, no OS camera app hand-off) but far more surface to build (a live
preview element, front/back camera selection, orientation handling) for a feature the brief itself
described as coming "from camera or library," which the native picker already is.
*`navigator.mediaDevices.getDisplayMedia` or a custom camera overlay for photos*: the native photo
picker already does this, with the device's own permission model and UI the person already knows.
*Checking a video's length with an `ffprobe`-equivalent in the browser (a WASM demuxer)*: loading
it into an actual `<video>` element and reading `.duration` is simpler, needs no extra dependency,
and is exactly as reliable for the one thing this needs (a length check before upload; the server's
own `ffprobe` call is the real, trusted measurement).

**Consequences.** `lib/media-capture.ts` holds the pure checks (`checkPhotoFile`,
`checkVideoFile`, `readMediaDurationMs`, `pickVoiceMimeType`); `VoiceRecorder.tsx` is the only
component that touches `getUserMedia`/`MediaRecorder` directly. A browser without `MediaRecorder`
(none of this app's supported ones, but checked anyway) disables the voice button with no crash;
Chromium E2E uses `--use-fake-device-for-media-stream`, WebKit (which Playwright cannot fake a
microphone for) exercises the same flow with a stubbed recorder (e2e's own test-only hook).

## D150. Live chat is persisted per club, with an optional book tag and spoiler fence that reuses the book's gate

**Decision.** A club has one chat stream (`chat_messages`, migration 015), each message optionally
tagged to one of the club's books. Delivery to other members is the existing hub (`chat:new` etc.),
exactly as a comment's creation already pushes over it; typing is the only part that goes the other
way, client to server, over the socket (ephemeral, never stored). A message tagged to a book may
carry a spoiler fence, "spoiler up to `<t>`": the server judges whether a viewer may read it with
the very same `Gate` a note's spoiler gating already uses (`services/gating.ts`), given a
synthetic `Gated` whose `t` is the fence and whose locator is absent, so `Gate.access` falls back
to the timeline position directly. A hidden message carries only the chapter it waits for, never
its words, the same rule D12 holds for notes.

**Context.** The gate's margins, chapter anchors and reference-edition handling are already
exhaustively tested (comments.test.ts, gating.ts's own long comment). A chat message's fence is
exactly a note's placement problem with no native locator to anchor it precisely, which the gate
already handles (a comment's own locator is optional there too: `measureOf` falls back to `tToM`
when it is absent or of the wrong kind).

**Rejected.** *A new, simpler gating rule just for chat* (e.g. "hidden until your furthest read
passes `t`, no margins"): two different answers to "have you read far enough" for two kinds of
spoiler in the same club would surprise someone comparing a note and a chat message at the same
place. *Splitting chat into one stream per book*: a club's conversation is one thing; a member
would have to check N badges for one conversation, and most messages belong to no particular book
at all.

## D151. Typing is ephemeral over the hub; the unread count is a read cursor, not a per-message flag

**Decision.** `chat:typing` is a `ClientMessage`/`ServerMessage` pair, never written to disk,
rebroadcast to a club's other subscribers with a 5 s expiry the client itself prunes. Unread counts
come from one cursor per member per club (`chat_reads`: last read message, last read time), not a
per-recipient "seen" row per message: a club's whole chat is one stream (D150), so one cursor
answers "how many are new" in one query, and marking it moves forward only (never un-reads a
message a newer mark already passed).

**Rejected.** *Storing typing state*: it is stale the instant the tab closes, and nothing needs it
after that. *A `read` row per message per member* (as `notifications` tracks `read_at`): O(members
× messages) rows for a count every screen needs on load, where notifications are already a small,
per-person list.

## D152. @-mentions notify through the existing `notifications` table, not a new one

**Decision.** `notifications.kind` grows a third value, `mention` (migration 015 rebuilds the
table: SQLite cannot alter a `CHECK` constraint or a column's nullability in place). A mention's
subject is a chat message in a club, not a comment in a book, so `book_id`/`comment_id` become
nullable and two columns, `club_id`/`chat_message_id`, are added. Mention targets are resolved from
a message's text against the club's member names (`services/chat.ts` `parseMentions`: a full
display name or first name only, punctuation and spaces dropped, case-insensitive); a mention
inside a spoiler-fenced message is judged by the same chat gate before its words reach the
notification (never the writer, whose own notification never fires).

**Rejected.** *A separate `chat_notifications` table*: the parallel iOS push work
already watches `notifications`/`notifyReply`/`notifyReached`'s push path (`ctx.hub.sendToUser`);
a second table doubles the surface it has to watch for the same kind of event. *Matching mentions
by `@userId`*: friends do not know each other's ids, and typing one is not how anyone writes a
mention.

## D153. Voice channels: LiveKit, self-hosted next to the app; one room per club, tokens minted server-side

**Decision.** Cole's choice: a self-hosted LiveKit server container beside the app
(the coordinator deploys it in production; this workstream builds and documents the kit,
`deploy/compose.yaml`'s `livekit` service). One LiveKit room per club (`club:<clubId>`), one more
per ad hoc id for a side conversation (`club:<clubId>:adhoc:<id>`); a listening party (D155) reuses
the club's own room ("Voice is the club's LiveKit room for the party"). `POST /api/livekit/token`
mints a short-lived token (`livekit-server-sdk`) for exactly one room name the server built — never
one a client names — after checking the caller is actually a member of that club
(`requireMember`, the one rule D21 already states). LiveKit itself never learns who our members or
clubs are: only room names and participant identities (our user ids).

**Rejected.** *A managed/cloud LiveKit*: Cole's explicit choice was self-hosted. *One global voice
room*: no isolation between clubs, and no way to scope a token to "this club's members only".
*Letting the client name its own room*: a token for any room name it likes is a token for every
club's voice, since LiveKit does not know about clubs at all.

## D154. Voice presence is each client's own report over the hub; LiveKit's webhook is an optional backstop

**Decision.** Who has joined a voice room, muted, deafened, speaking: each client reports only
about itself (`voice:join`/`voice:leave`/`voice:self`, new `ClientMessage` cases the hub routes
directly, no new delegate class needed), rebroadcast as `voice:update` to the club's subscribers —
the same pub/sub presence already uses, per the project's rule to reuse existing primitives
before adding a new one. `routes/livekit-webhook.ts` (optional: 404 while `LIVEKIT_*` is unset)
verifies and reads LiveKit's own webhook, and only ever acts on `participant_left`, to drop a
participant our own socket has not noticed left yet (a network partition the RTC connection saw
before a 20 s heartbeat did). It is a backstop, not the source of truth.

**Rejected.** *Polling LiveKit's room/participant list*: a new poll loop and a new way for presence
to be wrong between polls, where the hub's existing push already reaches every subscriber within
one message. *Making the webhook required*: it would need a publicly reachable callback URL in
every deployment, including the demo stack, for a feature (crash cleanup) a 20 s heartbeat already
covers almost as well.

## D155. Listening together: one shared state per book, owned by the server, kept in memory like presence

**Decision.** `apps/server/src/realtime/party.ts` (`PartyManager`) keeps one `PartyState` per
`(clubId, bookId)` with no party running until someone starts one, entirely in memory: track,
position, playing, rate, the server's own clock (`updatedAt`), settings, and who is in it.
Migration 015 adds no table for it. A client's local player is always the one actually playing the
audiobook, authenticated as that listener's own access to it (never piped through LiveKit, which
carries only voice); it reconciles to the party's clock with `projectPosition` and
`driftCorrection` (packages/shared/src/live/party.ts, pure, unit-tested with no server or browser
at all): a drift past 0.75 s seeks, a smaller one nudges the playback rate instead of an audible
jump. Voice for a party is the club's own LiveKit room (D153): people talk while listening, and the
audiobook ducks to 25 % locally while the room's *other* participants are heard speaking
(`PartyBar`'s `onRemoteSpeaking`), since the audiobook itself is never a track LiveKit carries.

**Context (D156).** The threshold (0.75 s) and the nudge fraction are the spec's own numbers;
`DRIFT_IGNORE_S` (0.05 s) stops the rate from chattering on ordinary float jitter between ticks.

**Rejected.** *A `listening_parties` table*: nobody expects "resume the party" to survive a
restart, same as presence; a table and a migration for a never-persisted invariant is the kind of
new persistence layer the project's architecture rule asks to justify first, and there is no
invariant here to show for it. *Streaming the audiobook's audio through LiveKit as a published
track*: it is already authenticated, cached offline and byte-ranged per listener (D22, L5); turning
it into a room participant's microphone would mean re-licensing the same bytes as "voice" and
losing every one of those properties for no gain, since everyone's copy is already the same file.

## D156. Drift correction's two thresholds come from the brief; a third stops rate-nudge chatter

**Decision.** `DRIFT_SEEK_THRESHOLD_S = 0.75`, `DRIFT_NUDGE_FRACTION = 0.05` (a 5 % speed nudge),
`DRIFT_IGNORE_S = 0.05` (below this, do nothing: float jitter between 1 s sync ticks, not real
drift). Measured against the state machine's own unit tests (`party.test.ts`), not against a real
network: the real-world drift (buffering stalls, a paused tab's timers) is exactly what the 2 s
resync tick (`PartyManager`'s `tick`) and the client's own 1 s correction loop (`PartyBar`) are
for, each independently converging toward the server's clock.

**Rejected.** *A single wide "close enough" band with no rate nudge*: a visible pause-to-seek jump
for drift just over whatever that band is, where a thin rate nudge is inaudible and catches up
within a few seconds.

## D157. Joining ahead warns client-side; listening in a party saves your place exactly like listening alone

**Decision.** Before a member joins a party running ahead of their own progress, the client (not
the server) compares the party's current place (via the edition's own timeline, `tOf`) against
their saved progress and asks ("The party is at Chapter 9. You are at Chapter 6. Join and skip
ahead?") — a courtesy, not a spoiler gate: joining and listening is no different from reading ahead
on your own, which nothing in this app has ever stopped (D12 gates *other people's words*, not a
book's own content, which every member who added it can already reach). Once joined, the normal
progress pipeline (`AudioProvider`'s `report`/`announce`, unmodified) keeps saving and broadcasting
your place exactly as it does listening alone, because the party only ever drives the same local
player that pipeline already watches.

**Rejected.** *Server-side enforcement of the warning*: there is nothing to enforce — a member is
always allowed to listen anywhere in a book they have access to; blocking the join itself would be
a restriction D12's spoiler rule was never meant to impose. *A separate "party progress" path*:
strictly more code for identical behaviour, since the local player's state is the local player's
state whoever is driving its transport.

## D158. Auto-pause on interruption: a pure state machine fed by each speaker's own mic, with echo's limit documented

**Decision.** `packages/shared/src/live/autopause.ts`'s `AutoPauseEngine` is a pure state machine
driven only by explicit timestamps (`speaking(userId, name, isSpeaking, now)`, `tick(now)`): no
timer of its own, so it is unit-tested with fake speaker events and a fake clock with no server,
browser or real audio at all, then reused unchanged by `PartyManager`, which feeds it `Date.now()`
and LiveKit's own active-speaker events, relayed one per client over the hub (`party:speaking`) —
never computed from anyone else's track, since a participant's own LiveKit `ActiveSpeakersChanged`
state is the only signal this needs. Continuous speech past `autoPauseSensitivityMs` (default
700 ms) pauses the party for everyone with who is talking; quiet past `autoResumeAfterMs` (or a
tap) resumes it, rewound by `rewindOnResumeMs` so the words lost to the pause are heard again.

**Context.** This cannot distinguish a real voice from the audiobook leaking out of one device's
speaker into a second device's open microphone: echo cancellation (required on every published
track) only removes a device's *own* output from its *own* mic, not a different device's speakers
picked up by a third party's microphone sitting nearby. Earbuds remove the leak at the source and
are the documented workaround; there is no software fix for a cross-device acoustic path from
inside this feature alone.

**Rejected.** *Running the detector on the server from LiveKit's room-level active-speaker list
without per-client self-report*: indistinguishable at the room level from one listener's TV in the
background, where "my own mic crossed its own threshold" is at least that listener's own claim
about their own device. *A real-timer class (`setInterval` inside the engine)*: untestable without
a fake-timer library standing in for real time, where explicit timestamps let a unit test assert
exact millisecond boundaries (crossing 699 ms vs 700 ms) directly.

## D159. LiveKit deployment: a dedicated signalling subdomain, DNS-only through any CDN, one UDP mux port

**Decision.** Production reaches LiveKit's signalling connection at `rtc.books.example.org` (its own
subdomain, not a path under the app's own origin, D153), proxied by the host's existing nginx to
LiveKit's loopback HTTP/ws port, with its own certificate. Exactly two ports are published straight
off the LiveKit container, bypassing the loopback-only pattern every other service in this kit
uses, because real-time media cannot go through an HTTP reverse proxy at all: the TCP fallback
(7881) and one UDP mux port (7882) — a single port, not the wide ranges older WebRTC guides ask
for, which is LiveKit's own current recommendation short of a cluster serving far more concurrent
calls than a book club ever will. `deploy/livekit/livekit.yaml` is generated from `deploy/.env` by
`deploy/livekit/generate-config.sh` (`envsubst`) and gitignored, since it holds the API secret; the
service is behind a compose `profile` (`livekit`), opt-in like every `LIVEKIT_*` setting. The demo
stack (`compose.yaml`) instead runs LiveKit's own `--dev` mode unconditionally, with a fixed
non-secret demo key, so `docker compose up` alone still shows chat, voice and listening together.

**Context.** A subdomain, not a path, means Cloudflare (or any CDN) can be told once that this one
name is DNS-only (the grey cloud) without touching the app's own name, which stays proxied exactly
as it is today; the alternative (one shared name, two kinds of traffic) would force the whole site
DNS-only to let LiveKit's media through, losing Cloudflare's protection for everything else.
LiveKit's embedded TURN-over-TLS (443) is documented but not enabled: this host's nginx already
owns 443, and a book club's networks have not yet needed it (the TCP fallback already crosses most
NATs a plain UDP path cannot); turning it on is one config block away if that changes.

**Rejected.** *A path under the app's own origin (`/livekit/`)*: ties LiveKit's TLS and CDN
posture to the app's, when they need opposite answers (proxied vs DNS-only) for the same zone.
*Opening the full ICE port range (thousands of UDP ports) "to be safe"*: a much larger firewall
surface for a traffic pattern (one mux port) LiveKit itself recommends over the old range-based
approach, with nothing gained for a handful of friends' calls.

## D130. The iOS app: a native shell, Expo SDK 58, `expo-audio` for playback

**Decision.** `apps/mobile`: an Expo SDK 58 app (React Native 0.88, the versions npm currently
serves as latest stable for that SDK, checked directly against the registry rather than assumed)
built with `expo prebuild` + `xcodebuild` — no EAS, no Expo account, because none exists. Almost
the whole app is `apps/web` inside a `react-native-webview`; this project owns only background
audio with lock-screen controls, the WebView's own correctness (cookies, App-Bound Domains,
external links, camera/mic), and push. Playback is `expo-audio`, not `react-native-track-player`,
chosen with evidence rather than the obvious third-party default: reading expo-audio's own iOS
source for this exact SDK version (`packages/expo-audio/ios/MediaController.swift` on the `sdk-58`
branch, github.com/expo/expo) shows it already drives `MPNowPlayingInfoCenter` and
`MPRemoteCommandCenter` directly — play, pause, toggle, scrub and skip commands act on the native
player without any JS round trip — and its `AudioMode` (`setAudioModeAsync`) exposes
`allowsRecording` and `interruptionMode: 'mixWithOthers'`, which is what D132 needs.

**Context.** Cole's decision (see `docs/DECISIONS.md`'s header and the shared brief) fixed "native
shell, shared reader, Expo app" already; what was left was *how* to get native audio and lock-screen
controls out of it, and the brief named react-native-track-player as the fallback if expo-audio
could not do it.

**Rejected.** *react-native-track-player*: a larger, separately-maintained native dependency for a
capability expo-audio turns out to already have, confirmed by reading the source rather than
trusting its README's feature list, which does not mention this level of detail either way.
*expo-av* (expo-audio's predecessor): deprecated in favour of expo-audio as of the SDK this app
targets. *EAS Build*: no Expo account exists and the brief rules it out explicitly; `expo prebuild`
generates a normal Xcode project that `xcodebuild` builds and archives on its own. *(Partly superseded by D180: an Expo account and the EAS project
now exist, for EAS Update only; builds are still `expo prebuild` +
`xcodebuild`.)*

**Consequences.** `apps/mobile/src/audio/NativeAudioEngine.ts` is the only place that talks to
`expo-audio` directly; nothing in `apps/web` knows which native audio library is behind the
bridge, so a future swap (if expo-audio's lock-screen behaviour does not hold up under real use,
`apps/mobile/README.md` says where to check) costs one file.

## D131. The audio bridge: a drop-in `HTMLAudioElement`, not a second code path in `AudioProvider`

**Decision.** `apps/web/src/player/native-bridge.ts` exports `createNativeAudioElement()`, an
object shaped exactly like the subset of `HTMLAudioElement` `AudioProvider.tsx` uses (`src`,
`currentTime`, `duration`, `paused`, `ended`, `playbackRate`, `readyState`, `play()`, `pause()`,
`load()`, `removeAttribute()`, `addEventListener`/`removeEventListener`, and the DOM events it
listens for), backed by `postMessage` to `apps/mobile`. `AudioProvider` assigns it to `audioRef.current`
(during render, the documented React pattern for lazy ref init, guarded so it only happens once)
when `window.BookClubNative` exists, and renders no `<audio>` element in that case, so nothing else
in the file changes. The same file stands a `NativeMediaSession` in for `navigator.mediaSession`
(absent in WKWebView), so `AudioProvider`'s existing lock-screen effects — which already do nothing
if `'mediaSession' in navigator` is false — run for the first time there instead, and simply end up
telling native what to show (D130: native owns the real lock screen; nothing comes back through
`setActionHandler`, since a hardware button there acts on the native player directly).

**Context.** The brief required swapping only "the element," keeping every line of places, looks,
D70 catch-up, the sleep timer and read-along exactly as written, since that logic is already
reviewed and tested against the real `<audio>` element.

**Rejected.** *A native-aware branch inside `AudioProvider`*: the one thing the brief explicitly
asked not to do, and it would need testing the browser and native paths separately for logic that
should never differ between them. *A full native player screen, native UI over the WebView*:
contradicts "shared reader" — the reader, the chapter list, the track list and the player's
controls are the web app's UI, unchanged, in both places. *Having native read `AudioProvider`'s
state directly (a bigger shared bridge object)*: `AudioProvider` already exposes exactly the
surface a `<audio>` element needs; duplicating that as a second, parallel API would be more code
to keep in sync for no benefit.

**Consequences.** `apps/web/src/player/native-bridge.test.ts` unit-tests the whole bridge (what
each `HTMLAudioElement` property/method sends, that an incoming status sets fields before firing
the matching event, the media-session shim) without any native code or WebView running — it is
plain TypeScript, tested with vitest + jsdom like every other web unit. `apps/mobile`'s half
(`src/audio/NativeAudioEngine.ts`) has no native build on this box to run tests against; it is
typechecked and exercised in the simulator instead (D139).

## D132. One `AVAudioSession`: recording allowed, mixed with other audio, always

*Superseded in part by D182: the session no longer mixes with other apps' audio (`doNotMix`), which
is what makes the app the Now Playing app. Recording stays allowed for the app's life, as below.*

**Decision.** `configureAudioSession()` (`apps/mobile/src/audio/NativeAudioEngine.ts`), called once
at launch, sets `allowsRecording: true` and `interruptionMode: 'mixWithOthers'` for the whole app's
lifetime, rather than switching categories when a voice channel (another workstream) or talking to
Cal starts. `allowsRecording: true` puts iOS's audio session in `.playAndRecord` even before
anyone records (a dim, standard mic-in-use indicator the whole time the app is open), and
`mixWithOthers` lets the book keep playing underneath. expo-audio's own docs note that
`doNotMix`/`doNotMixPersistent` is the safer choice "for lock screen controls to work correctly,"
which this does not use — a deliberate trade accepted without the hardware to verify which way it
actually goes (D139), because the alternative (switching categories the moment a voice channel
opens) risks an audible glitch or the lock-screen session dropping mid-chapter, which the brief's
explicit "optional autopause on interruption" and "talk while listening together" both treat as
the worse failure.

**Rejected.** *Switch category only when a voice channel opens*: cleaner on paper, but a category
switch while a track is playing is a known source of a short audio glitch or dropout on iOS, right
when the social moment (someone starts talking) is happening. *`duckOthers` instead of
`mixWithOthers`*: automatically lowers the book's volume while anyone talks, which is a product
choice that belongs to the voice-channel workstream, not to this app's audio session setup.

**Consequences.** If the simulator or a real device shows the lock screen losing the app's Now
Playing info under this category (mediaCapturePermissionGrantType's caveat made real), the fix is
narrow: call `setActiveForLockScreen` again after any route or category change, which expo-audio
already exposes, rather than reverting to `doNotMixPersistent` and reopening the glitch risk.

## D133. Authenticated native playback: the shared cookie store, not a signed URL

**Decision.** A track's URL is handed to native (`NativeAudioCommand`'s `load`) exactly as the page
already has it — no token, no signed URL, no manual `Cookie` header. The `<WebView>` sets
`sharedCookiesEnabled` (`BookClubWebView.tsx`), which — read directly from react-native-webview's
own iOS source (`apple/RNCWebViewImpl.m`, v14.0.1: `cookiesDidChangeInCookieStore:` writes every
WKWebView cookie back to `NSHTTPCookieStorage.sharedHTTPCookieStorage` whenever it changes, and
`syncCookiesToWebView:` reads it back the other way) — keeps WKWebView's own cookie store and the
classic `NSHTTPCookieStorage` in sync both ways. Signing in inside the WebView therefore leaves the
session cookie (even though it is `httpOnly`) in the same store `AVURLAsset` (which `expo-audio`
uses) and this app's own `fetch` calls consult by default on iOS. Spoiler gating is unaffected: it
is the same session, the same cookie, the same `requireUser` check the server always ran.

**Rejected.** *A short-lived signed media URL minted by the server*: a new server endpoint, a new
expiry policy to get right, and a second way to reach the same media routes to keep in sync with
the cookie-gated one, for no benefit over a mechanism react-native-webview already ships and that
needs no server change at all. *Reading the cookie with `@react-native-cookies/cookies` and
attaching it as a header by hand*: would also work (and was the first design), but is strictly more
code than letting the two stores sync themselves, once `sharedCookiesEnabled` is read closely
enough to know it already does this; dropped from `package.json` once that was confirmed.

**Consequences.** No `@react-native-cookies/cookies` dependency. If a future server change ever
makes media routes require something `NSHTTPCookieStorage` cannot carry (a second factor per
request, say), this decision is the one to revisit — everything here assumes the classic cookie
jar is authoritative for native requests, which is Apple's documented default behaviour for
`AVURLAsset` and `URLSession`, not something this app configures.

## D134. Push: a raw APNs device token, not Expo's push service

**Decision.** No Expo account exists, so push is end to end the team's own: the app registers for
push and reads the raw token with `expo-notifications`' `getDevicePushTokenAsync` (never
`getExpoPushTokenAsync`, which needs Expo's servers), `POST`s it to `/api/push/register`
(`apps/server/src/routes/push.ts`, migration `014_push_tokens.sql`), and the server sends over its
own HTTP/2 connection to Apple with a provider JWT (ES256) signed by the team's `.p8` key
(`apps/server/src/push/apns.ts`) — token auth, not a `.p12` certificate, so one key covers every
build. `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` and `APNS_PRIVATE_KEY` are read from the
environment together or not at all (push stays off, silently, with unset — the in-app bell is
unaffected either way); `APNS_PRODUCTION` picks Apple's sandbox or production host. A push's words
and its target are drawn from the exact same `NotificationView` the bell renders
(`apps/server/src/services/push.ts`'s `pushPayloadFor`, mirroring `apps/web/src/components/
Notifications.tsx`'s `describe()`): a reply gated by D69 stays gated in its push too, and the
payload's `path` is the bell's own link format (`/books/<id>#note-<id>`), opened on tap through
`window.__bookClubNavigate` (`src/push/deepLink.ts`, installed from `apps/web/src/main.tsx`) — the
client-side router, not a full page reload. A `410 Unregistered` or `400 BadDeviceToken` reply
drops the token (`repos/push-tokens.ts`); unregistering is scoped to the token's own owner, so one
person cannot silence another's device by guessing (or being handed) their token.

**Rejected.** *Expo's push service*: needs an Expo account, which does not exist, and would be one
more hop (app → Expo → Apple) for no benefit once the server already needs to exist and already
sends the in-app bell's websocket pushes itself. *A `.p12` certificate per environment*: expires
yearly per app and needs separate sandbox/production certificates; one `.p8` key with token auth
covers both, forever, and is what Apple recommends for new integrations. *Node's built-in `fetch`
for the APNs HTTP/2 calls*: undici's `fetch` does not speak HTTP/2 to arbitrary origins; this uses
`node:http2` directly (`apps/server/src/push/apns.ts`), with an `APNS_AUTHORITY` override that lets
tests point it at a local plaintext (h2c) fake Apple instead of the real one.

**Consequences.** `apps/server/test/apns.test.ts` and `test/push.test.ts` run the whole path (the
provider JWT's shape, the topic and collapse-id headers, 410/400 handling, the actual reply that a
real reply-and-notification flow produces) against a fake APNs with no network and no real Apple
key. The App Store Connect side (TestFlight's own APNs entitlement, `aps-environment`) is D137's
concern, not this one's.

## D135. WKAppBoundDomains for offline reading; external links leave the app

**Decision.** `plugins/with-app-bound-domains.ts` (a custom Expo config plugin — no existing
package offers this) sets `WKAppBoundDomains` in Info.plist to the production host plus whatever
`BOOKCLUB_SERVER_URL` points a dev build at (Apple's ten-domain limit enforced at prebuild time, so
a mistake fails loudly rather than silently). The `<WebView>` sets
`limitsNavigationsToAppBoundDomains`; together these make WKWebView's service worker support (the
whole reason the feature exists — webkit.org/blog/10882/app-bound-domains) reliable, which is what
`apps/web`'s offline reading needs. Because that restriction would otherwise make a plain outbound
link ("App-bound domain failure") rather than open it, `onShouldStartLoadWithRequest`
(`BookClubWebView.tsx`) sends anything whose host is not the server's own to `Linking.openURL`
(Safari) before WKWebView ever tries to navigate there. The screen is rendered full-bleed (a plain
`View`, not a `SafeAreaView`): `apps/web`'s own CSS already insets by `env(safe-area-inset-*)`
(`viewport-fit=cover`, `src/styles/base.css`), which only reports the real notch/home-indicator
insets when the WebView fills the screen; a native inset on top would just be a second, redundant
margin.

**Rejected.** *No App-Bound Domains, accept unreliable offline reading in the app*: defeats one of
the brief's four native responsibilities outright. *A native "open in Safari" button instead of
intercepting navigation*: does not stop the failed in-app navigation from happening first.
*SafeAreaView, with the web CSS's safe-area insets removed for the app build*: would need a second
code path in `apps/web`'s CSS keyed on "am I in the app," solving a problem App-Bound Domains and
full-bleed rendering together do not have in the first place.

**Consequences.** A dev build's App-Bound Domains list grows by one entry (its own
`BOOKCLUB_SERVER_URL` host) alongside the production one; `scripts/prebuild.sh` must be re-run
(not just `run-simulator.sh`) after changing it, since this is an Info.plist key baked in at
prebuild, not something read at runtime.

## D136. Camera and microphone inside the WebView: `getUserMedia` and `MediaRecorder` must work

**Decision.** `mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"` on the `<WebView>`
(so once the person allows the mic or camera for the server's own host, further `getUserMedia`
calls from pages on that host do not re-prompt), one `NSMicrophoneUsageDescription` (expo-audio's
own `microphonePermission` plugin prop, naming all three uses it is shared between — voice notes,
voice channels, talking to Cal) and `NSCameraUsageDescription` (`app.config.ts`'s `ios.infoPlist`,
for photo and video notes). No `NSPhotoLibraryUsageDescription`: picking an existing photo through
`<input type=file>` uses the modern `PHPickerViewController`, which runs out-of-process and needs
no permission at all; only taking a new photo does.

**Rejected.** *A native camera/mic screen instead of the web app's own*: again against "shared
reader" — voice notes, voice channels and talking to Cal are being built in `apps/web` by other
workstreams using `WebRTC`/`MediaRecorder`, and this app's only job is to make sure a WKWebView
lets them work at all. *`mediaCapturePermissionGrantType="grant"`*: grants on the first ever
request for any host, which would extend trust past the server's own origin.

**Consequences.** This is unverified beyond reading react-native-webview's documented behaviour
for the prop and Apple's own change notes for `PHPickerViewController` (D139): the simulator run
this session could complete did not reach a page that calls `getUserMedia`, since those pages are
other workstreams' work in progress. Re-check once they land.

## D137. App identity: "Book Club," `com.example.bookclub`, an open codex rather than lettering

**Decision.** Display name "Book Club," bundle id `com.example.bookclub`. The icon and splash
(`apps/mobile/assets/icon.svg` → `icon.png`/`splash.png`, 1024px, no transparency) are an open
codex with a sanguine ribbon bookmark, drawn as plain SVG shapes (paths and rects, no text) in the
manuscript look's three colours (parchment `#f4ead2`, ink `#2a1c12`, sanguine `#93361c`;
the look another workstream is giving the web app). `aps-environment`
(D134's push entitlement) is `development` for every build except a TestFlight/App Store archive,
switched by `BOOKCLUB_APS_ENVIRONMENT=production` (`scripts/archive.sh`), so a plain simulator or
ad-hoc build never claims the production APNs environment it is not signed for.

**Rejected.** *A Cinzel "B"*, the brief's other suggestion: would need the font to be present
wherever the icon is rasterised (this session's own tooling, and whatever renders it later); a
shape avoids that dependency entirely for a one-letter difference in distinctiveness. *Reusing one
of the web app's own SVG assets as-is*: the web app's icons are drawn for a UI at a few sizes in
context, not for an app-icon mask (rounded-corner safe zones, no fine detail that disappears at
60×60); this is a separate, purpose-drawn asset.

**Consequences.** If the web app's restyle (the other workstream) settles on a different sanguine
or ink shade, `icon.svg`'s three `fill`/`stroke` colours are the only thing to update, and
`scripts/prebuild.sh` regenerates everything downstream of them.

A real archive attempt on the Mac EC2 (2026-10-28) found two more things this bundle id and this
shared box need, now in `scripts/setup-mac-ec2.sh` and `apps/mobile/README.md` ("TestFlight") with
the evidence: `xcodebuild archive` needs `DEVELOPMENT_TEAM` set (an Apple Developer Team ID, not
Expo's or App Store Connect's own concepts; `<TEAM_ID>`, read from another app's own Xcode project
on the same box, worked but is not independently confirmed as the right team for this bundle id),
and a dedicated signing keychain, since a bare SSH session on this box has no default one at all.
With both, archiving stopped one step further in, on a signing certificate this Apple Developer
Team already holds for this machine (almost certainly another app's own) whose private key is not in
this keychain — Xcode offers to revoke and recreate it, which this session declined to do
non-interactively on a box another workstream's signing may depend on. See the README section for
what the coordinator can do next.

## D138. Offline audiobook playback: the current book, not a library manager

**Decision.** `NativeAudioEngine` downloads whatever track is currently loaded to
`expo-file-system` the first time it plays (in the background, never blocking playback, which
streams exactly as before while the download runs) and plays from that local copy on every load
after. This is "implement downloads for the current book if feasible" from the brief, taken at its
word: it is deliberately not the web app's existing, explicit "save for offline"
(`apps/web/src/lib/offline.ts`'s `saveEditionOffline`, which fills the browser's Cache Storage) —
that button does not yet reach native at all, so saving an audiobook offline there does not (yet)
make this app's own playback read from a local file ahead of time.

**Rejected.** *Building the full "mark any book offline" manager in the time available*: needs a
new bridge message (which edition's tracks to fetch ahead of time, not just the one playing), a
storage cap and eviction policy once a club has more than one long audiobook's worth of local
files, and a download-progress UI — three new pieces of design, each wanted to be right rather
than rushed, against one that already delivers the brief's stated minimum. *Not downloading
anything natively at all, leaving this to the browser's Cache Storage (which this app's playback
cannot read)*: would mean "offline" never actually works for native audio playback in the app,
which is a bigger gap than a library manager's absence.

**Consequences.** `apps/mobile/README.md`, "What is not built," states exactly what remains: the
bridge message, the storage policy, and wiring `saveEditionOffline` to send it. Nothing here
conflicts with building that later — `localFileFor`'s naming scheme (now `offlineBaseName` plus the type's extension, D219) already gives any future
prefetch call a place to put files that `load()` will find.

## D139. Verification: typecheck and a scripted simulator run, not a native test suite

**Decision.** `apps/mobile` has no Jest/Detox/XCUITest project. Its own `package.json` has a
`typecheck` script (`tsc --noEmit`, run as part of the monorepo's root `pnpm typecheck`, which
recurses into every workspace that defines one) and its own `eslint.config.js` (React Native
globals, no type-aware rules against the rest of the monorepo), but no `test` script — so the
root's `pnpm test` recursion skips it, rather than failing on a suite that does not exist. The web
half of the bridge (`apps/web/src/player/native-bridge.ts`, `native-bridge.test.ts`) and the server
half of push (`apps/server/src/push/apns.ts`, `test/apns.test.ts`, `test/push.test.ts`) are real,
run-on-every-gate unit tests; what those two cannot cover — whether `expo-audio` actually shows
Now Playing info the way D130-D132 read its source as saying it will, whether a push notification
really routes through `window.__bookClubNavigate`, whether `getUserMedia` works inside the WebView
at all (D136) — is instead verified by building and running the app in the iOS Simulator on the
Mac EC2 and taking it at face value: screenshots, `xcrun simctl push` for a push-shaped
notification, backgrounding the app and checking playback and the lock screen with `simctl`.

**Rejected.** *Setting up Jest + a native test runner (Detox, Maestro) for one small app*: the
brief itself offers "ideally" for this, and the four required scripts (prebuild, simulator run,
archive, upload) do not depend on it existing; a scripted but manual-grade simulator pass answers
the real question (does the native half actually work) more directly than a UI-testing framework
this session would also have had to learn and debug from zero on a shared, unfamiliar build box.
*Skipping verification on the simulator entirely, shipping on typecheck and reasoning from
documentation alone*: unacceptable for exactly the claims (lock-screen controls, simultaneous
playback and recording, a push notification opening the right place) that are the hardest to get
right from documentation and the easiest to get subtly wrong.

**Consequences.** Whatever this session's simulator run did and did not confirm is stated plainly
in the final report and `apps/mobile/README.md`, not implied by the code's own comments existing.
A later session (or Cole, on a real phone) re-running `scripts/run-simulator.sh` is the fastest way
to re-check any of this after a dependency bump.

## D170. Cal's panel is one shared instance, opened from the reader/player's own header, never a floating button there

**Decision.** `CalLauncher.tsx` now splits in three: `useClubCalContext()` (which club and book to
ask about, and whether Cal is set up) is shared by every opener; `CalLauncher` is the floating
button, rendered everywhere signed in except the reader (`/books/:id/read`) and the player
(`/books/:id/listen`) — on a reading surface a floating circle either sits over the text or over
the player's own controls (the exact bug this closes: it covered Play on a landscape phone); and
`CalHost`, mounted once beside it in `App.tsx`, renders the one `CalPanel` instance whichever
button opened it asked for (`cal/calStore.ts`'s `openCal`/`closeCal`/`useCalOpen`, a tiny
`useSyncExternalStore` module, the same shape as `live/voiceStore.ts`). `EpubReader`, `PdfReader`
and `ListenPage` each add their own "Ask Cal" icon button (`Icon name="sparkle"`) to their existing
header, beside Contents/Reading settings/Leave a note (readers) or Track list (player), calling
`openCal(clubId, bookId)` — `cal-launcher` stays the `data-testid` on whichever button is showing,
so `e2e/tests/cal.spec.ts`'s `askCal()` helper needs no change.

A look's chip (`.look-chip`/`.follow-chip`, D41/D58/D62/D72) takes over the header's middle on a
narrow phone; Ask Cal, the newest of its buttons, is hidden there (`app.css`,
`.reader:has(.look-chip, .follow-chip) [data-testid='cal-launcher']`) rather than crowd "Back to
reading"/"Read from here" into the next button over — it returns the instant the look ends. The
player's header has even less room on a portrait phone (only two buttons' worth of margin is left
for a toast beside them, `toast-place.ts`): there, under 500px (`CalLauncher.tsx`'s own
`useNarrow`, matched by `app.css`'s `.listen-page .reader-header [data-testid='cal-launcher']`),
the header button hides and the floating one takes over instead, exactly as it does on every page
that is not a reader or the player. A landscape phone (734×343, 667×375 — this decision's own
motivating case) is wide enough to keep the header button throughout.

**Rejected.** *Keeping the floating launcher on every page, moving it instead*: D160 pins it to a
fixed corner so it is always findable; nowhere on a reader/player screen is both guaranteed clear
of the text or the controls and not itself an awkward, migrating target. *A fixed per-page button
count in `toast-place.ts`'s header-room math (bumping its `3 * var(--tap)` constants)*: measured
against the actual rendered buttons on a 393px phone, no reservation large enough to fit Ask Cal
also leaves room for the floating chip without itself pushing past the screen's edge — the
constants stayed at their original value, tuned for the buttons that are still there once Ask Cal
steps aside. *One global `useState` in `CalLauncher.tsx` as before*: it could only ever answer to
the one button that owned it; two openers (the floating button and a header button) needed one
instance between them, hence the small shared store.

**Consequences.** `e2e/tests/polish16.spec.ts`'s "small laptop" and "player on a computer" cases
now note a fifth header button in their comments; their assertions did not need to change except
where the toast's placement genuinely does (a toast beside five header buttons on a 760px laptop
no longer fits in the header and goes over the page instead, still covering nothing — the test's
title and comment now say so). `polish16.spec.ts`'s `coveredControls()`/`expectAccessible()` checks
on every one of these pages, run after this change on a development host, are the evidence that no
header button, in any of these states, ends up under anything else.

## D171. The player's "listening together" line stays one line under the club bar at every size, Play first

**Decision.** `PartyBar`'s "Listen together" and `VoiceBar`'s "Join voice"/"Nobody is in voice"
(merged from the live and notes-adjacent workstreams into one `.listen-live` row under the club bar
in `ListenPage.tsx`) keep their full labels everywhere except a phone turned on its side
(`app.css`'s existing `@media (orientation: landscape) and (max-height: 520px)` breakpoint, already
narrowing `.listen-main` for the same reason): there, each label is wrapped in its own
`<span class="party-label">`/`<span class="voice-label">` with the button's own `aria-label` as a
fallback, and `live.css` hides the span only inside that one breakpoint — the tap target stays the
full `--tap` (44px) `.btn`, only the text that made it wider goes. The breakpoint also tightens the
club bar's own padding (`.reader-bar .club-bar`, 32px/13px down to 20px/8px — still clear of the
avatar dots above the track) and the `.listen-main` grid's row-gap and top padding (8px to 4px
each): together with D170 removing the floating Cal button from this page (which is what was
actually sitting on top of the scrubber in the original bug, not the live line by itself), Play and
the position slider are back in the first screen's viewport at both tested sizes (734×343, 667×375)
on both engines.

**Rejected.** *Shrinking the live line's buttons below 44px*: the design brief for this work
asks for 44px tap targets explicitly; the row's height is the taller of its two
buttons regardless of their text, so hiding the words saves width, not height, and height is what
was short — the real room came from the club bar's padding and the grid's gaps instead.
*Hiding "Nobody is in voice"/"Listen together" outright on this breakpoint*: already done, for the
"nobody" half, by the uncommitted fix this session inherited (`.listen-live .voice-empty`); "Join
voice" and "Listen together" stay as icons with a name, not silence, so a screen reader still says
what the button does.

## D172. PR #13 review findings: fail closed, require live membership, validate manifests, cap unbounded buffers

**Decision.** Fixed all eight review findings on PR #13 at their root cause, each the same shape —
something that should have failed closed or required a current check instead defaulted open or
trusted stale/untrusted state:

- **Mobile native audio** (`NativeAudioEngine.ts`): a monotonic `LoadSequencer` token, checked after
  every `await`, so an overlapping `load()` never lets an earlier call's stale result win; a
  completed `downloadAsync` is now checked against its HTTP status before being trusted as a cached
  track, and deleted if it was really an error body. Both extracted to `@bookclub/shared` since the
  native module itself has no test harness.
- **Listening party host** (`party.ts`): `leave()` now hands `hostId` to the longest-standing
  remaining member, and `control()` requires the caller to still be a current `members` entry for
  any action — a departed host no longer keeps control by virtue of `hostId` never having changed.
- **Chat spoiler fence** (`chat.ts`): a fenced message with no gate/reading context to judge it
  against (its book gone, or a request racing a delete) now fails closed (hidden), not open.
- **Backup restore** (`backup-set.ts`): every manifest entry's `sha256`/`editionId`/`path` is
  validated against a strict shape (64-hex sha256, safe id, no `..`/absolute path) before any
  filesystem operation, closing the path-traversal both a tampered local set and an overwritten
  object-store manifest could otherwise reach.
- **Cal voice turns** (`cal-voice.ts`): a `TurnBuffer` (capped at 25 MB, `@bookclub/shared`) replaces
  the unbounded chunk array; a turn that would exceed the cap closes the socket instead of growing
  forever.
- **LiveKit membership** (`clubs.ts`/`livekit.ts`/`hub.ts`): removing a club member now also ends
  their real LiveKit RTC session (`disconnectParticipant`, best-effort, never blocking the removal)
  and clears the hub's own voice presence for every room this hub has seen them join in that club,
  not just their app WebSocket.
- **Cal series tenancy** (`cal.ts`): `PUT /api/books/:bookId/series` now requires the target series'
  `club_id` to match the book's own club, 404ing otherwise, instead of accepting any existing series
  id regardless of which club it belongs to.

**Verified.** Full gate (typecheck, lint, all unit tests across `packages/shared`, `packages/epub`,
`apps/server`, `apps/web`, and mobile's typecheck) green on a development host; `tests/live.spec.ts`,
`tests/cal.spec.ts` and `tests/media-notes.spec.ts` green on both `chromium-desktop` and
`webkit-iphone`.

## D173. Club chat redesigned, opened over the book, with a Do Not Disturb switch

**Decision.** Cole's first evening on the iPhone app: "chat UI kinda sucks", and he wanted the club's
chat and voice one tap away from the page he is reading. Club chat's bubbles are compact and grouped
by sender and time, with edit, delete and reactions in one overflow menu instead of a row of icons
inside every bubble; channel chips (General, then one per book) replace the plain `<select>`; the
composer is one auto-growing line with a paper-plane send button, pinned clear of the iOS keyboard
(`useSeenArea`) and of Cal's button. A header button on the EPUB and PDF readers and on the player
opens the club's chat and voice as a sheet over the book (`live/ChatSheet.tsx`), with an unread
badge, so the place and the audio keep going. The reader's "leave a note" button takes a quill icon
now that the chat bubble means club chat everywhere.

**Do Not Disturb** is one switch per person, kept by the server (migration 016, `chat_dnd`; absent
means off; `GET`/`PUT /api/chat/dnd`). While it is on, a chat mention is still recorded in the bell,
so turning it off shows what was missed, but sends no push and shows no in-app toast. Replies and
"a friend reached your note" are not chat and are never silenced by it. Another device sees the
switch within react-query's refetch (30 s), not live.

## D174. Every note marked where it is; the notes sheet shows its media and gets small icons

**Decision.** Some notes showed in the club bar but never got an inline mark. A note written in
another edition (the player, most often) was placed with a raw timeline lookup, which near a chapter
boundary could land a hair before this edition's chapter start, in the section already read past, so
its margin marker was silently dropped. Both readers now place it through `commentLocatorIn`
(`reader/position.ts`): the exact own-edition locator when the note has one, else `translatePlace`
with the same chapter-start snap the reader's own saved place already gets (D93, FR142).

The notes sheet that opens from a marker never rendered a note's media, so a photo note opened to
nothing; it now renders it as the book page does. Delete and Reply are small icon buttons beside the
note, not stacked text buttons. The line under your own note written from further on ("Friends read
this once they have read to …", D69) is gone everywhere at Cole's request; the hold itself is
unchanged.

## D175. A new icon: the club talking about a book

**Decision.** Cole on the TestFlight icon (D137's dark codex with its ribbon on parchment): "kinda
wack, do better". It read as a smudge at home-screen size and said nothing about a club. The icon is
now a parchment speech bubble holding an open ink codex, on a sanguine field, the same palette as
the web app (D117's parchment and ink): a club talking about the book in front of it. Of six drawn and
compared at 180 and 60 px on light and dark wallpapers, this was the only one still clear at 60 px
and the only one that says "club" rather than "reading app". One source (`apps/mobile/assets/icon.svg`)
rendered with `rsvg-convert` to the app icon, splash (the sanguine bubble small on parchment),
the web's 192/512 and Apple touch icons, a maskable 512 with the mark inside the 80 % safe circle,
and a simplified favicon (no page lines) that the app bar's brand mark also uses. No text, no
transparency. The native icon changes with the next TestFlight build; the web's with the next deploy.

## D176. Anyone signed in starts a club; Cal moves to his own settings; lighter buttons; a real home page

**Decision.** Cole: "anyone should be able to create a club and invite their friends." D52 let an
account made through the upstream's sign-in start a club only once a club had let it in (SA31's fix, so
that one upstream login could not quietly use the instance); that rule is gone: every signed-in
account starts clubs the same way (`packages/shared/src/clubs.ts` and its gate in `POST
/api/clubs` removed). What bounds the instance instead is per person and per month: one account
owns at most `CLUBS_OWNED_MAX` clubs at once (5; the next start is 409 `club_limit`), and next to
each club's `CAL_MONTHLY_SPEND_CAP_USD` (20) there is now `CAL_INSTANCE_MONTHLY_SPEND_CAP_USD`
(100), every club's Cal spend together, checked before every chat and voice turn
(`calBudgetSpent`), since with clubs free to start the per-club cap alone no longer bounds spend.
SA31's other two fixes (at most 50 live sessions per person, sessions started only by `/api/`
requests) stand.

The home page is a landing rather than a dead end: "Start a club" and "Join with a link" (a pasted
invite link or bare code) are always there, and each club's card shows friends online and unread
chat. Cal's panel is chat only again; a gear in its header opens his settings: his shelf (a URL, or
a PDF, EPUB, text or Markdown file, through the upload route that had no client before) and the
standing spoiler scope, the whole series or only what you have read, which had no control at all
(and now flips at once, reverting only if the save fails). `.btn` is an outline at the radius cards
and sheets already use instead of a filled pill; `.btn-primary` is the one filled accent, and
`.btn-ghost` is text that underlines on hover.

## D177. An upstream password, typed straight into Book Club's own sign-in form

**Decision.** In the iOS app "Continue with the upstream" never finished: the WebView sends every other
host to Safari (D135), so the sign-in completed there and Safari stayed on the website. The upstream now
serves `POST /api/auth/book-club/password`, server to server: the same bcrypt check and
disabled/no-password refusals as its own login, one generic 401 for any failure, rate-limited by the
attempted email (the upstream trusts only its own nginx hop, so there is no end-user address it could
key on). It answers with the same one-time PKCE-bound grant `/exchange` already redeems. Book
Club's `POST /api/auth/signin` falls back to it only when no local account with that email has a
password of its own, with a fresh PKCE pair, and redeems the code at the existing exchange address
exactly as the OAuth callback does: no second copy of the identity logic. `UPSTREAM_PASSWORD_URL`
is optional and independent of the other two addresses; without it the fallback is off and the
form does not mention it.

Inside the iOS app the sign-in page offers only that form (and "Sign in with a code"); in a browser
it keeps "Continue with the upstream", because an account that signs in to the upstream with Apple or Google
has no password to type. The invite page's button is unchanged. Native Sign in with Apple and
Google, in the system's in-app sign-in sheet, come with the next TestFlight build and replace the
round trip in the app altogether.

**Deploy order.** The upstream's endpoint first, then Book Club with `UPSTREAM_PASSWORD_URL` set
(`docs/DEPLOY.md`); Book Club without it simply keeps today's behaviour.

## D178. Native "Sign in with Apple" and "Continue with Google," replacing the in-app round trip

**Decision.** The iOS app signs in with Apple and Google itself, in the system's own sheets,
instead of D177's form: `POST /api/auth/apple` takes the identity token `expo-apple-authentication`
already got in-process (`apps/mobile/src/auth/NativeAuthEngine.ts`) and verifies it against
Apple's JWKS (`apps/server/src/auth/apple.ts`, `jose`): signature, issuer, `aud` in an allow-list
(`APPLE_AUDIENCES`), expiry, and a nonce check following Apple's own convention (and every other
client's, Firebase's among them) — the app sends the raw value it generated; Apple's token carries
its SHA-256 (hex); the server redoes the hash. Google is a server-side OAuth
authorization-code-with-PKCE flow (`apps/server/src/auth/google.ts`), shaped deliberately like
D116's own grant (a sealed, `__Host-` flight cookie; the same constant-time state check) but
talking to Google's real endpoints, configurable (`GOOGLE_AUTH_URL`/`GOOGLE_TOKEN_URL`/
`GOOGLE_JWKS_URL`/`GOOGLE_ISSUERS`, defaulting to the real ones) the same way the upstream grant's
own addresses always were rather than hard-coded, so the demo stack can point the whole flow at a
local stand-in (`tools/fake-google`, mirroring `tools/fake-upstream`'s shape: an authorize page, a
login form, a token endpoint, and — new, since this flow actually verifies an id_token's
signature — a `/jwks` endpoint of its own, ES256-signed with only `node:crypto`, no dependency).
`GOOGLE_REDIRECT_URI` is one fixed, pre-registered address (unlike the upstream's loopback-name swap,
`startAddress` in `auth/upstream.ts`: nothing here lets a request's own Host header choose where
Google is told to send the code, or a chosen redirect target would be an open redirect of
Google's own authorization code). A browser's "Continue with Google" is this same flow; the app's
is a browser session the app opens and closes around it (`expo-web-browser`'s
`openAuthSessionAsync`) with its own, separate PKCE challenge (`GET /api/auth/google/start?app=1
&challenge=…`, never sent to Google — only this server's own PKCE conversation with Google uses
its own pair), ending in a one-time code at `bookclub://auth?code=…`
(`repos/app-codes.ts`'s `app_auth_codes`, bound to that challenge) which the app redeems from
*inside the WebView* (`POST /api/auth/app-code`), so the session cookie that sets lands in the
shared cookie store native playback already reads (D133) rather than the ephemeral browser
session that talked to Google.

**Linking (`apps/server/src/auth/external-identity.ts`).** A new table, `external_identities`
(provider, subject) → user (migration 017), rather than overloading D116's single-column
`upstream_subject`: a person may end up linking Apple, Google and the upstream all at once, which one
column cannot hold. Checked in order: (1) signed in with this exact (provider, subject) before →
that account; (2) a verified email the provider vouches for (Apple's always is; Google's only
when `email_verified`) matches an existing account's → that account — and the provider's proof
wins outright: since Book Club itself never verifies an email (D14), if that account is local and
still has a password of its own, linking **clears that password** (`clearPasswordHash`), revokes
every other session, and closes its live realtime sockets too (`ctx.hub.revalidate` +
`ctx.hub.disconnectUser`, the same pair password change and sign-out-everywhere use), logging why
(never the token, the password, or any secret) — review found the first cut of this left the
password in place and the sockets open: whoever had registered that email first with a password
of their own kept durable access to the real owner's account after linking, and a live WebSocket
kept receiving the club's notes and chat past the point the revocation was meant to stop it. The
owner signs back in with the provider from here on, or gets a password again through an
owner-issued reset link — the normal path for a passwordless account already is. (3) neither → a
new, passwordless account, exactly as the upstream grant makes one, free to start a club like any
other (D176's caps apply the same way).
`source` on `User`/`Member` (`packages/shared`) widens to `'apple' | 'google'` alongside
`local`/`upstream`: a password on file always wins (the clear above means the only way an account
is now both password-holding and provider-linked is the *other* order — passwordless first,
a password added later by a reset link), and only the upstream grant's own name stays locked
(`PATCH /api/me`, Settings): Apple and Google hand a name over once, on the very first sign-in,
with nothing ongoing to keep in sync.

The same review round found two more: `GET /api/auth/google/start` returned early whenever
`request.user` was set, including the app's own handoff (`app=1`) — `ASWebAuthenticationSession`
shares Safari's cookies by default, so a Book Club session already open there made the app's
"start" redirect straight to `next` instead of ever reaching Google, leaving the native engine
with no `bookclub://auth` code to hand the WebView; fixed by skipping that shortcut whenever
`app=1`, matching the callback's own `appChallenge` check, which already did. And `start` had no
`Sec-Fetch-Site` guard at all, unlike `GET /api/auth/upstream`'s — a third-party page could start
Google's OAuth dance in a signed-out victim's browser (state and PKCE still blocked signing them
into someone else's account, but a same-origin click should be where this begins, not any page);
fixed with the identical guard upstream's route uses, which — being `none`/`same-origin`-permissive
already — needed no app-specific carve-out: `ASWebAuthenticationSession`'s own top-level,
user-initiated navigation sends exactly one of those.

**Scope not built.** "Sign in with Apple" on the **web** sign-in page needs a Services ID — its
own OAuth client, registered at Apple, for a browser-based flow distinct from the native bundle
id — and this change made no Apple (or Google) console changes of any kind, so it stays off,
correctly, by the same all-or-none configuration rule every other provider here follows
(`APPLE_AUDIENCES` unset ⇒ hidden). The server-side verification it would use is already built and
tested (the same `apps/server/src/auth/apple.ts` the native path calls); only the Services ID, its
authorization redirect and a `form_post` callback remain, whenever a Services ID exists.

**Rejected.** *Reusing D116's upstream cookie-adapter shape for Google, with Google itself as the
"upstream"*: D116 exists because the upstream is a separate site with its own accounts; Google is not a
second Book Club identity provider to delegate to wholesale, it is one of two sign-in methods
alongside Apple, and conflating them would tangle the single-upstream `SessionInfo.upstream`
field (D14, one account people "continue with") with a multi-provider concept it was never shaped
for — `providers: { apple, google }` is its own, independent flag pair instead.
*A single `providers` array instead of two named booleans*: two fixed providers, not an open set;
a web client checking `providers.includes('apple')` buys nothing a `providers.apple` boolean does
not, and loses the one place to hang a doc comment per provider.
*Overloading `upstream_subject` with a provider prefix (`apple:<sub>`, matching D116's own
`upstream:<id>`)*: the motivating case — someone who signs in with Apple and later also with
Google, both resolving to one account — needs two rows, which one column cannot hold; a bare
prefix string also carries no email, audit trail, or room for more than one link per user.
*Deriving Google's `redirect_uri` from the request, as `startAddress` does for the upstream's loopback
names*: the upstream's grant lets Book Club pick its own callback per request (it is reached by two
names only on one developer's machine); Google's redirect_uri is one address, registered with
Google in advance — deriving it from a request's Host header would let an attacker who controls
that header point the authorization code at a host of their choosing.
*A hand-rolled base64url/SHA-256 PKCE implementation on the native side instead of `expo-crypto`*:
`expo-crypto`'s `digestStringAsync` and `getRandomBytesAsync` are the documented, audited way to
do this on-device; only the base64 alphabet swap (`+/` → `-_`, strip padding) needed writing by
hand, since RFC 7636 and this server's own `challengeOf` (`auth/upstream.ts`, now shared) want
base64url, not the standard base64 `expo-crypto` returns.
*A second inbound channel sharing `window.__bookClubReceive`, reusing `NativeAudioCommand`'s
union*: would mean widening a frequently-touched, already-tested type for an unrelated feature,
and double-parsing JSON meant for the other engine on every single message either one receives;
a sibling global (`window.__bookClubAuthReceive`, `apps/web/src/auth/native-auth-bridge.ts`) costs
one more declared global and nothing else, and keeps the audio bridge's own tests untouched.
*Testing the Google id_token verification only with `jose`'s in-process `createLocalJWKSet`*: that
would never exercise the real HTTP hop (`createRemoteJWKSet`) the real server makes, which is
exactly where a wrong URL, a slow response, or a malformed JWKS would actually show up — the
integration tests and `tools/fake-google` instead run a real local HTTP server for both the token
endpoint and the JWKS, the same shape the demo stack's container-to-container hop uses.

**Consequences.** Tapping "Sign in with Apple" or "Continue with Google" in the app never leaves
it, and never shows the upstream round trip D177 could not finish inside a WebView. A friend who
signs in with Apple or Google for the first time gets an account exactly like one made through the
upstream grant — no password, free to start a club — and one who already has a local password
account under the same verified email gets it linked, with every other device signed out of it
first. Deploying either provider is additive and independent: `APPLE_AUDIENCES` alone turns on
Apple (native only; its web button stays hidden with no Services ID configured); `GOOGLE_CLIENT_ID`
+ `GOOGLE_CLIENT_SECRET` + `GOOGLE_REDIRECT_URI` together turn on Google, on the web and in the
app alike. **For the next TestFlight build**: the App ID (`com.example.bookclub`) needs the "Sign In
with Apple" capability turned on in the Apple Developer Portal, and the App Store provisioning
profile regenerated after — `app.config.ts`'s `ios.usesAppleSignIn: true` only adds the
entitlement to the generated Xcode project, which is not the same as the App ID having the
capability; see `apps/mobile/README.md`'s "TestFlight" section. Redirect URIs to register with
Google: `https://books.example.org/api/auth/google/callback` in production (whatever
`GOOGLE_REDIRECT_URI` is set to); the native app registers no redirect URI of its own with Google
at all, since it never talks to Google directly — only this server does, and `bookclub://auth` is
this app's own custom URL scheme (already declared, `app.config.ts`'s `scheme`), not something
Google's console needs to know.

## D179. Disbanding a club and removing a book are soft deletes

**Decision.** An owner disbands a club from its settings (`DELETE /api/clubs/:clubId`), even as
its only owner: the "a club needs an owner" rule guards leaving, not ending it. A book is removed
from its book page ("Remove book", beside Edit) as well as from the Edit dialog; who may is
unchanged (the owner, or whoever added it). Both ask once, in the app's own confirmation, with
nothing to type. Both are **soft**: the row gets `deleted_at` / `deleted_by` (migration 018) and
the app treats it as gone, because `clubById` and `bookById` no longer find it, so every access
check (auth/access.ts) answers 404 as for any club or book one cannot see, every list leaves it out,
its invite stops working, its notifications drop out of the bell, and Cal skips its passages. Its
rows and files stay on the server. Members are told at once (`club:changed` / `book:changed`); a
disbanded club's members lose its sockets and its voice rooms (LiveKit included), as a removed
member does. The server's admin lists what was deleted (`bookclub deleted`), brings it back as it
was (`bookclub undelete --club ID | --book ID`), or removes it for good with the files nothing else
uses (`bookclub purge`, only for something already deleted in the app). Deleting a single format
(`DELETE /api/editions/:id`) stays immediate and permanent. Nothing purges on a timer yet: what is
removed keeps its disk space until the admin purges it.

## D195. Listening speed: any 0.05 step from 0.5× to 3×, a default on your profile, and each book's own

**Decision.** Cole asked for speeds between the presets (1.1×, 1.35×), a default of his own, and
each book remembering the speed he last used for it, everywhere he listens. A speed is any multiple
of 0.05 from 0.5× to 3.0× (51 of them; `packages/shared/src/audio/rate.ts`, kept as whole twentieths
so 1.35 is exact and never 1.3500000000000001), shown with at least one decimal ("1.0×", "1.35×",
"2.0×") so the label keeps its width as it steps. The player's speed button opens a sheet with a
− / + stepper (0.05 a tap) and eight presets (0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3; the stepper
reaches 0.5 and every speed between them); under them, the sheet says what your default is, that each book keeps its own,
and offers "Make 1.35× my default" whenever the speed playing is not it. Settings has the same
stepper and presets for the default, under "Listening", saved as you choose.

**Precedence.** A book opens at the speed you last chose for it, else your default, else 1.0×
(`resolveRate`). Choosing a speed in the player is choosing it for that book; it never changes the
default unless you say so. A book you have not chosen one for follows your default as it changes.

**Kept by the server, per person** (migration 020, additive: `listening_settings` for the default,
absent meaning 1.0× as `chat_dnd` does in D173; `book_playback` for each book's speed; both cascade
with the person and the book, so `bookclub purge` takes them too). `GET`/`PUT /api/me/listening`;
`PUT /api/books/:bookId/playback`, behind the same membership check as everything else of a book;
a book's speed comes back with your progress (`GET /api/books/:bookId/progress`, `playback`), which
the player already waits for, so opening a book costs no extra round trip. The server accepts only
the 51 speeds. Both are last-writer-wins on the chooser's clock (`at`), as reading progress is: the
device keeps a copy (`apps/web/src/player/speed-memory.ts`, per person, wiped at sign-out with every
`bookclub:` key), a speed chosen offline plays at once and is sent with the reading outbox when the
connection is back, and one sent late never overwrites a newer one chosen on another device in the
meantime. A refusal that would not change on retry (the book was removed) stops the retries.

**The player never waits for the default.** It opens a book at the best speed known (this device's
copy and the progress it already waited for); if the server's default arrives after a book with no
speed of its own opened, and you have not changed the speed meanwhile, the book takes it then,
without making it the book's own (`setRate(…, { fromDefault: true })`). Waiting for it first made
the player load later, enough that a Play pressed at once (a lock-screen Play in the E2E suite) found
nothing loaded.

**Listening together.** The party's speed is everyone's (D155): a speed chosen in a party goes to the
party, as before, and is kept as your own speed for that book; when the party ends, you are back at
yours. Drift nudges (D156) are not a speed anyone chose: the engine plays them, the speed shown and
kept never moves (`nudge`). A party's speed command now accepts only the 51 speeds, as a person's own
choice; nudges never reach the server.

**The iOS app.** The engine (`NativeAudioEngine.ts`) keeps the speed the page chose and gives it to
every new player as it is made (each track is a new `AudioPlayer`), not only once the page hears the
new track's metadata, with pitch correction asked for explicitly at `high` (AVFoundation's spectral
algorithm; expo-audio's default was time-domain). expo-audio's iOS `setPlaybackRate` capped every
rate at 2.0 (`Float(min(rate, 2.0))`, read in its SDK 58 source), so 2.5× and 3×, offered for a year,
played at 2× inside the app without saying so; `patches/expo-audio@58.0.10.patch` raises that cap to
3.0 (pnpm `patchedDependencies`; the Dockerfile copies `patches/` because a frozen install reads
every patch the workspace names, even for a package it does not install, and fails without it). A
build with the patch says so (`window.BookClubNative.maxRate = 3`, injected.ts); one without (every
build before this) is assumed to stop at 2×: the page never asks it for more, the sheet offers
nothing faster there, and a book whose speed is 2.5× says it plays at 2.0× in that version of the
app, with 2.5× kept for everywhere else. Now Playing needs nothing: expo-audio refreshes it on every
status tick with AVPlayer's actual rate (`MediaController.applyPlaybackInfo`), and the web's Media
Session position state uses the element's actual rate, never the speed shown.

**The speed from before.** The device-wide speed in local storage (`bookclub:playback-rate`)
becomes the speed of the first book opened without one of its own, sent to the server, then
deleted: someone half-way through a book at 1.5× is not put back to 1.0× by the update.

**Rejected.** *A per-viewer field on `BookDetail`*: a book's detail is the club's, refetched by
every member on `book:changed` and returned to whoever set the next stop; a field only one person
may see does not belong in it. *A `playback_rate` column on `users`*: D173's reasoning holds (one
optional preference beside a table of unrelated columns), and an absent row reads as 1.0×
without a backfill. *Waiting for the server before playing at a newly chosen speed*: speed is felt
at once or it feels broken; the copy on the device makes the choice instant and offline-proof.
*Capping the range at 2× everywhere, to match the iOS player*: a regression for every browser
listener, for a limit that was one constant in a dependency. *Pushing a speed change live to the
person's other devices*: the next time a book opens is soon enough, and a speed that changes under
someone listening on another device would be a surprise, not a feature. *Snapping a party's nudged
rate to a step*: a nudge is a few percent; snapping it to 0.05 would turn a gentle catch-up into an
audible jump.

**Consequences.** A server deploy alone brings all of it to the web and to the iOS app already
installed, which plays every speed from 0.5× to 2.0× in 0.05 steps, pitch-corrected, and says so
above 2×. A new app build adds speeds above 2× in the app, the explicit high-quality pitch
correction, and the speed carried to each new track by native itself. The patch is unverified on a
device: if AVPlayer refused a rate past 2 for some track, the page would show the rate native reports
(`ratechange`), not the one asked for. A per-book speed survives the book being removed and restored
(`undelete`); it goes when the book is purged.
## D191. Your own reading and listening history: sittings kept by the server, shown only to you

**Decision.** The server keeps each member's **sittings** (`reading_sessions`, migration 019):
one row per stretch of reading or listening, on one device, in one edition, with when it began
and ended, the time spent, where it began and the furthest it went (as locators, in the edition's
own measure and on the timeline) and, for an EPUB, the page numbers the device showed. The History
page (`/books/:id/history`, and `/history` across books, from the book page and Settings) lists
them by day, newest first, with each day's totals and the whole list's: "Read pages 100–146 ·
1:30 PM · 1 hr · iPhone", "Listened 2:14:00–2:58:50 (ch. 7–8) · 8:00 AM · 48 min · iPhone app".
A line opens the book where that stretch began, in its own format and edition, as a look (D58):
your place stays where it is, with "Back" to it, until you read or listen on there; a second
button opens the book's other format at the same place on the timeline. A line, or a whole book's
history, can be forgotten.

- **Recorded from what is already sent.** Every progress report (`PUT /progress`, and the beacon)
  carries the stretches read or heard since the last; `services/history.ts` adds each to the
  sitting it continues, else starts one. A look reports no stretches, so a look is never history;
  "I've read up to here" is not a sitting. Spans gain three optional fields: `at` (when it was
  read), `since` (when a stretch of listening began) and `pages` (the EPUB pages shown). An older
  client sends none; the report's own time stands in.
- **Coalescing.** A stretch continues a sitting of the same edition and device that ended less than
  ten minutes before it, starting near where that one had got to (90 s of audio, two PDF pages,
  4,000 characters: a skip or a page flipped back continues it; a chapter chosen from the contents
  starts another). Each sitting keeps the intervals of time it was read or heard in, and the time
  spent is worked out from their union: for listening, the time heard (pieces within two seconds
  join, as D65); for reading, the time between one page shown and the next, a page left open longer
  than five minutes counting five. So reports that arrive late or out of order (kept offline, D20)
  add up the same, and are joined once more as history is read back.
- **Noise.** A sitting is shown once it holds twenty seconds of reading or listening, or (reading)
  three or more pages turned through; shorter ones are kept, and show if more joins them.
- **Pages.** An EPUB's pages are the device's own (D9), so the reader sends the book-wide page it
  shows with each page; a sitting's numbers come only from the stretches at its ends (never a later
  page in place of an earlier one the device had not counted yet), except that a first page opened
  before the pages were counted is worked out from the next one, which reads straight on from it. A
  PDF's pages are its own. Where the device said nothing, a line says the chapters and how far
  through ("Read ch. 3–4 · 12–19%").
- **The device** is a coarse name from the request's own `User-Agent` ("iPhone", "iPhone app",
  "Mac"), nothing that identifies the device.
- **Privacy and spoilers.** Only ever your own: every route answers for the person signed in, a
  line of anyone else's is "not found", and the lists only cover books you can still open (a club
  you left, a book removed, D179, takes its history out of sight with it; the rows go if you or the
  book are deleted for good). Nothing in your history is somewhere you have not been, so it can
  spoil nothing; nobody else's position, reading or history is shown on it.

**Rejected.** *Raw reports kept and grouped only when read*: a listener's report every five seconds
is 720 rows an hour per person. *Sittings timed by the client alone* (the reader sends "I read this
page for 70 s"): a page's report has to go as it is shown (it opens notes, D72), and its reading
time is only known at the next one; the server sees both. *Page numbers worked out when the
history is shown*: a page's number depends on the device's layout, which the History page does not
have; the reader that showed it does. *Tapping a line to go where the stretch ended*: "pages
100–146" read again starts at 100; where you stopped is already your place. *Showing friends' history*:
the club already sees where each is (the bar, presence); when and how long is nobody else's.
## D180. Over-the-air updates: EAS Update, a fingerprint runtime version, one channel per build kind

**Decision.** `apps/mobile` uses EAS Update (`expo-updates` ~58.0.20, the SDK 58 version) to ship
its own JavaScript to installed builds. The EAS project is `@<owner>/book-club`, written into
`app.config.ts` (`KNOWN_EAS_PROJECT_ID` and `owner`; not secret), with `EAS_PROJECT_ID` able to
point a build at another one.
A build checks once per cold start (`checkAutomatically: 'ON_LOAD'`) and never holds the launch
for the network (`fallbackToCacheTimeout: 0`): a new update runs from the next cold start. Three
channels, `development`, `preview`, `production`, each with the `eas.json` build profile of the
same name (and the EAS environment of the same name, which `eas update` requires from SDK 55 on);
`appVersionSource` is `local`, so `version` and `ios.buildNumber` stay in `app.config.ts`, where
the existing archive path already reads them. Because builds are still made with `expo prebuild` +
`xcodebuild` (D130), not `eas build`, the channel also goes into the binary as the
`expo-channel-name` request header (`BOOKCLUB_UPDATE_CHANNEL`, defaulting to `production` for a
TestFlight archive, `development` otherwise). `scripts/publish-update.sh` (`pnpm --filter
@bookclub/mobile update:<channel>`) publishes, iOS only.

The runtime version uses the **fingerprint** policy, with `apps/mobile/fingerprint.config.js`
deciding what it hashes. The fingerprint is computed three times on three machines: by `expo
prebuild`; again by the expo-updates build phase in Xcode during `xcodebuild archive` (Expo.plist
holds only the sentinel `file:fingerprint`; the hash lands in the app's
`EXUpdates.bundle/fingerprint`); and by `eas update` wherever it runs. Each evaluates
`app.config.ts` with its own environment, and this config reads six environment variables.
Measured with the real resolver before the config file existed, every one of them moved the hash,
including the four that change no native code an update runs against: the project id, the
channel header, the signing plugin's props (set only for the archive), and `extra`. The config
leaves those out (the built-in source skips for the EAS project and `extra`, plus a
`fileHookTransform` dropping the `updates` section and the signing props), keeps the "balanced"
preset's skips (versions, eas.json, autolinking paths, which differ between a pnpm and an npm
install), and drops package.json scripts. What is left is what really makes two builds different:
every native module and version, every config plugin and its props, including the APNs
environment (an entitlement) and the app-bound domains (Info.plist). So a TestFlight archive (with
its signing variables) and `update:production` (without them) get the same runtime version, and a
simulator build pointed at a dev server gets another. `test/app-config.test.ts` pins both halves
with the real resolver, in the gate (`scripts/test-ci.sh` now runs `apps/mobile`).

**Context.** Cole asked for JavaScript changes to reach installed apps without a new TestFlight
build. Most of the app is `apps/web` in a WebView and already updates with every server deploy
(D130); what an update adds is the native shell's own JavaScript (the audio and auth engines, the
WebView glue, push routing), which until now changed only with a new build and App Review.

**Rejected.** *The `appVersion` policy* (runtime version = `version`): no environment can move it,
but nothing stops it from lying. A native change shipped without a `version` bump hands old
binaries JavaScript that calls native code they do not have, and they crash on launch. With the
fingerprint, the same mistake means the update never reaches them and they keep running what they
have. The fingerprint's cost, a build and a publish having to agree on six variables, is what the
config file and its test take away. *Plain fingerprint, no config file*: the archive's signing
variables alone gave it a runtime version no publish would ever match, so production would
silently never get an update. *`eas build` for the builds*: unchanged from D130. The local archive
path, its manual signing (D137 addendum) and its certificates stay as they are; `eas.json`'s build
profiles exist so that `eas build` gives the same channel and environment if it is ever used, and
signing for it would be its own decision. *Expo's push service*: still not used (D134); the
account now exists, but D134's other reasons stand.

**Consequences.** One native build is needed to ship `expo-updates` itself. After that, a change
to JavaScript alone ships with `update:production`, and a native change (a module, a plugin, an
Info.plist or entitlement setting, the icon) needs a build, which the runtime version enforces by
itself. `prebuild.sh` prints the channel a build gets and warns when a TestFlight prebuild would
have updates off. `archive.sh` passes `BOOKCLUB_UPDATE_CHANNEL` and `EAS_PROJECT_ID` through to the
user session with the rest, and takes `BOOKCLUB_APS_ENVIRONMENT` from the `aps-environment` that
prebuild wrote into the entitlements rather than from its own shell (stopping unless it is
`production`): an archive run without the variable would otherwise hash as a development build,
and no production update would ever reach it. `scripts/runtime-version.sh` prints what a build made now would have,
to compare with a build's own when an update does not arrive. Publishing needs an Expo login
(`eas login`, or `EXPO_TOKEN`). No update has been
published and no build made with `expo-updates` yet.

## D183. Threads with Cal; the spoiler scope is chosen only in his settings

**Decision.** Cole: start a new chat with Cal and keep every earlier one, as separate threads.
Nothing new was needed underneath: `cal_conversations` (migration 012) always allowed any number
of conversations per person per club, private to their owner (D166), so there is no migration.
What changed is how the panel uses them. Its header now carries, beside the gear and Close, "Your
chats" (a clock turning back, `Icon name="history"`) and "New chat" (a pencil on a page,
`compose`). "Your chats" shows the thread list *in place of* the chat, not beside it, so that it
fits a phone's sheet (the iOS app is this web app in a WebView) as well as a computer's dialog.
Each row has the thread's title, when it was last used (`formatWhen`), and the book it was begun
from, if any. Rows run most recent first. Tapping a row opens that thread with its whole history;
a bin icon deletes it after the app's own confirmation. The chat shows which thread it is in a
muted line under the header ("New chat" until a new one has its title). A new chat is only a draft
until its first question, typed or spoken: the thread is created then, with the book the panel
was opened from, so the list never fills with empty threads. `GET
/api/clubs/:clubId/cal/conversations` also leaves out any thread with no messages, which hides the
empty ones the panel used to create eagerly. A thread is titled by its first question
(`threadTitle`: whitespace folded, cut at a word boundary within 60 characters, with an
ellipsis), and a voice turn now titles a thread the same way. Opening the panel carries on where it
makes sense: in the latest thread about the book it was opened from, or the latest of all when
opened from anywhere else, and in a new chat when there is none. The list's entries now also carry
`bookTitle` and `createdAt`. Creating a thread for a book of *another* club the asker is also in
is refused (404), because Cal would otherwise give that club's context line in this club's thread.
While a reply is still on its way, typed or spoken, switching threads, starting a new chat and
deleting are all off, so a reply always lands in the thread it was asked in. A voice turn counts
from the moment the mic is asked for until Cal's reply has been sent in full (`useCalVoice`'s
`busy`), including the wait between releasing the button and his first word. Its transcript shows
only in the thread it was spoken in. A send and a mic tap at the same moment in a new chat (or two
quick taps) share the one thread being created, rather than making two.

The per-question checkbox, "Ask about the whole series (spoilers allowed for this question)", is
gone from the chat. It contradicted D176 ("Cal's panel is chat only again"). The spoiler scope now
lives in one place, Cal's settings (the gear): "Only what I've read" or "Whole series". The copy
there says the choice holds for every question, typed or spoken, in every chat, until it is
changed there. The panel's empty-chat hint no longer says "unless you ask about the whole series
below". It says Cal won't spoil past your place, and that his settings are where to let him use
the whole series. When that is on, the hint says so instead. **The per-question override is not
kept, not even in settings:** a "just for the next question" switch inside a settings dialog is
easy to forget is on, and one that turns itself off is easy to forget to turn on. The standing
choice is two taps away and just as easy to undo, and the hint always says which scope is in force.
So the server takes the scope only from the standing setting. `POST
/api/cal/conversations/:id/messages` no longer reads a `wholeSeries` field (zod drops one an older
client still sends; it is not obeyed). The voice socket's `{type:"wholeSeries"}` control message
is gone too, and each voice turn reads the setting as it is at that turn. Every message still
records the scope it was answered under (`cal_messages.whole_series`), exactly as before. The
system prompt and `search_library`'s description no longer tell Claude about a per-question
choice. Migration 012's comment, which describes that choice, is left as the record of what it
was when written; this entry supersedes it.

**Consequences.** Ships with a server deploy alone: the web app is served by the server, and the
iOS app shows that web app, with no native change (nothing under `apps/mobile` changed). A client
still holding the old bundle keeps working against the new server. Its checkbox is simply not
obeyed: the standing setting is used, so the bundle can never lift the spoiler gate on its own.
Threads stay private: another member's list is theirs alone, and reading, writing to, renaming or
deleting someone else's thread answers 404 (`apps/server/test/cal-threads.test.ts`). Thread
titles cannot be renamed from the panel yet (the `PATCH` route exists, with no UI), and "share to
club chat" (D166) is still unbuilt.

## D184. Reading along before the text, and following that cannot get stuck

**Decision.** Two read-along faults, each with its root cause found and a regression test.

1. **"Follow in the book" did not appear during the opening credits.** The listen page's panel
   (`player/ReadAlong.tsx`) drew nothing when the current track had no aligned sentence, and the
   reader marked and followed only a sentence already begun (`sentenceIndexAt` is -1 before the
   first). A track that is all credits (a commercial audiobook's "Opening Credits" file) reads no
   sentence at all, and every LibriVox track opens with its announcement (13 s before "CHAPTER
   I." in the reference recording), so for that stretch there was no panel, no link into the
   book and no following. Now the narrator's place is a state (`reader/readalong.ts`
   `narrationAt`): **reading** a sentence; **before** the text, with the place it begins; **after**
   it (the closing credits); or **loading**. The server's read-along of a track says where its
   narration meets the text next (`lead`: its first sentence, or a later track's for a track of
   credits) and where it was left (`previous`), so even a track with no sentence knows. The panel
   is there for the whole audiobook once it reads along: before the text it says so and shows the
   sentence the text begins with, past the end it says so, and "Follow in the book" is always
   there. In the book, before the text the pages go to the page where it begins, with "Before the
   text: the narrator begins on this page", so it is already open when the narrator starts.
2. **Following got stuck.** A look stops following (it is somewhere else on purpose), and "Follow
   the narrator", or pressing Play again, set following back on without ending the look: the chip
   went away and the pages never moved again, with nothing on screen to say why. Opened at a link
   while listening (a note, your history), the reader started in a look with following on, so no
   chip showed at all. Now `resumeFollowing` ends a look in the way (unread: pages looked at while
   listening are the narrator's), and is what the chip, Play pressed again and the narrator
   reaching the page you turned to all do; opened at a link while listening, the reader stays there
   with the chip showing (and beside the look's Back and Read from here). Two smaller causes of a
   standstill are gone too: the next track's read-along is fetched while this one plays, so a track
   boundary on a train with no signal still follows on (the service worker keeps what was
   fetched); and a narrated place at its section's very end counts as on its last page, rather than
   a page to display again on every tick.

**Rejected.** *Showing the first sentence as current during the credits* (what the panel did when
it showed anything): it says the narrator is reading what they are not. *Hiding the reader's
pages during the credits*: a reader may want the page anyway, and it is where the narrator will
start. *Following again by itself whenever the narrator's page and yours differ*: turning back a
page to reread would be undone at once; it follows again only once the narrator comes to the page
you are on. *Keeping the previous track's read-along while the next loads*: its times are another
track's, so it would mark the wrong sentence.

## D181. Inside the iOS app native may go on by itself while the page sleeps; the page follows

**Decision.** The web half of a contract with the iOS app's player (D131): the page tells native,
through the bridge, what it may do without the page.

- `{type: 'queue', queue}` (`player/useNativeQueue.ts`), whenever the book, the edition, a party
  or the sleep-at-track-end choice changes: the book and edition ids, every track's absolute URL
  and lock-screen title, and `advance`, whether native may start the next track when one ends (not
  in a party, whose shared clock moves everyone, D155; not when sleeping at this track's end).
  `null` once the player stops.
- `{type: 'sleep', at}`: when the sleep timer ends, for native to pause then itself.
- From native, `{type: 'advanced', url}`, sent just before the finished track's `ended`: the
  bridge's element takes that URL as its `src` with nothing loaded, and `AudioProvider`'s `ended`
  handler, finding the element already on the next track, follows it there (its place from
  native's own reports) instead of loading it again from its start.

**Context.** With the phone locked, iOS suspends a WebView's scripts while native audio plays on
(WebKit keeps a web process running in the background only for media it plays itself). Every
decision the page made at a track's end (load the next one), at the sleep timer's end (pause) and
every five seconds (save the place) then waited for the app to be opened again: playback stopped
at the end of the track, a 30-minute sleep timer did not stop it, and the place saved stayed where
the phone was locked.

**Compatibility.** Commands an older build does not know fall through its `default` and are
ignored; an older build never sends `advanced`, so the page loads the next track itself, as
before. This half ships with the server; the native half (D182) needs a new build of the app.

**Rejected.** *A playlist owned by native* (expo-audio's `AudioPlaylist`): two sources of truth for
which track is playing, and the page's looks, catch-up (D70), chapter-end moments and party sync
all assume the page decides. *Keeping the WebView awake* (a silent audio element in the page): it
fights the native player for the audio session and is exactly the kind of trick iOS revokes.

## D186. One place in the book, whichever format: the newest wins, on this device too

**Decision.** Where you are in a book is one place, however you got there (D20, D70): the newest
of what was read or heard, here or on another device, online or kept offline. Three rules make it
hold on one phone too, where it did not:

- **The paused player catches up** (`lib/two-formats.ts` `catchUpTo`, `ListenPage.tsx`). The
  audiobook stays in the player while you read; opened again, the player went where you stopped
  *listening*, because D70's catch-up skips places saved on this device (they are not news). Now,
  paused and not in a look or a party, it goes to the newest place when that is in another format
  ("Picking up where you stopped reading: Chapter 3 · 41%"), once per visit to the player.
- **Play in a reader reads on from your page** (`playFrom`, `reader/useReaderAudio.ts`, the
  footer player). Pressing Play in the book's footer resumed the audiobook where it had stopped,
  however far you had read since. Now it resumes only when the narrator is on this page or the
  next (reading along, a glance back, a pause); anywhere else it starts at the page you are
  reading. The footer also skips back 15 s ("what did they say?") without leaving the page.
- **The switch lands on something you recognise.** Opened in another format than the one you were
  last in, the book marks the passage it opened at for a few seconds, in gold, and says "Where you
  stopped listening: Chapter 3 · 41%" (the PDF names the page); the player says "Picking up where
  you stopped reading". Where the audiobook is lined up sentence by sentence (D46) the place is the
  sentence; by chapters, it is the chapter's share of the way through.

**Offline.** Nothing new is needed and nothing is lost: reading and listening kept offline wait in
the outbox and go on reconnecting (D20, last writer wins by the device's clock, read spans
unioned); the place each format opens at is the newest of the server's and this device's (D24),
so the switch works with no signal; and the newer place another device saved meanwhile reaches
an open page as D70's "You read on to … on another device".

**Rejected.** *The player always opening at the newest place, playing or not*: a listener who
glances at the book mid-chapter would lose the narrator's place. *Play in the book always starting
at the page*: reading along, a pause, or a page turned back to check a name would jump the
narrator about. *A modal "Continue from Chapter 3 or Chapter 1?"* on every switch: the newest place
is right far more often than not, and Back (a look) or the toast's word make the other cheap.

## D187. The book page's ways in: continue, the other format from here, or read along

*Read along's "Press Play below" is superseded by D194: the tap on Read along starts the audiobook.*

**Decision.** The book page offers each format as before, but says what each does
(`formatActions`): the one you were last in continues ("Continue listening", the primary button),
each other one opens at the same place and says so ("Read from Chapter 3", "Read the PDF from
Chapter 3"); before anything is read, each says its own word ("Read", "Listen"). When the
audiobook is lined up with the EPUB (D46), **Read along** opens the book at your place with the
audiobook loaded there, paused, and "Press Play below to read along from this page": a browser
plays only on a tap, and the footer's Play is that tap. Choosing is the whole of the mode: reading
is the book, listening is the player (with its reading-along panel), both is reading along; the
mini player and the footer player keep the other one tap away.

**Rejected.** *A per-book "mode" setting* (read / listen / both): the last format used already says
it, and a setting would go stale the first time the car is started. *Starting the audio on Read
along without a tap*: iOS refuses `play()` outside a gesture, and a page that sometimes starts
talking and sometimes does not is worse than one tap. *Hiding the formats you were not in*: on a
phone, the other format is the whole point of switching.

## D190. The lock screen: one player for the app's life, a scrubber told on every event, square artwork, chapters for tracks

**Decision.** The Media Session (lock screen, Control Center, headphones, a watch, a car) moves
out of `AudioProvider` into `player/useMediaSession.ts`, with its rules pure and unit-tested in
`player/now-playing.ts`:

- **One element.** The one `<audio>` element stays for the app's life (D19); a track or chapter
  change sets its `src` from the `ended` handler, never a new element. Handlers are registered once
  and read live state, so a new source, a new chapter or a look never drops them.
- **The scrubber from the element, on every event that moves it.** `setPositionState` is called
  with the element's exact `currentTime`, `duration` and `playbackRate` on `loadedmetadata`,
  `durationchange`, `play`, `playing`, `pause`, `waiting`, `seeked`, `ratechange`, `ended` and
  `emptied`, and every ten seconds of playback besides; the system extrapolates between them. It
  is cleared (with the metadata, and the playback state set to `none`) once the player stops. A
  drag on the lock screen (`seekto` with `fastSeek`) uses the element's `fastSeek`.
- **Square artwork in five sizes.** `GET /media/books/:id/cover?shape=square&w=96|192|256|384|512`
  draws the whole cover on a blurred, darkened copy of itself (as a squarer cover is drawn into
  the 2:3 frame), from the 640 px thumbnail, real or generated; cached beside it under the same
  version. The metadata offers every size; the native bridge sends them largest first.
- **Previous and next are chapters, not files** (`chapterStops`, `chapterStep`): the player's own
  list (a track per chapter, the chapters inside a track that holds several, a single-file M4B's
  own chapters). Previous restarts the chapter once it has played three seconds, as Apple's Books
  does, else goes to the one before. The player's own buttons ("Previous chapter", "Next
  chapter") follow the same rule, so a single-file audiobook's chapters are reachable at last
  (they were "next track" over one track: always disabled).
- **The lines.** Title: the chapter playing (FR152), or the track's tidy name, or the book's;
  artist: the author; album: the book.

**What iOS allows a web page (Safari and the Home Screen app), from WebKit's source and Apple's
documentation; none of it seen on a physical iPhone from the build box:**

1. *Skips or track buttons, never both* (D64). iOS shows track buttons in the skips' place whenever
   a page registers both; on an iPhone or iPad the page registers only the skips, and chapters change
   in the app.
2. *Both skips are 15 seconds.* WebKit tells the system a skip interval of 15 s for both directions
   (`RemoteCommandListenerCocoa.mm`, `kMRMediaRemoteOptionSkipInterval : @[@(15.0)]`) and passes
   that interval as `seekOffset`. The handler honours `seekOffset`, so the lock screen's "15" glyph
   says what it does; the player's own forward button stays 30 s. (The iOS app sets 15 and 30 itself.)
3. *Seeking needs media that can seek.* WebKit leaves the seeking commands (scrubbing, the skips)
   out of what it offers the system while the media cannot seek: until a track's metadata loads,
   the lock screen may show play and pause only.
4. *Background playback goes on through track changes only from the `ended` handler of the same,
   already playing element* (D19): a new element, or `play()` from a timer, is refused without a
   tap while the phone is locked. This is why the element is never replaced.
5. *A Home Screen app killed by iOS in the background* (memory pressure, a long pause) loses its
   lock-screen entry; it comes back at the saved place on the next open, which was saved at the
   last pause, or within five seconds of playing (D19), or by the beacon as it was hidden.
6. *Headphone double-tap* (AirPods "next track") reaches a page as `nexttrack` only where that
   handler is registered (WebKit offers the system only the commands the page handles): on an
   iPhone, where it is not, the page does not hear it.

**Rejected.** *The scrubber per chapter rather than per file* (as Apple's Books for an M4B): WebKit
takes the session's duration from the position state but its seeking from the element, and a
chapter-scoped bar would need the two to agree on a translation iOS does not document; the bar is
the file playing, the title the chapter. *Setting the position once a second from React state*
(as before): it was rounded down to the second, lagged a render behind a seek, and was not told
again after a speed change within the same second. *2:3 artwork* (as before, 160-640 px): the
system cuts or boxes it into its square tile, and the iOS app showed the smallest of the three.
*New `prev-chapter` test ids*: the existing ones keep every test that walks a folder of tracks (one
chapter each) unchanged.

## D194. Read, Listen, Both: one switch in the reader and the player, and the place kept across it

**Decision.** Where D187 made the book page the place to choose a format, the choice now goes with
you: a **Read · Listen · Both** switch (`player/FormatSwitch.tsx`) sits in the reader's footer and
at the top of the player, and switching never leaves the book or loses the place. The three states
are not a setting (D187 rejected one); each is what is open, read from the shared player:

| State | What is on screen | How you are in it |
| --- | --- | --- |
| **Read** | the book, its footer as before (page arrows, page numbers) with the switch | a reader open and this book's audiobook not in the player |
| **Listen** | the player page | the player open |
| **Both** | the book with the player docked in its footer (below) | a reader open and this book's audiobook in the player, playing or paused |

Transitions, each from one tap, each keeping your place to what the formats can say (D186: a
sentence where the audiobook is lined up sentence by sentence, else the chapter's share):

- **Read → Both**: the audiobook starts at the page you are reading (D186's `playFrom`: or where it
  already is, if the narrator is on this page or the next), in that tap. The dock rises in.
- **Both → Read**: the audiobook stops (its place saved first) and the dock goes; the page stays.
- **Read or Both → Listen**: the player opens and plays. From Read it starts at your page, so you
  hear the sentence you were reading. From Both it plays on, unbroken.
- **Listen → Both**: the book opens where the narrator is and follows them, playing (started in the
  tap if it was paused).
- **Listen → Read**: the audiobook stops (saved) and the book opens where you stopped listening,
  marked as D186 marks it.

**Both, the docked player.** The footer in Both is a player of its own, `player/ReaderDock.tsx`:
the scrubber across its top with the time heard and the time left in the track; the switch, the
page numbers and an expand button; then the page arrows at the ends, 15 s back, Play, 30 s on and
the speed. On a computer it is one row. Expanding opens **Now in this book** over the page (a sheet,
the page and the narrator going on beneath it): the cover, the chapter, the scrubber with how far
through the book, previous and next track, the skips, Play, the speed and the sleep timer, and
the reading-along lines where the audiobook has them. "Read only" and "Listen only" there, and the
switch itself, are the way back to one format. The speed is a slot (`player/SpeedSlot.tsx`) showing the
player's own choices; the custom-speed work replaces what is inside it, not where it sits.

**Starting on its own (supersedes D187's "Press Play below").** A browser plays sound only from a
tap, and iOS lets an element play later without one only once a tap has played it. So the tap
that enters reading along plays the audiobook: Read along on the book page, Both in the reader,
Both or Listen in the player. Each loads the audiobook at the place and calls `play()` in its click
handler (`AudioController.load(…, { play: true })`). The track's new source starts with that call,
not after its metadata arrives, which comes after the tap is over. Where that cannot be (the address
opened cold, a browser that still refuses), the player says so (`AudioState.blocked`) and the book
shows one large Play button over the page, "Read along from here", not a hint chip; its tap
plays.

**Found on the way.** Three faults the dock brought out, each fixed at its cause. *A look could be
undone by the narrator*: turning to the narrator's next page while a look (the contents, a note)
was still loading landed after it, and the look ended there, back with the narrator. The follow
effect runs on nearly every render, so this was a race with any page boundary. It was already there
(the D184 test failed 2 runs in 8 before this change), and a phone's smaller pages above the dock
made it likelier. Now a look asked for holds the narrator's page turns until it is on screen
(`lookTo`). *A toast on a computer during a look* went to the foot only when the page arrows were all
there was to tap there; it now goes wherever the foot's middle is free (`toast-place.ts`), with the
switch beside the first arrow, and never where the audiobook's controls are. *The player page could
be scrolled* by its own track list (`scrollIntoView` scrolls every ancestor that can be, and
`overflow: hidden` can be), taking its header and club bar off the top: it is `overflow: clip` now.

**Rejected.** *A switch in the reader's header*: a phone's header has no room for three more
labels beside its six buttons, and the chips of a look (D91) already take its middle. *The dock
over the page's last lines*: reading along must never hide the text being read; the page is laid out
again around the dock (once, when it comes or goes; your place stays, as after a font change).
*Keeping D187's tap on Play below*: two taps where one says what you want, and a page that says
"press Play" when you have just pressed Read along. *Autoplay muted, then unmuted*: iOS counts the
unmuting as the start that needs a tap.

## D182. The iOS app's player: Now Playing for real, and playing on while the page sleeps

**Decision.** The native half of D181, in `apps/mobile/src/audio` (JavaScript only: no new native
module, no config plugin, no Info.plist change):

- **A session that does not mix** (`AUDIO_MODE`, superseding D132's `mixWithOthers`). iOS makes an
  app the Now Playing app (the lock screen's and Control Center's player, the one headphones, a
  watch and a car talk to) only if its audio session is not mixable; expo-audio says so of its own
  `setActiveForLockScreen`. Under `mixWithOthers` the app's lock-screen controls and artwork, though
  set, were never the ones iOS showed. Mixing is between *apps*: the WebView's voice channel, voice
  notes and Cal still play in this app's one session alongside the book. Starting the book now
  pauses another app's music or podcast, as Apple's Books does.
- **Each new player gets the speed chosen.** The page set the speed on each track's
  `loadedmetadata`; asleep, it cannot, so a track native moved on to would have played at 1×.
- **The page's queue** (D181): when a track ends and the queue says `advance`, native tells the
  page (`advanced`), sends the finished track's `ended`, then loads and plays the next with its
  lock-screen title, all from its own status callback. Not in a party, nor when sleeping at the
  track's end, nor past the last track.
- **The sleep timer** pauses native's player at the time the page sent.
- **The place, saved while the app is in the background** (`BackgroundProgress.ts`): every 30
  seconds of playing, at a pause and at a track's end, `PUT /api/books/:id/progress` with the place
  and the stretches heard since the last save, the page's own shapes, through the same shared cookie
  store as the page (D133); a place that is not where listening would have taken it (a skip, a
  scrub) ends the stretch before it, so a skip is never heard; a save asked for while another is on
  its way follows it, never dropped; stretches kept for the next try while offline. Nothing is saved
  while the app is open: the page does that.
- `apps/mobile` gains a `test` script and its tests join `scripts/test-ci.sh`; they were not run by
  anything before.

**Ships via.** OTA-capable JavaScript, but `apps/mobile` has no `expo-updates`, so today only a new
build of the app delivers it. The page's half (D181) ships with the server and is harmless to an
older build.

**Verified.** Unit tests against mocked Expo modules (the shapes of expo-audio 58.0.10, read from
its source: `MediaController.swift` enables the skips at the intervals given and reads artwork from
`artworkUrl` through `URLSession.shared`, the shared cookie store). Not run in the simulator or on a
device yet (D139: Xcode work happens on the Mac EC2, and the development machine's disk was kept
free of it).

**Rejected.** *`doNotMixPersistent`*: other apps would not resume after the book pauses; that is
for apps that own the audio for good. *`duckOthers`*: lowers another app instead of pausing it,
which is not what an audiobook does. *The native player owning the playlist* (`AudioPlaylist`):
see D181. *Saving from native while the app is open too*: two writers of the same place for no
gain; the page's saves are already every five seconds.

## D188. Widgets and a Live Activity for the iOS app: the page says what to show, native shows it

**Decision.** The iOS app gets Home Screen and Lock Screen widgets (your current book: cover,
title, how far, the chapter; your club's next stop and how much is left to it) and an optional
Live Activity for the audiobook playing (D189 builds them). This half is the page's and the
server's, and ships with the server:

- `GET /api/widget` (`services/widget.ts`): your own places in the books you can still open,
  newest first (the current one and up to three more), each with its format, whether you finished
  it, and its club's next stop (D53) with how much of the book is left to it. Never anyone else's
  reading; `private, no-store`.
- Inside the app (`lib/native-widgets.ts`, on every signed-in page) the page sends native
  `{type: 'widgets', snapshot, covers}` as it opens, when it comes back to the foreground and
  after your place reaches the server, at most once a minute; `covers` are the books' square
  artwork (D190), which native fetches with the session it shares with the page (D133) and keeps
  for the widgets, which have none.
- **The Live Activity is off until you turn it on** (Settings, "Live Activity", only in the app):
  the Lock Screen's Now Playing (D182) already has the controls, and a second panel of the same
  audiobook under it is clutter for most. The choice is kept on the device and sent as
  `{type: 'live-activity', enabled}`. iOS's own switch (Settings, Book Club, Live Activities)
  turns it off whatever this says.

**Why the page and not native.** Native has no idea what a club, a stop or a chapter label is,
and the widgets must show what the app shows; the page has all of it and the server one query
for it. An app build without widgets ignores both messages.

**Rejected.** *Widgets fetching from the server themselves*: a widget extension has no session
(cookies are the app's, D133) and runs on Apple's schedule; a token for it would be a second
credential to keep, revoke and leak. *The Live Activity on by default*: see above. *Friends'
places on the widget*: it would put the club's progress on a Lock Screen anyone can see.

## D189. The iOS widgets and Live Activity: one WidgetKit extension, a small local module, no new service

**Decision.** A WidgetKit extension (`apps/mobile/targets/widgets`, `com.example.bookclub.widgets`,
iOS 17+), made at prebuild by `@bacons/apple-targets` (5.0, Evan Bacon's config plugin for Apple
targets, maintained, the Expo-recommended way), holds:

- **Your book** (`CurrentBookWidget`): Home Screen small and medium (cover, title, how far, the
  chapter, the club's next stop), Lock Screen circular (a gauge of the percentage), rectangular
  (title, chapter, a bar) and inline ("Alice · 46%"). A tap opens the book page.
- **The next stop** (`NextStopWidget`): Home Screen small and Lock Screen rectangular: where the club
  talks next, by when, how much is left to it.
- **The audiobook as a Live Activity** (`NowPlayingLiveActivity`), on when turned on (D188): the Lock
  Screen and the Dynamic Island show the book's cover, title and chapter, the chapter's progress and
  Play/Pause. The system draws elapsed time from the file's start and end at the speed playing
  (`ProgressView(timerInterval:)`), so the app updates it only when a viewer would see a change (play,
  pause, a seek, a new chapter, the speed: `LiveActivityDriver`), well inside ActivityKit's budget,
  and it works while the page sleeps (the native engine drives it, D182). Play/Pause is an App
  Intent (`TogglePlaybackIntent`, `targets/widgets/_shared`, so it is in the app too) that runs in
  the app's process and has the player toggle.

The app's side is a **local Expo module** (`apps/mobile/modules/book-club-native`, autolinked): it
keeps the page's snapshot (D188) and the books' covers in the App Group `group.com.example.bookclub`
(fetched with the app's session, D133; the widgets have none) and reloads the widgets; starts,
updates and ends the Live Activity; and relays Play/Pause. Its ActivityKit and App Group code is
plain Swift (`NowPlayingController.swift`), typechecked against the iOS SDK without a build. The
activity's attributes are defined twice, in the module and in the extension, byte for byte (a test
compares the files): ActivityKit pairs the app's activity with the extension's view by the type's
name and shape, and a pod cannot see the main target's types. A widget's tap opens
`bookclub:///books/<id>`, which the app sends to the page's router (`src/widgets/appLink.ts`;
nothing else on that scheme is followed). Signing out (the page sends a snapshot of nobody) clears
the widgets.

**Ships via.** Needs a new native build (a new target, a native module, entitlements, Info.plist).
The page's half (D188) ships with the server.

**Verified.** Unit tests (the driver, the messages, the links, the config, the twin files); the
extension's Swift and the module's controller typechecked with `swiftc -typecheck` against the
iOS 27.2 SDK (iOS 17 and 15.1 targets). Not built, signed, or run in a simulator or on a device:
Xcode builds happen on the Mac EC2 (D139), and this Mac's disk was kept free of them. What is left
is manual work in Apple's console (the App Group, the extension's own App ID, both App Store
profiles; apps/mobile/README.md), then a real build, and a check of the widgets and the Live
Activity on a device.

**Rejected.** *A Capacitor or second wrapper*: the app is already a native shell (D130).
*`expo-widgets` / React Native views in widgets*: widgets are SwiftUI, archived by the system;
JavaScript does not run there. *A third-party Live Activity module* (`expo-live-activity`): one
fixed layout and its own attributes type; ours is ten lines of Swift. *Updating the Live Activity
every second*: ActivityKit throttles it, and the timer view needs none. *Push-updated Live
Activities* (APNs `liveactivity` pushes from the server): only needed when the app is not running,
and a playing audiobook keeps it running; in the plan for later.

## D196. Your place, kept: the narrator's word saved as heard, on the device first, never a stale copy over it

*Refines D20 (last writer wins), D70 (another device moved on), D182 (native saves while the page
sleeps) and D186 (one place, whichever format).*

**What went wrong (the close-and-reopen bug).** Read along a while, stop, close the app, open it
again: the book, then the player, opened back where reading along began, often a chapter's first
page. Reproduced in both browser projects against the real stack (`e2e/tests/place-kept.spec.ts`,
3 of 3 failing on master). The cause was in the reader, not the player: while the pages followed
the narrator, the reader's own place (`EpubReader` `place`) never moved (a follow turn was
deliberately not a place), and a page laid out again in the same chapter reported that place as
yours. Read (which takes the dock away), the phone turned, or the app back from the background
(its viewport resized) are all relayouts. The report was stamped with the moment its debounced
save went out, so the stale place was the newest of all, on the server and on the device (D20,
last writer wins by the device's clock), and every later open went there. On the way, three more
faults could lose a place:

- A place in its own edition was sent through the timeline and back (`translatePlace`). On a
  stretch the text does not have (LibriVox's opening announcement, a track's closing words: flat
  in the audiobook's map), that lands at the stretch's start: Read along from the book page, 8 s
  into chapter I, started it again at 0:00.
- Inside the iOS app the page's audio element is a mirror of native's player, and took native's
  every status as the time. Native sends its new track's metadata and a time update at 0:00 before
  it has made the page's seek to your place, so a track opened at 12:34 said 0:00 until the seek
  was done: what was heard counted from the chapter's start (opening notes there early), and a
  pause or the page hidden in that moment saved it. And a place reported long after native heard
  it (its statuses delivered when the page woke) was saved as new, over native's own saves.
- Native's saves in the background (D182) went to the server only. Closed without a network, or
  ended by iOS within half a minute of the last one, and the next open had only the page's older
  copy, which the next Play then saved over everything.

**Decision.** One place, one writer at a time, said with when it was so:

- **Reading along, the place is the narrator's.** The reader's place follows the word the narrator
  is reading (`offsetNow`, from the alignment) while the pages follow them. Kept there, not saved by
  the reader: the player saves the audiobook's place, to the millisecond, every five seconds and
  when it stops.
- **A place is as new as when you were there.** Every save carries the time its place became
  yours: a page turned to, then; a place the reader keeps (opened there, laid out again), when you
  came to it; a place opened from a save (`StartPosition.at`), that save's time; a place heard,
  when the player was there (`observedAt`: native's own time for each status, from builds that
  send it). Never the moment a debounced save goes out.
- **The same moment keeps what is kept.** A report of exactly the time already saved does not
  replace it (server `applyProgress`, the device's `rememberPosition`): the reader opened at the
  narrator's place reports its page with the narrator's time, and the narrator's own place stays.
- **A place in its own edition is that place,** never the timeline's way back to it.
- **The iOS bridge holds the page's seek** until native has made it (its `native-seek` answer, a
  status near the target, or 4 s at most), and a place is in the track the element plays.
- **Saved often, and on the device first.** Moving while paused (a scrub, a skip, a chapter) is
  saved once the moving stops. Going hidden or closing, the player keeps the place in localStorage
  at once (`saveProgressNow`), as the reader already did, as well as sending it. Inside the app
  with the page hidden, the page saves nothing of what it hears: native is the writer then (D182).
  Native keeps the newest place, whose it is and the stretches heard but not yet saved in a small
  file (every 2 s while playing; at once at a pause, a track's end and going to the background);
  the page loaded again asks for it (`tellKept`) and saves it as any place saved on this device.
  A WebView whose web process iOS ended is loaded again instead of staying blank.

**Reconciling on reopen** is unchanged in shape and now holds: the newest of the server's place
and this device's (the reader's and the player's, and native's kept place) wins; another
format's place is translated through the alignment, sentence by sentence where the audiobook is
lined up (D46); another device's newer place reaches an open page as D70 says.

**Rejected.** *Furthest place wins*: breaks rereading (D20). *The server's receive time*: an old
offline queue would win (D20). *Two places, one per format, chosen on reopen*: which is right is
exactly what the times answer; a second store would need the same rule. *Asking "Continue from
here or there?" on every open*: D186 rejected it; the newest is right far more often. *Native as
the writer while the app is open too*: two writers of one place, and the page's looks, parties
and catch-up assume the page decides (D181). *Native saving to the server every few seconds*: the
file covers an ended app at no network cost; the server copy stays every 30 s in the background.
*A seek tolerance of zero for native seeks*: AVFoundation's precise seek can be slow on a long
MP3 over the network, and no imprecise seek was seen; left as expo-audio's default.

**Ships via.** The web and server parts with a server deploy. The native part (`apps/mobile`, the
kept file, `at` in statuses, the reload) is JavaScript only: an EAS Update or the next build.
Each half works with the other's older version: an older page ignores `at` and `kept`; an older
build ignores `tellKept` and sends no `at` (the page then times a status by its arrival, and with
the page hidden saves nothing of it).

## D197. The book is its text: the audiobook plays over it, and can be hidden

*Supersedes D194's Read · Listen · Both switch and D187's separate Read along. Keeps D194's dock,
Now in this book and the start in the tap, and D186's places.*

**Decision.** You always see the book's text. A book with a text opens as text, whichever format
you were last in, and the audiobook is something you play over the page (reading along, the pages
following the narrator), never a mode you switch into or a page you are sent to:

- **The reader's footer** has **Listen** where the switch was: it plays the audiobook from the page
  you are reading (or on from where it is, if that is this page: D186), in that tap (D194). Playing
  or paused, the audiobook is docked under the page as before (D194), with **Stop** (×) where the
  switch was; Now in this book has the **Full player** (its track list, listening together) and
  Stop. Pausing is pausing: the dock stays.
- **The book page**: the way you were last in continues, and both open the text: "Continue
  reading", or "Continue listening", which plays over the text from your place to the millisecond
  (D196). The other text opens from the same chapter; "Listen from Chapter 4" plays over the text
  from there. The separate Read along button is gone: listening *is* reading along. A book that is
  only an audiobook opens in the player, as before.
- **The player** is the full player, a step aside: **Show the text** opens the book where the
  narrator is, the audiobook going on as it is. The mini player opens the book's text.
- **Hiding the audiobook.** A book with an audiobook you do not care about need not offer it. Your
  default is in Settings (Listening: "Hide the audiobook in books"); each book can say otherwise in
  its reading settings ("As in Settings · Show · Hide") or on its page ("Hide the audiobook in this
  book"). Hidden, the book offers no Listen, on its page or in its footer. An audiobook of that book
  playing is never hidden: its controls are how it is stopped. Kept per person on the server (so
  the choice in the iOS app holds in the browser), on the device first and sent when there is a
  connection, newest wins on the chooser's clock, as the speed is (D195).

**Rejected.** *Keeping the switch with two states* (Read, Read + listen): still a mode to be in.
*Removing the player page*: its track list and listening together (D153) have no place over the
page yet; it stays, one tap aside, and is where a book that is only an audiobook lives. *Opening
"Continue listening" in the player when you were last listening*: the text is the book; the
narrator's place opens in it. *Hiding the controls by a device setting only*: the iOS app and the
browser are two devices for the same person. *Hiding a playing audiobook's controls*: nothing would
stop it but the lock screen.

**Ships via.** A server deploy (web, server, migration 021: two additive tables). Nothing native.

## D198. One Continue, Book settings, no audio-only by default, quieter toasts, instant page counts

*Supersedes D197's multi-button book page (Continue listening / Read from / Listen from) and the
hide-audiobook checkbox on the book page. Keeps D197's text-first reader and docked audiobook,
D194's start-in-the-tap, D186's places.*

**Decision.**

- **One way in.** The book page, the home Continue banner, and each book card offer exactly one
  primary action. It is labelled **Continue** once you have a place in the book, and **Open**
  before that. It always opens the text when the book has any (the audiobook started along if you
  were last listening and have not hidden it). A book that is only an audiobook opens the player.
  There is no "Listen on", "Continue listening", "Read from…", or second format button beside it.
- **Book settings.** Formats (the edition list), "Hide the audiobook in this book", and "Add a
  format" live in a Book settings sheet on the book page (gear), not next to Continue. Your default
  for hiding the audiobook stays in Settings → Listening.
- **No audio-only screen by default.** Settings → Listening gains **Allow audio-only view**, off by
  default and kept on this device. When off, `/listen` for a book that has text redirects to the
  reader with the audiobook along, and the reader's "full player" control stays on the docked
  player. Books that are only audiobooks still use the player. When on, the full player works as in
  D197.
- **Quieter toasts.** Opening or resuming a book (reader landing, "picking up where you stopped
  reading", "listening from where you are reading") no longer toasts. Errors, pins, mark-as-read,
  and cross-device surprises stay.
- **Instant page counts.** EPUB page geometry stays keyed by edition id + layout signature in
  IndexedDB (as before). A same-visit memory cache serves `peek` synchronously so reopen paints
  "Page X of Y" immediately with no "Counting…" flash (stale-while-revalidate: recompute only when
  the key misses).

**Rejected.** *Always labelling the button Continue even before anything is begun*: "Open" is the
honest word for a first open; once there is a place, Continue. *Removing the player page entirely*:
audiobook-only books and the optional full player (track list, listening together) still need it.
*Server-stored allow-audio-only*: a device preference is enough; hiding the audiobook already syncs
via the server (D197).

**Ships via.** Web only (and the iOS WebView). No native build. No migration.

## D199. The chat's chips are channels: General and each book show only their own messages

*Refines D150 and D173. Keeps one stored stream per club, its book tag, spoiler fence and unread cursor.*

**Decision.** The chips above the chat (General, then one per book) choose what is shown, not only
what the next message is tagged with. General lists the messages tagged to no book; a book's chip
lists only that book's; what you send goes to the channel you are looking at, as before. The history
route takes `channel` (`general` or a book id) and filters in SQL, so a page of one channel is a full
page of it; without `channel` it is still the whole stream. A live message lands in the club's
stream cache and its own channel's (`lib/queries.ts`). A bubble no longer carries a book tag: every
message shown is already in the channel being viewed. The unread badge still counts the whole club.

**Context.** The chips looked like channels, but every message showed under every chip, so a
message sent under Red Rising appeared in General and in Golden Son too, and a book tag was the only
hint of where it belonged.

**Rejected.** *Filtering the loaded page in the browser*: a busy channel would push a quiet one's
messages out of the page, so a book's channel could look empty while it has messages. *Per-channel
unread counts*: one cursor per club is enough for a small club (D151); a channel badge can come later.

**Ships via.** Web only (and the iOS WebView). No native build. No migration.

## D200. Replies in chat are a messaging app's: inline, quoted, gated like what they quote

*Refines D150 and D173. Cole, 2026-11-05: "Need to support reply threading."*

**Decision.** A reply sits in the stream like any other message, with a quote of what it answers at
the top of its bubble (who wrote it and a line or two of it), the way WhatsApp, iMessage and
Telegram do it. Reply is the first action in a message's overflow menu; the composer then says
"Replying to Ana" with an excerpt and a way to stop (its close button, or Escape). Tapping a quote
goes to the message it is of: in place, with a brief glow, when it is on screen; otherwise in its
thread, opened on its own (the root and every reply under it, oldest first, the composer answering
there: its first message, or, when that one is deleted or still behind its fence for you, the newest
message there you can read). A root its thread has answered says "2 replies" under it, which opens the thread too.

- **Threads.** A reply names the message it answers (`parent_id`, since 015) and now also its
  thread's root, however deep the chain (`thread_id`, migration 022, additive, backfilled for any
  reply the API took before the UI offered one). A whole thread is one indexed query and a root's
  reply count one `GROUP BY`; nothing walks `parent_id` at read time. `GET /api/chat/:id/thread`
  takes any message of a thread and answers its root, its newest 200 replies and its channel.
- **Channels (D199).** A reply goes in the channel of the message it answers; naming another is a
  400. One cannot answer a deleted message (404) or one still behind its spoiler fence for you (400:
  you would be answering words you have not seen).
- **The quote is gated exactly as the message it quotes.** It is judged by that message's own fence
  for the person looking (`toChatQuote`, services/chat.ts, the same `Gate` as D150), never by the
  reply's: a quote can show no more than its message itself would. Hidden, it says only where it
  opens ("Spoiler up to Chapter 9"); deleted, "Message deleted". Live, a client re-quotes its
  replies from the parent's own pushed view (gated for it by the server), so an edit or a reveal
  reaches the quotes without a reload, and never more than the parent shows.
- **Deleting.** A deleted reply leaves the stream (`chat:deleted` now carries its `threadId`, so a
  client counts its root one fewer). A deleted root whose thread still has live replies stays, as a
  "Message deleted" placeholder their quotes and the thread hang from, until its last reply goes.
- **Getting there.** The stream now loads earlier messages on request ("Earlier messages"), and a
  refetch of the newest page keeps what was loaded before it (chat-core's `refreshNewest`). A
  mention in the bell links to `/clubs/:clubId/chat?message=<id>`, which opens that message's
  channel and goes to it, in place or in its thread (D201).

**Context.** Cole's request, and the brief's "a thread view or inline replies, your call, following
messaging-app convention". A club is three to ten friends; their chat is one conversation, and a
reply hidden away in a side panel is a reply most of them never see.

**Rejected.** *Slack-style threads only (replies out of the stream, under the root)*: right for a
busy workplace channel, wrong for a handful of friends, who would have to open every thread to
follow their own conversation; the thread view is here as a second way to read one, not the only
one. *Nested, indented replies*: a phone has no width for a tree. *Walking `parent_id` up at read
time instead of a root column*: a recursive query per message on every page, for one more column
that never changes. *A `chat_threads` table*: a thread has no state of its own beyond its root.
*Gating a quote by the reply's own fence*: the reply's fence says nothing about where its parent
is; a quote would then show a fenced message's words to someone who cannot read that message.
*Loading earlier pages until a quoted message turns up*: unbounded for an old quote, where the
thread view is one request.

**Consequences.** `ChatMessageView` gained `threadId`, `replyCount`, `replyTo` (a `ChatQuote`) and,
when revealed, `mentions` (D201). `apps/server/test/unit.test.ts` lists every migration by name and
number on purpose; it now lists 022. **Ships via.** A server deploy (web and the iOS WebView with
it). No native build. Migration 022.

## D201. @-mentions: the server's reading is the truth, and the composer writes only what it reads back

*Refines D152. Cole, 2026-11-05: "tagging other users".*

**Decision.** A message is stored exactly as typed (`@Ana`, `@Grant Smith`), never with hidden ids
(D152). Who a mention names is read by one function, `findMentions` in `@bookclub/chat-core`, which
the server calls to notify and to render, and the composer calls to make sure that what its
autocomplete writes reads back as the person picked (`mentionTokenFor`). The view of a message
carries the spans the server read (`mentions`: start, end, and the member's id or an agent's
handle); a bubble highlights those spans and nothing it guesses itself. A mention of you is drawn
apart (gold), and a bubble that names you carries a gold bar down its inner edge.

The reading, in order: an `@` starts a mention only at the start, after whitespace or after opening
punctuation (never inside a word, an email address, a path or an inline code span); a name may run
to several words, and the longest run that is someone's whole display name wins (`@Grant Smith`,
not `@Grant` and "Smith"); one word may be a whole display name (strongest), an agent's handle
(D204), or a first name (weakest); a name ends where its word does (`@Anaxagoras` does not name Ana,
nor `@cal_` Cal), without a trailing `'s` (read as a possessive before it is read as part of a
name) or full stop; letters keep the combining marks Devanagari or Thai write vowels with; case,
accents and punctuation fold away (`@zoe` names Zoë). **A key that names two people at its strongest names nobody**: `@Grant`, with a
Grant Smith and a Grant Lee in the club, stays plain text, and the autocomplete writes `@Grant
Smith` instead.

The composer offers the club's members (never yourself) as soon as `@` is typed: exact names first,
then names starting with what was typed, then any of their words, then any match; ↑/↓ move, Enter
or Tab picks, Escape closes it for that name, and a tap picks without closing the phone's keyboard;
nothing is picked while an input method is still composing. Its state lives in chat-core's composer
store (D202), outside React. An edit that names someone new notifies them; nobody is notified twice
for one message (the notifications table's own unique key).

**Context.** "Keep server parsing as the source of truth" (the brief). Tallgrass's comment mentions
were read for their edge cases (emails, code spans, possessives, ambiguous names, the IME guard,
holding mousedown in the picker); no code was taken from it.

**Rejected.** *Structured tokens in the stored text (`@[Ana](user_123)`)*: they leak into the bell,
pushes and anything else that shows the words, and read wrongly anywhere the token is not drawn.
*The client sending the ids it picked*: two sources of truth for whom a message names, and the
client's wins only until someone edits the text. *Highlighting by matching names in the browser*:
it could disagree with whom the server notified. *Keeping D152's "the member registered last
wins" for a shared first name*: it notified one of two Grants at random.

**Consequences.** D152's behaviour changes in four ways, all deliberate: an ambiguous first name
notifies nobody; an `@` inside an email address or a word is not a mention; a whole display name
with spaces is one (`@Grant Smith`); accents fold (`@Zoe` and `@Zoë` are the same). One case plain
text cannot settle: a name that begins another member's whole name, followed by the rest of it,
reads as the longer name (with an Ana and an Ana Bell, `@Ana bell rang` names Ana Bell). **Ships
via.** A server deploy. No migration, no native build.

## D202. A shared chat core: `packages/chat-core`, with no dependencies and no app in it

*Superseded in part by D206: the core now lives in its own repository, `coletebou/chat-core`
(`@coletebou/chat-core`, MIT), built to `dist`, and Book Club installs it from a tagged release. Its
rules (no dependencies, no app, no platform) are unchanged.*

*Cole, 2026-11-05: "Might want to build out some core shared code like how we did for badland voice
core that can be shared across my projects."*

**Decision.** The parts of a group chat that belong to no app live in `packages/chat-core`
(`@bookclub/chat-core`): name folding and quoting (`text.ts`), @-mentions (`mentions.ts`: reading,
autocomplete, the segments a bubble draws), the message and thread model (`messages.ts`: pure
reducers that keep a live, paged, threaded list right, with the app's own rules passed in), a tiny
external store and the composer store built on it (`store.ts`, `composer.ts`). The attachment model
and the agent-participant protocol with its webhook signing join it in later rounds (D203-D205). It
follows the Badland real-time voice core's rules: no runtime dependencies at all (not even zod: the
wire schemas stay in `@bookclub/shared`, which is Book Club's own API contract), structural types
only, a store whose `getState` and `subscribe` go straight into `useSyncExternalStore`, tests beside
the code with the network switched off. `src/boundary.test.ts` holds it to that: no dependencies,
and no import of an app, of React, of a Node built-in, or of the DOM outside its tests. Book Club
consumes it as source, as it does `@bookclub/shared` (no build step); the server's bundle takes it in
like every `@bookclub/*` package; the Dockerfile's install layer and the CI test list name it.

**Rejected.** *Putting it in `@bookclub/shared`*: that package is Book Club's vocabulary (zod
schemas, the book timeline, chapters) and depends on zod; the core would not lift out of it.
*Building to `dist` now, as the voice core does*: there is no consumer outside this repository yet,
and source exports keep one toolchain; a build step comes with the move (below). *A repository of
its own now*: the brief says not to create one; the move is Cole's call, asked in this round's pull request.

**Consequences.** Moving it out is mechanical: copy the folder, give it a `build` (`tsc` to `dist`,
the voice core's `exports` map), rename it, and point Book Club's two `workspace:*` dependencies at
the published package. **Ships via.** A server deploy. No migration, no native build.

## D203. Pictures in chat: made safe as a note's photos are, kept without their metadata, gated with their message

*Cole, 2026-11-05: "Need to support ... images in chat."*

**Decision.** A chat message may carry up to ten pictures (`LIMITS.chatImagesPerMessage`), with or
without words. Each is uploaded before the message, one bounded multipart request per picture
(`POST /api/clubs/:clubId/chat/attachments`, at most `LIMITS.photoNoteBytes` as a note's photo),
made safe inline in that request, and claimed by `attachmentIds` when the message is sent, inside
the same transaction that creates it: every picture named, or no message at all. This is D140-D142's
machinery for a note's media, reused: the same sharp, the same content sniffing (a picture is what
its bytes say, never its name or type), the same blob store and orphan sweeps (an upload nobody sent
goes an hour on; the hourly blob sweep counts chat pictures as uses), deletion at once with the
message (D147), even when the message stays as a thread's placeholder (D200). Migration 023
(additive: `chat_attachments`).

- **Made safe.** Re-encoded without `.withMetadata()`, so EXIF (the GPS a phone's camera writes
  with it), XMP and IPTC are gone; turned upright from its EXIF orientation first; at most 2048
  pixels on its longest side (a phone screenshot's text stays legible), a JPEG, or a WebP when it
  has transparency; an animated GIF or WebP stays animated, as WebP. A 640-pixel WebP thumbnail is
  what the bubble shows. **The upload as it came is not kept**, unlike a note's (D141 keeps its
  original): nothing here needs it, and a copy kept would keep the position it carries in the data
  directory and every backup. A HEIC this server cannot decode is refused with how to send a JPEG.
- **Gated with its message.** `/media/chat/:id` and `/media/chat/:id/thumb` answer only a member of
  the club who may read the message the picture is in right now: its spoiler fence (D150) judged
  for them live, on every request, `private, no-store` like a note's media (D144). Until it is sent,
  only its uploader sees it. While a message is hidden by its fence, its view says only that it
  holds pictures, and how many (`[{ kind: 'image' }]`), never an address or a size; a quote of it
  (D200) counts its pictures only once it is open.
- **In the app.** The composer's camera button opens the device's own picker (several at once;
  inside the iOS app it is the same web input, D149), a pasted picture is added (a screenshot, an
  image copied from a page), and so is one dropped anywhere on the chat. Each picture holds its slot
  in the order it was picked however its upload finishes (chat-core's composer store, D202), with
  its own spinner or reason it failed, and a way to take it out (which takes it back from the
  server). Sending waits for uploads still under way. Without a connection the button is off and a
  paste or drop says why (D146's rule; words still send). A message's thumbnails sit in a grid sized
  by how many there are, with room made before they load; a tap opens one full size over everything
  (the app's own Modal: focus held and given back, Escape), with Back and Next, the arrow keys, a
  swipe, and "Picture 2 of 4".

**Rejected.** *Putting chat pictures in `comment_media`*: its rows belong to a book and a note, and
its book column is required; a chat picture belongs to a club and a message, gated by the message's
fence. A table of their own costs nothing, and every query on either stays simple. *Keeping the
original, as notes do*: see above. *tus*: D140's reasoning holds (megabytes, not an audiobook).
*Caching a picture once its message is open (`max-age`)*: a deleted message's pictures would live
on in friends' caches, and the gate could no longer be checked live; the thumbnails are small.
*Flattening an animated GIF to its first frame*: a reaction GIF is a common thing to send to
friends, and sharp keeps the frames.

**Consequences.** `ChatMessageView` carries `attachments` (and `ChatQuote` `imageCount`);
`CreateChatMessageBodySchema` takes `attachmentIds` and lets `text` be empty with them, stored as
an empty string (D148's rule for a note with media only). **Ships via.** A server deploy. Migration
023. No native build: the iOS app's WebView already offers the photo library and camera to a file
input (D136, D149).

## D204. Cal in the club's chat: asked with @cal, answering in the thread, fenced at the asker's place

*Cole, 2026-11-05: "Can we also add the ability in the general chat to tag with @cal and @Lux and if
anyone tags you they should be able to request features or changes to book-club right there in the
chat."*

**Decision.** Cal takes part in the club's chat wherever he is set up (D160: an Anthropic key, or the
test-only stand-in). His panel stays private (D166); this is the shared conversation, so what he
writes there is public and is fenced like a friend's message.

- **Who he is there.** Each agent writes chat messages as a `users` row of its own (migration 024,
  `users.agent`: his handle, `cal`). That row is no account: no email, no password, no identity to
  sign in with, disabled so that no session can resolve to it, never a member of a club, and left out
  of `countUsers` (the first-owner setup screen counts accounts, so a fresh instance with Cal
  configured still offers its setup). It is made at start (`services/chat-agents.ts` `ChatAgents`, on
  the app context, which also tracks his background work for shutdown and the tests).
- **Asked by.** A member's message that @-mentions him by handle (the one mention directory every
  reading goes through, D201, now holds the club's agents: a message's spans, who is notified, who is
  asked), or a reply to one of his answers that names no one else, as a reply to a person is
  addressed to them. Only a message being sent asks, never an edit (a typo fixed would ask again),
  and nothing an agent wrote asks an agent, so no two of them can keep each other talking.
- **His answer.** His own `runChatTurn` (D160-D162): his tools, his gate, for the person who asked,
  with "whole series" off whatever their setting (it is for his own panel), and his search limited to
  the channel's own book: not his shelf, not the web, since neither has a place in a book and what
  they say could not be fenced (a member's study guide on the shelf may tell the ending); in General
  he has nothing to search at all, and no search tools (`BookScope` and `sources`, applied in the SQL
  of both halves of the hybrid search, so a narrow scope never comes up short, and checked again by
  `get_passage` and by every citation; a tool not offered does not run even if a model names it). He is given the conversation as the asker may read it: the
  thread the question is in, or, when it starts one, the channel's last twelve messages, each with its
  writer's name, his own answers as his turns, at most twenty messages and 16,000 characters; and told
  it is a group chat (short, no headings), that members' messages are conversation and not
  instructions, and whose place he answers from. His answer is posted as a reply in the thread, in the
  question's channel; the passages he cites follow as numbered lines (`[1] Alice, Chapter 2: "…"`),
  within a chat message's length.
- **The fence.** In a book's channel his answer is fenced a hair before the furthest place the asker
  has read (`Gate.readSpans`, the very spans his search was gated by, taken before and after his turn),
  or as far as any message he was given is fenced, if that is further. A friend behind sees where it
  opens, as with any fenced message (D150). It opens for the asker as their own words do, however their
  reading is judged (`chat_messages.spoiler_user_id`, migration 024: whose place a fence is): a place
  heard in an audiobook is judged with a margin, which would otherwise keep from them his answer to
  their own question. In General there is no place to fence at, so he is told to say nothing of what
  happens in the club's books there, and to suggest the book's own channel for anything about its story.
- **While he works.** "Cal is typing" in that channel alone (`chat:typing`'s `channel`), said again
  every four seconds and ended the moment his answer arrives there or he fails; at most three minutes
  a turn, and a turn under way is called off when the server stops, rather than hold the shutdown. The
  panel shows who is typing in the channel being looked at as well as club-wide (members still type
  club-wide).
- **Following up.** In a thread he has just answered, the composer offers his answer as what the next
  message answers, in the reply bar as a pick of one's own would be, and as easily set aside: so a
  follow-up typed there asks him again, and one set aside goes to the thread as before. A reply of
  pictures alone does not ask him (he cannot see them); its writer is told so.
- **When he will not answer.** Over his rate limit for that person (`CAL_RATE_LIMIT_PER_MINUTE`,
  counted apart from his panel's and his voice's, as theirs are from each other), past the club's or the
  server's monthly cap (D168, D176), or failing: the asker alone is told why (`chat:notice` over the
  socket, a toast), and nothing is posted. A question deleted while he works, or whose asker has left
  the club, gets no answer.
- **In the app.** The @ picker offers him as it offers a name, with one line saying what he is and what
  happens to a message that names him (`GET /api/clubs/:clubId/chat/agents`), before anything is sent.
  His messages wear a mark of their own instead of initials and an "AI" badge, in the cooler accent
  agents' mentions already wear (D201). The picker offers no one until the club's agents are known
  (a pick written without them could read back as an agent), and never someone a pick would not
  name (chat-core `mentionable`). The bell opens his answer to the one it answers, as the chat does.

**Rejected.** *Posting his answer unfenced, trusting him to hold back*: the spoiler rule binds his
words to the asker's place (D162), but a shared channel is read by friends behind that place; the
fence is the guarantee, the prompt only the habit. *A fence he declares himself (how far his answer
goes)*: a guess, made in the spoiler direction. *Every club book in a book's channel*: a fence names
one book's place, and what he drew from another would be fenced by the wrong one. *The club's common
ground in General (what every member has read)*: one member who has not started a book makes it
nothing, and each new member would change what an old answer may say; the book's own channel is
plainer. *An author column that is not a user (a nullable `user_id`)*: `user_id` is NOT NULL with a
foreign key, and every query that joins users for an author would need a second path. *His turns on
`calJobs`*: one at a time, behind a book's indexing. *Answering a reply to him that names someone
else*: it is addressed to them.

**Consequences.** `ChatAuthor` carries `agent` (a handle, or null); `ChatViews` takes the app context,
since its directory needs the club's agents; the socket gains `chat:notice`; `CAL_TEST_FAKE_MODEL_DELAY_MS`
(tests only) slows the stand-in in chat so "Cal is typing" can be seen. Limits, as built: a member whose
whole display name is "Cal" takes `@cal` in their club (a whole name is the strongest reading, D201),
so there the picker does not offer him and he is asked from his panel; his answer to someone who has
finished the book opens only for those who have, since he may have drawn on any of it; in chat he
knows the channel's book and what he learned before, not his shelf or the web; he does not see
pictures (a message's are named, "[2 pictures]"); a restart while he works loses that answer, and the
asker asks again. **Ships via.** A server deploy. Migration 024 (additive). No native build.

## D205. Agents of other services in the chat: delivered signed, answering through their own API

*Cole, 2026-11-05: "...tag with @cal and @Lux and if anyone tags you they should be able to request
features or changes to book-club right there in the chat."*

**Decision.** Besides Cal, a server can name agents of other services (`CHAT_AGENTS`: one JSON array,
one environment variable, `BOOKCLUB_CHAT_AGENTS` in the deploy kit): each with a handle, a name, a
line on what it does, a mark (an emoji, or a small `data:` picture: the app's CSP allows no other
host's), a webhook address and the secret its deliveries are signed with, the bearer token it answers
with, and the clubs it is in (their ids, or `*`). Lux is the first. Book Club decides nothing about
what an agent is asked: it delivers the message, and shows what the agent answers.

- **The same participant as Cal.** Its own `users` row, never an account (migration 024, D204), in
  the mention directory by its handle where it is enabled, asked by the same rule (`agentsAsked`: a
  message naming it, or a reply to its message naming no one else; never an edit, never an agent's
  message). The @ picker shows its mark, what it does, and that a message naming it is sent outside
  Book Club with the conversation it is in; the composer says so again, "Sent to Lux, outside Book
  Club", under any message that will go to it (naming it, or answering its message, picked or the
  thread's own when nothing is: in a thread under its own message, every reply), as the server will
  read it, and before the club's agents are known (their list still loading, or failed) by who wrote
  the message it answers, while a draft that may name one (`@lux` typed by hand, read by chat-core's
  own parser) waits to be sent until the list says; its messages carry a "Bot" badge.
- **Delivery.** A POST to its webhook, JSON (chat-core's `AgentEventV1`: the club, the channel, the
  message with its writer, the conversation before it as the writer may read it, and where to
  answer, as a path on Book Club's API: never an address, see below), signed: `x-agent-signature: v1=` and the hex HMAC-SHA256 of `${x-agent-timestamp}.${body}`
  with the shared secret (chat-core `agents.ts`, Web Crypto only, so the agent's side can use the
  same code in any runtime; golden vectors made with Node's own HMAC). A receiver checks it over the
  raw body and refuses a timestamp more than five minutes off. Never a redirect followed (a signed
  body goes where it was configured to, or nowhere); ten seconds an attempt; a network failure, a
  timeout, a 429 or a 5xx tried again twice (after 1 s and 4 s) under the same `x-agent-delivery` id,
  each only while the message is still there and its writer still in the club, and each built again
  (the conversation and the message as they are then: what was deleted meanwhile is not sent again);
  what never got
  through told to the asker alone (`chat:notice`); a server that stops calls off the attempt under
  way and the wait for the next. Per person (`perMemberPerMinute`,
  4) and overall (`perMinute`, 30), each a minute's sliding window (D168), so neither one member nor
  everyone together can flood the service. The message's own pictures go as addresses signed for that
  agent (a per-start key), good for an hour and fetched with its token; the rest of the conversation
  says only how many pictures a message holds.
- **No address in a delivery.** Where to answer (`reply.path`) and each picture (`path`) are paths
  on Book Club's API, which the agent joins to the address it was configured with for Book Club.
  An origin built from a request is the asker's to choose: the CSRF check accepts an `Origin` that
  matches the request's own `Host`, so a member could have sent a message whose delivery told the
  agent to answer at their host, with its token.
- **Its API** (`/api/agents/v1`, bearer token, compared as SHA-256 digests in constant time, 120
  requests a minute): post in a club it is in (a reply in the thread of a message delivered to it,
  or a message of its own in a channel; a `clientId` makes a retried post land once), edit its own
  messages, say it is typing (in that channel alone, as Cal is), fetch its pictures, and `GET /me`.
  Nothing else: it reads the conversation only as deliveries bring it, it answers only what was
  delivered to it (any other message, there or not, is the same 404), and a message it did not write
  is, to it, not there. Every token and secret is one agent's alone (one agent's secret as another's
  token would let the first post as the second; a secret two share would let either sign the
  other's deliveries), and a configuration that breaks this, or names an address that does not
  parse, stops the server saying what, never printing the value.
  What it writes loses control characters and the bidirectional overrides and isolates that could
  make a message read as something else.
- **Fenced by what it was given.** Each delivery is kept (`agent_deliveries`, migration 025) with the
  furthest fence of everything it carried (the message and the conversation sent with it, as its
  asker may read them), before its first attempt, and raised by a retry that carries more (the asker
  read on meanwhile), never lowered, and outliving its message and its asker should either ever be
  removed for good (the agent had their words). An answer to a message is fenced at that
  delivery's fence, at the asker's place (`spoiler_user_id`, D204): every word it carried was
  theirs to read, so it opens for them as their own words do, and a friend behind sees only where
  it opens. A message of its own in a book's channel answers no one, so it is fenced at the
  furthest fence ever delivered to that agent there, at no one's place. An edit fences again by the
  same rule and never lower. General has no fences, so there nothing is.

**Rejected.** *Following redirects*: a moved address could carry a signed delivery to a host nobody
configured. *Fencing an answer by the conversation as it is when the answer arrives* (as first
built): it missed the channel's messages a question that starts a conversation is sent with, and a
fenced message deleted meanwhile, and it hung on which message the agent said it answered.
*Every answer at the channel's furthest fence*: one reader far ahead would hide each answer from
everyone behind them, the asker included; what an agent was given for one message is what its
answer to it can carry. *The event's addresses built from the request's origin* (`PUBLIC_ORIGIN`
or the `Host` it came with): see "No address in a delivery". *An agent reading the chat through its API*: it would see what no one asked it to, and
every read would need a member's gate; deliveries carry what the asker may read, and only that.
*`clubs: "*"` as the default*: a club whose members never chose the agent would have their
messages sent to another service; `*` is for a server whose clubs are all one owner's, and says so.
*An avatar fetched from the agent's host*: the app's CSP allows images from itself and `data:` only,
and a fetch at start would make the server's start depend on another host. *A signature over parsed
JSON*: two serializers disagree; the raw bytes are what both ends hold.

**Consequences.** `ChatAgentView` carries `avatar`; `tools/fake-agent/server.mjs` (one file, no
dependencies, its own `node:crypto` check, Book Club's address from its own `BOOKCLUB_API`) is the
agent of the demo stack and its E2E suite, as `fake-upstream` and `fake-google` are the identity
providers'. Limits, as built: Book Club fences what an agent writes by what it delivered, so an
agent that keeps deliveries and carries what one said into its answer to another, or a book's
channel into General, is past what Book Club can fence; docs/DEPLOY.md asks an agent to answer each
delivery from what it carried, and to put anything drawn from several in a message of its own in
that book's channel. A restart while a delivery is being retried loses it, and the asker is not
told. **Ships via.** A server deploy. Migration 025 (additive: `agent_deliveries`). No native build.

## D206. The chat core moves to a repository of its own, MIT, installed from a GitHub tag

*Cole, 2026-11-07: "i like the sound of its own repo maybe public only private if its a moat", and
"any of my repos" should be able to use it.*

**Decision.** `packages/chat-core` (D202) is now the public repository `coletebou/chat-core`,
split out with its history (`git subtree split`), as `@coletebou/chat-core` under the MIT licence:
its sole author relicensed it from AGPL-3.0-only so projects under any licence can use it. It
builds with `tsc` to `dist/` (declarations, an `exports` map with `types` and `import` for `.` and
`./agents`, relative imports naming their `.js` files so the build loads in plain Node too), and
`dist/` is committed so a tag installs with no build step; its CI fails when `dist/` is not what the
source builds to, and imports the built package by its own name in plain Node 20, 22 and 24. Book
Club's server and web app depend on `github:coletebou/chat-core#v0.1.0`; the lockfile pins the
tag's commit and the tarball's integrity, so a moved tag cannot change what is installed. The
server's bundle leaves it external like any npm dependency, and `pnpm deploy` installs it in the
image. Its tests, the signature golden vectors among them, moved with it.

**Rejected.** *Publishing to npm*: not needed yet; a GitHub tag gives the same pinned,
integrity-checked install, and the name is free to publish under later. *GitHub Packages*: every
consumer would need a token just to install a public package. *Keeping it AGPL*: a project under
another licence could not use it, which is the reason for moving it. *Leaving `dist/` out and
building on install*: a git dependency's `prepare` runs a build in every consumer's install.

**Consequences.** A change to the core is a change in its repository, a version bump and a tag,
then a one-line bump here (both dependencies and the lockfile). Book Club's CI no longer runs the
core's tests; the core's own CI does. **Ships via.** A server deploy. No migration, no native build.

## D207. Meet-ups in your calendar: a file for one, a private feed for all, reminders left to the calendar

*Builds on D224.*

**Decision.** A meet-up with a day downloads as an iCalendar file ("Add to calendar",
`GET /api/books/:id/meeting.ics`, members only): one event with a stable UID per book, so the
calendar updates it rather than adding a second when it is downloaded again, a SEQUENCE that grows
with each change, the time in UTC for its length, or an all-day event when it has only a day (with
its stop as what to have read by), and alarms the day before and an hour before (an all-day one at
nine the morning before). Settings gives each person one private feed of every meet-up in every club
they are in (`/api/calendar/<token>/meetups.ics`, from a month ago on), for a calendar app to
subscribe to (`webcal:` on Apple devices, Google Calendar's "From URL"), which keeps it up to date as
meet-ups move. Its address is a key, like an invite link: 192 random bits, shown once when it is
made (only its hash is kept, as for sessions), cut out of the request log as invite codes are
(`SECRET_IN_URL`, since a calendar app asks for it every hour), replaced or turned off from Settings, and dead with a
disabled account or a club left. An event says what every member already sees on the library page
(the club, the book, the stop's name, where), never a chapter's title or anything said in the book;
the text is escaped and folded at 75 octets per RFC 5545.

**Rejected.** *Server-sent reminders (push or in-app) on a schedule*: a scheduler, its catch-up after
a restart and its time zones, for what every calendar already does on the device. *A feed address
that can be shown again*: keeping the token itself would let a database copy open everyone's
calendar. *A public, guessable feed per club*: anyone outside could see when and where it meets.
*Google Calendar "add event" links*: one more provider-specific path; the file and the feed work in
every calendar.

**Ships via.** Server and web (and the iOS WebView). Migration 027. No native build.

## D208. Plans: each club on the free plan or Club Pro, with limits only the host sets

*Builds on D176 (anyone may start a club). Self-hosted instances keep working as before: no limit
unless their host sets one.*

**Decision.** A club has a plan (`clubs.plan`, `plan_until`, migration 028): free, or Club Pro for
good or until the end of a day. What each plan allows is the instance's own setting
(`CLUB_FREE_STORAGE_GB`, `CLUB_PRO_STORAGE_GB`, `CLUB_FREE_MEMBERS_MAX`, `CLUB_PRO_MEMBERS_MAX`),
unlimited when unset. What a club stores is its live books' files and covers and its notes' photos,
voice and video, each content once, plus what its uploads under way have declared (and not yet
expired), so two uploads at once cannot pass the limit together: the check and the new import are one
transaction. A new book or format that would not fit is refused when its upload is declared, before a
byte is sent (413 `storage_full`, saying how much room is left); a full club takes nobody new by
invite (409 `club_full`, before an account is made for a signup), and a member following the link
again just goes in. A limit only stops what comes next: when Club Pro lapses, nothing is removed and
nobody is put out. Every member sees the plan on the club's settings page (what it stores, how many
are in it, against the limits); an owner on the free plan also sees "Take Club Pro" when the host sets
`CLUB_PRO_URL` (a payment link), opened with `client_reference_id=<club id>` so the payment says which
club it is for. The host puts a club on a plan with `bookclub club-plan`, and `bookclub clubs` lists
every club's plan and use.

**Context.** With anyone able to start a club (D176) and, soon, to sign up without an invite, one
club's audiobooks could fill a small host's disk; and a hosted instance needs some way to be paid for
that does not lock the free, self-hosted app. Storage and members are what cost the host; Cal is
already capped per club and per instance.

**Rejected.** *Billing inside the app (checkout, webhooks, dunning)*: a payment link and a command are
enough until there are more paying clubs than one person can upgrade by hand; a webhook can later call
the same `setPlan`. *Counting soft-deleted books*: the club removed them to make room, and they are
purged in time. *Counting a file shared with another club once, for one of them*: either club may keep
it alone, so each counts it. *Limits on by default*: a self-hosted club of friends has no reason to
meet one. *Taking anything away when a plan lapses*: a limit stops only what comes next.

**Ships via.** Server, shared and web. Migration 028. The deploy kit passes the five settings through
(`BOOKCLUB_CLUB_*`).

## D209. What to talk about: questions for the meet-up, from friends and from Cal, gated like notes

*Builds on D224. Reuses D53's "there" and D69's writer's horizon. Revisits INTENT's "AI summaries or
recommendations": these are questions, never summaries, and they open only where the reader is.*

**Decision.** Under the meet-up card, "To talk about" lists the questions for the book's next stop
(`meetup_questions`, migration 029): any member adds one (5 to 400 characters), votes for the ones
they most want to talk over (one vote each, taken back with a tap; the most wanted first), and
whoever wrote one, or the club's owner, removes it (its words cleared at once, its votes gone). A
question opens to a friend once they are there, as the meet-up card counts it (D53: what they have
read, not jumped to, reaches the stop), and, from a friend, once they have read as far as its writer
had when they wrote it (D69's horizon, kept on the question and judged by the gate exactly as a
note's). Until then it is only counted ("One more question opens for you at the end of Chapter 2"):
never its words, its writer or its votes, and voting for it or removing it finds nothing (404). Where
Cal is set up, "Ask Cal for questions" has him write five from the book's own text up to the stop:
the indexed passages that end by it, the latest 60,000 characters of them, never one that runs past
it (so the last lines before the stop can be left out, never a word after it), with his instructions
to treat the end of that text as the end of everything he knows about the book. His questions say
who asked him, are placed at the stop with no horizon, and open as any friend's. An ask is checked
against the club's and the instance's Cal budgets and logged against them, three asks a day per stop
(each counted, even one that brought nothing new), three per person per ten minutes. Moving the stop
starts a new list; moving it back finds the old one there.

**Context.** A meet-up needs something to talk about, and clubs reach for publishers' reading
guides, which are written for the whole book and spoil it. Questions written at the stop, by friends
who are there or by Cal from the text up to it, are what the app knows that a guide does not.

**Rejected.** *The gate's own place check for "there"*: its spans are half-open and its cross-format
margins wide, so a friend who has just reached the stop, or a listener a few seconds before it, would
see none; the meet-up card's rule is the one people see. *Cal reading the whole book and being told
not to spoil it*: an instruction is not a fence; he gets only the text up to the stop. *Trimming a
passage that runs across the stop to the stop*: its words map to the timeline only roughly, and a few
lines lost is better than a few spoiled. *Questions from a reading-group guide or the web*: written
for the whole book. *Ranking by anything but votes and age*: the friends are equals.

**Consequences.** A well-known book's later events may still be in what the model knew before it
read the excerpt; his instructions forbid using them, and his questions open only to friends at the
stop, but this cannot be proved the way the gate is. The demo and the tests use a deterministic
stand-in that only quotes the excerpt it was given (`CAL_TEST_FAKE_MODEL`).

**Ships via.** Server, shared and web (and the iOS WebView). Migration 029.

## D210. A landing page for a signed-out visitor at `/`

**Decision.** `/` keeps showing a signed-in person's library exactly as before (`HomePage`, inside
`Shell`). A signed-out visitor in an ordinary browser sees a real page instead of the sign-in wall
that was there before: `apps/web/src/pages/LandingPage.tsx`, rendered by `App.tsx`'s `RequireAuth`
in place of its usual redirect, only at `/` and only when `!runningInstalled()` (the same
`display-mode: standalone` / `navigator.standalone` / `window.BookClubNative` check
`components/InstallHint.tsx` already uses) — inside the installed PWA or the iOS app shell, nobody
is discovering Book Club for the first time, so it is straight to `/signin` as ever. The page: what
it is (one timeline across formats, spoiler-free by construction, reading along, presence and the
club bar, chat and voice/listening together, Cal as optional), three steps (start a club, share the
link, read at your own pace), two real screenshots of the demo club (rendered with Playwright
against the dev stack, optimised with `sharp`'s `pngquant` palette mode to a few tens of
kilobytes each, `apps/web/public/landing/reader.png` and `club.png`), an open-source/self-host
note linking the repository and its AGPL licence, and three ways in: Start a club (`/start`,
D211), Sign in, and Join with a link (`HomePage.tsx`'s own `JoinByLinkModal`, exported for this).
No pricing section — Book Club has none to show yet — with a comment marking where one would go if
that ever changes. No new dependency, no external font, script or tracker; `styles/landing.css` is
its own file, reusing the same tokens (D117) every other page does.

**Context.** `apps/server/test/open-signup.test.ts` and the web unit tests
(`LandingPage.test.tsx`, `StartPage.test.tsx`) cover the server and component logic; `e2e/tests/landing.spec.ts`
drives the real flow, including an axe pass on the landing page itself (the same technique
`a11y.spec.ts` uses on every other page).

**Rejected.** *Showing the landing page inside the installed app too*: the PWA's whole promise
(INTENT.md, "a good evening of reading") is opening straight to a place already signed in; a
stranger who somehow opened the installed app before signing in still wants the fastest way to
sign in or start a club, not a scroll of marketing. *A different route for it (e.g. `/welcome`),
leaving `/` on the sign-in redirect*: a link to the app's own address should be this page, not a
login wall, and keeping it at `/` only needed `RequireAuth` to special-case one path it already
owns. *CSS-drawn illustrations instead of screenshots*: a demo club already exists for exactly
this, and the real thing is more honest than a mock-up of it.

**Consequences.** `docs/INTENT.md`'s "not building" table is reworded: a club is still never public
or listed, and joining one always takes an invite; only who may *start* a club (D176) or make an
account with no invite at all (D211) is the instance owner's own call, off until they turn it on.

**Ships via.** Web only (and the iOS WebView's own sign-in wall, untouched). No native build. No
migration.

## D211. "Start a club" with no invite at all, behind `OPEN_SIGNUP`

**Decision.** A new settings flag, `OPEN_SIGNUP` (default **off**): when on, `/start`
(`apps/web/src/pages/StartPage.tsx`) and `POST /api/auth/start`
(`apps/server/src/routes/auth.ts`) let a stranger create an account and a first club, as its
owner, in one request — a name, email, password and a club name, reusing `PasswordSchema` and the
display-name rules every other sign-up uses (`StartClubBodySchema`, `packages/shared/src/api/schemas.ts`,
shaped like `SetupBodySchema` but with the club name required, since starting a club is the whole
point of this form rather than first-run setup's optional one). The account and the club (with its
own invite link, which `createClub` already makes) are created in one database transaction
(`ctx.db.tx`, nesting `createClub`'s own transaction as a savepoint — the same pattern
`POST /api/setup` already uses for the first owner), then signed in, landing on the new club's own
settings page (`/clubs/:id/settings?welcome=1`) where the invite link is already there, with a new
"Copy link" button next to it (`ClubSettingsPage.tsx`, `data-testid="copy-invite"`) and a one-off
banner naming the club. Rate-limited per address only (`startLimiter`, 5 per hour) — tighter than
joining with an invite (`signUpLimiter`, 20 per hour per address *and* invite code), since there is
no invite code here to spread the budget across. Off, the route 404s (the same graceful-absence
shape Cal's own routes use without a key) rather than 403ing: a path nobody turned on is simply not
there. Joining a club is unaffected either way and stays invite-only (D176 already opened
*starting* one, for any already-signed-in account; this is only about making the account at all).
The dev stack (`scripts/dev-stack.sh`) and the Docker demo (`compose.yaml`) turn it on, so the demo
shows it; the deploy kit (`deploy/compose.yaml`, `deploy/.env.example`) leaves it off, a real
deployment's owner opts in with `BOOKCLUB_OPEN_SIGNUP=true`.

**Rejected.** *An owner-only toggle reachable from Settings instead of an environment variable*:
every other instance-wide policy (`WEB_SETUP`, `CLUBS_OWNED_MAX`, the upstream and provider
settings) is a deploy-time setting the owner controls before anyone else can reach the instance at
all; adding the one UI-editable policy among them would need its own authorisation story for no
real gain on an instance small enough that its owner already edits `deploy/.env`. *Reusing
`POST /api/auth/signup`'s invite-based route, with a sentinel "no invite" value*: that route's
whole shape (claim an invite, join that club) does not fit "make a club", and a sentinel value is
an easy way to add a path nobody meant to open. *The same rate budget as joining with an invite*:
with no invite code to key on, one address could otherwise mint a run of new clubs at the pace of
a password hash each.

**Ships via.** Web only (and the iOS WebView, unaffected: `/start` is an ordinary same-origin
page). No native build. No migration — `OPEN_SIGNUP` is config, and the account/club tables and
`createClub`'s invite are exactly what D4, D40 and D176 already built.

## D212. The public config route tells the web app whether `OPEN_SIGNUP` is on

**Decision.** `GET /api/session` (unauthenticated; `SignInPage` already reads it for `upstream` and
`providers`) gains one more field, `openSignup: boolean`
(`SessionInfoSchema`, `packages/shared/src/api/schemas.ts`), set from `ctx.config.OPEN_SIGNUP`.
Optional in the schema, the same way `providers` was added (D178's own comment explains why):
every `SessionInfo` fixture across the web test suite that builds one by hand, without this field,
keeps compiling and running; code that reads it treats a missing value as off, same as `false`.
The landing page and `/start` both read it from the same cached query (`useSession`) rather than a
second request.

**Rejected.** *A new, separate unauthenticated endpoint*: `GET /api/session` already is the
public-config route every other optional sign-in feature answers through; a second one would
answer the same question about the same instance from a second place.

**Ships via.** Web and server. No native build. No migration.

## D213. Share cards: OpenGraph and Twitter meta, a rendered 1200×630 image, and `robots.txt`

**Decision.** `apps/web/index.html` carries `og:title`, `og:description`, `og:image` (1200×630,
with its width/height), `og:url` and the matching `twitter:*` tags. `og:image` and `og:url` are
absolute (`__PUBLIC_ORIGIN__/landing/og-image.png`, `__PUBLIC_ORIGIN__/`), because the server
*can* inject the instance's own address cheaply: `apps/server/src/routes/static.ts`'s `serve()`
already special-cases `index.html` to set its per-request CSP header, so reading the file (a few
KB) and replacing one placeholder with `publicOrigin(ctx, request)` (the configured
`PUBLIC_ORIGIN`, or else the request's own `Host`) costs nothing worth naming — a relative image
would have needed no such change, but an absolute one is what every sharing site actually fetches,
and self-hosters get it for free rather than having to set `PUBLIC_ORIGIN` correctly just for
sharing to work. That branch keeps its own brotli/gzip negotiation (`lib/compress.ts`'s
`preferredEncoding`/`compressBytes`, recompressed per request rather than cached next to the file,
since the bytes are no longer the file's own once templated — the file is small enough that this
costs microseconds) but, unlike a plain static file, no longer has a file-based `ETag` or `Range`
support: nothing before this read `index.html` conditionally either (it was already `no-cache`,
revalidated on every load), so the only real change is that a client now always gets a fresh body
rather than occasionally a `304`. The 1200×630 image itself is rendered once, from a small local
HTML template (not a live page — nothing in it is per-request), with Playwright, the same way the
landing page's own screenshots are, and checked into `apps/web/public/landing/og-image.png`.
`apps/web/public/robots.txt` allows the landing page, `/signin` and `/start`, and disallows
`/api/`, `/media/`, `/ws`, every signed-in app path, and the per-link `/join/` and `/reset/`
addresses, which are not meant to be indexed at all.

`publicOrigin()`'s fallback is the request's own `Host` header — a client's to set to whatever it
wants, `evil.example"><meta http-equiv="refresh" ...>` included, and `Host` is a generic header
value, not something Fastify or Node's http parser rejects for carrying quotes or angle brackets.
Templating that straight into `content="__PUBLIC_ORIGIN__/..."` would let anyone's request plant
markup on everyone's copy of the page (the real page, not a proxy of it, since it is read from
disk and sent whole — no script runs that a CSP could stop, which is also why CSP does not cover
this). Two independent guards: `safeOrigin()` only accepts a candidate that is *exactly*
`scheme://host[:port]` (`ORIGIN_RE`, `static.ts`) — no path, query, userinfo or anything else —
checked against the configured `PUBLIC_ORIGIN` too, not only the request's `Host`; anything else
(an injection attempt, or an operator's typo) falls back to the relative addresses already next to
the placeholder in `index.html`, never to the raw value. Whatever does pass is still run through
`escapeHtmlAttr()` before it is substituted, so a origin that is syntactically valid but contains
`&`/`'` stays a correct attribute rather than a theoretical second way out of one. The response
also carries `Vary: Host` (next to `Vary: Accept-Encoding`, only added once compression actually
applies) whenever `PUBLIC_ORIGIN` is unset, since the body then genuinely depends on the `Host` a
request carried, not only on its `Accept-Encoding`; `RUNBOOK.md` tells an operator behind a shared
cache or CDN to set `PUBLIC_ORIGIN` explicitly, which makes the body the same for every `Host` and
the header moot.

**Rejected.** *A relative `og:image`*: most sharing sites (Slack, iMessage, Discord) resolve a
relative image URL against the page's own address well enough in practice, but not reliably
enough to trust for a feature whose entire point is how a link looks when pasted, and the
server already knows the right absolute address for every other purpose (invite links, reset
links) through the same `publicOrigin` helper. *A build-time `PUBLIC_ORIGIN` baked into the static
bundle*: the same image and app build are meant to run on any self-hosted address; baking one in
would need a rebuild per deployment for a value the server already receives at request time.
*Trusting `PUBLIC_ORIGIN` only, and always relative when it is unset*: simpler, and considered
seriously once the `Host`-header risk above was found, but it would throw away the one thing that
made an absolute `og:image` worth having (self-hosters get a correct one with no setting to
remember) for a risk a strict shape check removes anyway; the two guards above cost a short
function each and keep that behaviour for the common case (no `PUBLIC_ORIGIN`, an ordinary `Host`)
while refusing anything that is not already exactly an origin.

**Ships via.** Web and server. No native build. No migration.
## D214. Picking the next book: nominate, approval-vote, one open round, Up next

**Decision.** Nothing in the app helped a club agree on what to read next; that conversation lived
entirely in a group chat, outside the club's own memory. Any member nominates a book (title
required; author, a plain external link — Goodreads, StoryGraph, Open Library, anywhere else about
it — and a short pitch, "why we should read it", all optional), can edit or withdraw their own
nomination, and the owner may remove any. Nominating opens a round if the club has none open
(anyone may also open an empty one); a club has at most one open round at a time, enforced by a
partial unique index (`nomination_rounds`, migration 030) rather than trusted to the route alone.
Voting is approval voting: any member may back any number of nominations and change their mind
until the round closes, shown with the count and every voter's name — the friends are equals, so
nothing here is anonymous or weighted. The owner, or whoever opened the round, closes it; closing
picks the nomination with the most votes, and a tie (including a round with nothing nominated,
every count tied at zero) is broken by whoever closes, choosing among the tied. The winner becomes
the club's **Up next**: shown on the library page with a way back into the picker, and kept
(`club_up_next`) until it is marked done (D215). A pitch describes a book nobody in the club has
read yet, so none of this needs the spoiler gate: every member sees the same nominations, the same
votes, and the same result, as plainly as the members list does.

**Rejected.** *Ranked-choice or scored voting*: approval voting says "I'd read any of these" in one
tap, which fits a handful of friends choosing between a handful of books better than ranking them
all. *A tie resolved by the server (oldest nomination, random, …)*: the room already has to agree
on a book; letting whoever closes pick between two the room split evenly on is simpler than a rule
nobody asked for and still theirs to decide. *Letting only the owner nominate or vote*: the club's
whole point is that friends are equals (INTENT); the owner's only extra power here is closing a
round nobody else opened and tidying up a stalled nomination.

**Consequences.** A new data model (`nomination_rounds`, `nominations`, `nomination_votes`,
`club_up_next`, migration 030) and routes (`routes/nominations.ts`) under the same one-rule
authorisation as everything else (`auth/access.ts`'s `requireRound`/`requireNomination`, membership
through the round's club). D215 covers Up next's own lifecycle; D216 covers importing a to-read
shelf into nominations; D217 explains why a closed round is announced live rather than through the
persisted notifications table.

## D215. Up next clears itself when the matching book arrives; the owner can also say it is done

**Decision.** The round's winner sits on the library page as Up next until there is nothing left to
point at. When a brand-new book (never an added format of one the club already has) lands in the
club, its title is compared against Up next's with the same similarity check `routes/books.ts`'s
book-matches already uses for "is this the club's book under another format" (D45): a close enough
match clears Up next automatically (`services/next-book.ts` `clearUpNextIfMatches`), no button for
anyone to remember to press. Short of that — a different title, an edition added to an existing
book, or simply because the club is done with it without adding it at all — the owner has their own
"Mark as done" on the library page and on the picker.

**Rejected.** *Only the person who adds the matching book may clear it*: the automatic match already
covers that case without asking who is at the keyboard; a manual clear is for the cases the match
cannot see, which is an owner's moderation call like disbanding a club or removing a book, not a
"whoever happens to add a book" one. *Clearing Up next the moment the round closes, with no Up next
at all*: the winner is the point of closing the round — the library page needs it to show the club
collectively decided something, and to send a friend into the picker.

**Consequences.** One more table (`club_up_next`) and one hook into the ingest pipeline
(`ingest/pipeline.ts`, after a genuinely new book is recorded, never when a format is added to one
that already exists). No new permission beyond "owner" already has everywhere else.

## D216. Importing a to-read shelf: a Goodreads or StoryGraph export, parsed on the device

**Decision.** A member who already keeps a to-read shelf elsewhere should not have to retype it.
They export their library from Goodreads (My Books → Import and export → Export library) or
StoryGraph (Manage Account → Export your data) and choose the CSV in the picker; the file is parsed
entirely in the browser (`lib/shelf-import.ts`), filtered to the to-read shelf, and shown as a
checklist. Only the nominations chosen are ever sent to the server, one each — the export itself,
and whatever else it says about the rest of their library, never leaves the device. The parser is a
small general CSV reader (quoted fields, commas and newlines inside them, a doubled quote as one
literal quote, a leading byte-order mark) rather than a split on commas, because both services'
exports need it: Goodreads writes an ISBN cell as `="9780141439518"` so a spreadsheet keeps the
leading digits, which after unescaping is a bare `=9780141439518` the import still has to recognise
and strip.

**Rejected.** *Uploading the CSV to the server to parse*: the whole reason to import a to-read shelf
is that it already exists in full elsewhere; sending the whole file (every shelf, every rating,
every private note Goodreads keeps) to nominate a handful of books is more than the feature needs
and more than a friend should have to trust the server with. *Matching by ISBN against an outside
catalogue to fill in a cover or a better title*: no outside lookups (INTENT: a private room,
nothing fetched on a member's behalf); the title and author the export itself gives are enough for
a nomination.

**Consequences.** A pure, dependency-free module (`lib/shelf-import.ts`) and one modal
(`components/ImportShelfModal.tsx`) that calls the ordinary nominate route once per chosen book; no
new server surface at all. Tests are small synthetic export fixtures written for this, never a real
person's library.

## D217. A round's result is said live, by a toast, not through the persisted notifications table

**Decision.** When a round closes with a winner, everyone looking at the picker is told at once
("*Title* won the vote — it's Up next") the same way the app already says other things that just
happened (`components/Toasts.tsx`), riding the same `club:changed` push every other change here
does. It does not become a fourth kind in the `notifications` table (D49, D145, D152): that table's
shape, and the bell's, are built around the spoiler gate — a reply or a reached note is held by
where its writer or its reader has read to, and a mention is held by its message's own fence. A
round's winner is never held by anyone's reading (D214: nothing here is spoiler-gated), so it would
be the first kind in that table needing none of the machinery the other three share, for a thing
that is already visible to everyone looking at the right page the moment it happens.

**Rejected.** *A fourth notification kind*: would ask three request-time functions
(`toView`/`judge`/the `LIVE` filter in `services/notifications.ts`) and the kind's own `CHECK`
constraint rebuild (SQLite's twelve-step rebuild, as 015's `mention` already needed once) to grow a
branch each for a kind with no spoiler question to answer, to persist something the picker already
shows plainly to whoever opens it. *No announcement at all*: closing a round is the moment the
whole point of the exercise lands; saying it only on the next page load undersells the "we decided"
moment the vote was for.

**Consequences.** `pages/NextBookPage.tsx` toasts on its own `closeRound` mutation succeeding; a
friend who was not looking at the picker at that moment simply sees Up next on the library page next
time they look, same as any other club change. No migration, no push.

## D218. The deploy command says when it is out of date, and may update itself where the host asks

*Keeps the forced command a copy outside the clone (docs/DEPLOY.md, "Checks and automatic deploys").*

**Decision.** Every deploy compares the installed forced command with `deploy/auto-deploy.sh` at the
commit it deploys (`command_current`). When they differ it deploys as before and says so, with the
exact `install` command, in its output and as a `::warning::` annotation on the GitHub Actions run;
`retention` reports the same against the clone's `origin/master`, read-only. A host may set
`BOOKCLUB_DEPLOY_SELF_UPDATE=1` in its own settings file (never in the repository): then a deploy
installs the deployed commit's script over the installed copy (a new file moved into place, so the
running bash reads the old one to its end), leaves a `::notice::`, and `exec`s the new version for
the same deploy with the lock still held on the same file descriptor, so no other deploy can start
between them. It installs once per deploy (`BOOKCLUB_DEPLOY_UPDATED`); a copy that cannot be put in
place stops the deploy before anything changes. Run from the clone itself, there is nothing to
compare.

**Context.** On 2026-11-04 and 2026-11-05 merged fixes to the disk gate did nothing on the host
until someone noticed and reinstalled the copy by hand: the copy is outside the clone on purpose,
so that a commit cannot change what the deploy key runs without a person installing it, and nothing
told anyone a newer reviewed version was waiting.

**Rejected.** *Self-update by default*: it removes the hand check this design chose, which only
the host's owner should give up. *Running the clone's script directly from a thin stub*: the same
trade as self-update, with no way to keep the hand check. *Failing a deploy whose command is out of
date*: one forgotten install would stop every deploy, including the fix for whatever made it
urgent. *Comparing with origin/master instead of the commit being deployed*: a newer push would
make an older queued deploy install a script it did not ship with.

**Ships via.** The deploy kit only. The first install of a version with this check is by hand, as
before.
## D219. The iOS app's offline copy of a track is named by its type; a copy that fails is never why a track does not play

*Cole, 2026-11-07, from the iPhone app: "Audiobooks won't play."*

**Cause.** D138 kept each track the app played as a file named after its URL alone, and track URLs
have no extension (`/media/editions/<id>/tracks/<n>`). AVFoundation chooses a local file's format by
its name: `AVURLAsset` on a file with no extension fails with AVFoundationErrorDomain -11828 (format
not recognised), whatever the bytes are (checked on macOS's AVFoundation with real M4B and MP3 files:
the same bytes open as `.m4a`/`.mp3` and fail with no extension). expo-audio passes no type hint. So
every track heard once in the app, and kept, never played again, and the app made no request for it
(it was "on the device").

**Decision.** The copy is named `<D138 name>.<ext>`, the extension chosen from the file's own first
bytes (`sniffAudioExtension` in `packages/shared/src/audio/offline-file.ts`: MP4/M4A/M4B, MP3, ADTS
AAC, WAV, AIFF, FLAC, CAF), never from the URL or the response's headers. A download is written to
`<name>.part` and kept only once it is whole and its bytes are audio iOS plays; anything else (an
error page served with a 200, Ogg, which AVFoundation does not open) is deleted. A copy kept by a
build before this, with no extension, is renamed with the extension its bytes say the first time its
track loads again (or deleted when they say none), so nobody downloads their books again. And if a
kept copy still fails to play, native reports it, deletes it, and goes on with the same track from
the network, where it was and playing if it was, without an error for the page; a track whose copy
failed is streamed and not downloaded again until the app next starts.

**A second cause: AVPlayer sends no session cookie.** On the simulator, with a header-logging
proxy in front of a local server, AVPlayer's own requests for a track (`AppleCoreMedia/1.0.0`,
`Range: bytes=0-1`) carried no `Cookie` at all, and got 401 (the item failed with NSURLErrorDomain
-1013), while the app's background download of the same track (CFNetwork) sent the session cookie and
got 200. D133's premise, that `AVURLAsset` reads the shared cookie store, did not hold. Together: the
first play of a track failed, its download succeeded, and every play after failed on the untyped
copy. So native playback now streams with a **media ticket** (`apps/server/src/auth/media-tickets.ts`):
the app asks `POST /api/media/ticket` for the edition, with its own authenticated request, and gives
the ticket to the player as the `x-bookclub-media-ticket` request header (expo-audio's `headers`, i.e.
`AVURLAssetHTTPHeaderFieldsKey`, sent on every range request). A ticket opens one edition's tracks,
for the session that asked, while that session lasts and for 12 hours at most, and only while its
holder is still in the club (the track route's own check). It is signed with a key made at start, as
the agents' picture links are (D205): a restart ends them all, and a stream that fails is tried once
more with a fresh ticket, where it was, before the page hears of it. The ticket travels in a header,
never in the address, so no log of addresses holds one.

Native playback errors are reported content-free (`native-error`: the error's domain from a closed
list, its integer code, the track's index, whether it was the device's copy or the network, and
whether native recovered) to the existing diagnostics endpoint, which now also takes these events
from a member listening outside a party (`audio.native-diagnostics` in the log). The domain and code
come from builds whose expo-audio reports them (the repository's expo-audio patch adds both to a
failed item's status, `ios/AudioPlayer.swift`); a build before it sends neither.

**Rejected.** *A signed URL instead of a header* (D133's own rejected option): the address ends up in
logs and in the lock screen's metadata. *Handing the session cookie itself to the app's JavaScript*:
a stolen ticket opens one edition's audio for a while; a stolen session opens everything. *Playing
only once a track is downloaded*: a book in one 600 MB file would wait minutes to start. *An
`AVAssetResourceLoader` that adds the cookie*: native code, so a new build, where tickets reach the
installed one over the air. *An `AVURLAssetOverrideMIMETypeKey` option*: expo-audio takes no asset options but
headers, so it means a native patch and a new build, where the extension fixes it in JavaScript that
reaches installed builds over the air. *The extension from the `Content-Type` header*: the bytes are
what AVFoundation reads; a header can be wrong, or a sign-in page's. *Deleting every untyped copy*:
correct but makes everyone download every book they had again. *Showing the page the error and
letting the person retry*: the copy would fail again on every retry; the track itself is fine.

**Consequences.** `NativeAudioEngine.test.ts` covers the rename, the `.part` download, the sniffed
refusal and the recovery; `offline-file.test.ts` the sniffing and naming, with real files' bytes.
**Ships via.** A server deploy (the ticket route, the solo diagnostics) and an over-the-air update (JavaScript only), in that order; the app streams as before, cookie only, from a server without tickets.

## D220. Book Club in iMessage: a Messages app extension that carries ids, and answers as each reader

*Cole, 2026-11-07: invite to a club from a conversation, share a quote or how far you are, vote on
the next book in the thread, answer a meet-up — respecting the spoiler and privacy rules.*

**Decision.** A Messages *app* extension (`apps/mobile/targets/messages`), native Swift and SwiftUI,
made at prebuild by `@bacons/apple-targets` and turned from the sticker pack its `imessage` type
makes into an app extension by `plugins/with-messages-extension.ts` (Xcode's
`app-extension.messages` product type, our `MessagesViewController`).

- **What a message carries.** A thread can hold people who are not in the club, and every one of
  them sees the same bubble, so a message carries only ids and what its sender chose to say about
  themselves: an invite (club, code, name), their own place in a book (its title, their percent, the
  chapter as their friends already see it), a vote (club, round), a meet-up (club, book, title). Never
  a passage, a comment's words, a cover or anyone else's place. The format is one, in
  `packages/shared/src/messages/imessage.ts` and its Swift twin, held to the same golden vectors; it
  sits in the URL's fragment (`<origin>/m#v=1&k=…`), which a browser never sends to the server.
- **Live bubbles, as each reader.** A vote or a meet-up is an `MSMessageLiveLayout` in one
  `MSSession`: each reader's own extension draws it from what the server tells *that reader*, and an
  answer sends the same bubble again, so it updates in place for everyone. A quote, when it comes, is
  the same shape: an id, its words fetched through the comment's own spoiler gate.
- **Auth: the app's own session, shared.** The app copies its session cookie (already mirrored to the
  system by `sharedCookiesEnabled`, D133) into a keychain item in the App Group's access group
  (`SharedSession.swift`): readable by the app and its extensions only, after first unlock, never
  synced. The extension sends it as the request's Cookie, as the app's own native requests do; the
  server's cross-site check passes them (no `Origin`, no `Sec-Fetch-Site`) and nothing server-side
  changes. Whether the system holds a session cookie decides: every snapshot from the page and every
  foreground shares it again, or deletes it once signed out.
- **Votes and meet-ups only where the server has them.** They use the next-book picker's and the
  meet-ups' routes; on a server without them (404) those actions are simply not offered.

**Rejected.** *A read-only, signed deep link with no session in the extension*: a vote in the thread
must be cast as each voter, from their own phone; a link could only open the app. *A bearer token
minted for the extension*: a second credential to issue, scope, expire and revoke, for what the
session cookie already does under the same gate. *The cover and the quote in the bubble's image*:
the image is the same for everyone in the thread, members or not. *The `imessage` sticker pack as
it is*: it has no code.

**Consequences.** A new App ID (`ai.badland.books.messages`) with the App Group, and a profile for
it, before the first signed build (apps/mobile/README.md). The format's Swift half is tested with
`apps/mobile/scripts/test-messages-swift.sh` on macOS; CI runs the TypeScript half. **Ships via.** A
new native build (a new target and a native module change); the `/m` web page with a server deploy.
The target is in a store build only once `STORE_TARGETS.messages` (app.config.ts) is turned on, in
a PR, after the extension's App ID has the App Group and its profile exists: until then an archive
signs as before. *Rejected: the target always in*: master would not archive until then. *An
environment variable for store builds*: the runtime version (D180) is computed from the config on
several machines, and one that missed the variable would make the build's own updates never reach
it (`BOOKCLUB_MESSAGES=1` adds the target to a local simulator build only).

## D221. CarPlay is an audio app in the same process: one player, started by JavaScript the car can wake, listing only what this phone already has

*Cole's brief, 2026-11-07: "CarPlay (audio app): a tab bar of Continue, Club books and chapters, and
the standard Now Playing, driven by the same native player and Now Playing info that already work on
the lock screen. The entitlement switchable, off by default."*

**Decision.** A CarPlay scene beside the phone's (`CPTemplateApplicationSceneSessionRoleApplication`,
`BookClubCarPlaySceneDelegate`), added with the `com.apple.developer.carplay-audio` entitlement by
`plugins/with-carplay.ts`, only once `STORE_TARGETS.carplay` (app.config.ts) is turned on; a setting
in the repository, not the environment, because the runtime version (D180) is computed from the
config on several machines (`BOOKCLUB_CARPLAY=1` turns it on for a local simulator build only). Expo SDK 58's template is
already scene-based, so the phone's scene is untouched. The car's templates (a `CPTabBarTemplate` of
three `CPListTemplate`s, and `CPNowPlayingTemplate.shared`) are drawn in Swift from a model that
JavaScript builds (`src/carplay/model.ts`) and sends whole, and every tap comes back as a row id
(`CarPlayDriver.ts`). The player stays `NativeAudioEngine` (expo-audio's AVPlayer), so CarPlay's Now
Playing screen, its play/pause and its 15/30-second skips are the lock screen's own
(`MPNowPlayingInfoCenter`, `MPRemoteCommandCenter`), and the place is saved and kept on the device as on
the phone (D182, D196), with streaming tickets (D219).

- **The player no longer belongs to the WebView.** A car can open the app with no phone screen, and
  Expo's scene delegate starts React Native only with a window. So the engine, the audio session and
  the widgets' bridge are made as the JavaScript starts (`src/audio/appAudio.ts`, imported by
  `index.ts`); the WebView attaches to them while it is mounted. The car's scene delegate starts the
  React host with no surface when there is none (`RCTRootViewFactory.initializeReactHost`), and a phone
  screen opened later reuses that host: there is never a second player.
- **What the car lists is what this phone already has.** The books are the widgets' snapshot (D188): the
  person's own places in their own clubs' books, nothing of anyone else's. A book plays in the car once
  its audiobook has been opened on this phone: each queue the page sends native (its tracks' URLs and the
  titles the player's own list shows) is kept on the device, the newest six books
  (`bookclub-kept-queues.json`, `keptQueues.ts`). Nothing is fetched to find a book's tracks. Signing out
  clears the snapshot and the kept queues, and with them every list in the car.
- **Where a book starts.** The newer of the place kept on the device and the server's own
  (`GET /api/books/:id/progress`, `mine`), in this audiobook's edition only. A book never started starts
  at its beginning. A place in the ebook, another edition, or none known while offline is not guessed
  at: the car shows the book's chapters instead. A chapter you are in goes on from your place in it;
  any other starts at its beginning.
- **The page and the car do not fight.** While CarPlay started what plays, the page (if open) hears
  nothing of the player, and the place is saved natively whether or not it is open. What the page
  says of its own player meanwhile (its queue, sleep timer, speed) is kept. It takes the player back
  with a track of its own (the person choosing on the phone), or with a play, pause, seek or speed on
  the car's own book (the same edition), or when the car disconnects while it is on that book: its
  queue, timer and speed apply from then, the car's last stretch is saved first, and the page is told
  the track playing and where (as after an advance). A page on another book keeps hearing nothing
  until it loads a track: it would otherwise take the car's book's time for its own.
- **Whose place.** The place kept on the device counts only when it is the same person's as the
  queue's (the page's own rule, D196): after one person signs out and another signs in, the car never
  starts from the first one's place.
- **Spoilers.** The car shows only what the lock screen already does: titles, the track titles the
  player's list shows, and your own place as friends see it ("Chapter 4 · 25%"). No notes, chat or
  other members' places reach it.

**Rejected.** *`react-native-carplay`*: its last release is a 2024 beta, it does not support the new
architecture or Expo, and it still needs a native scene delegate. *Templates built in Swift from the App
Group alone*: native would duplicate the queue, place and spoiler rules; built in TypeScript, every rule
is unit-tested, and Swift only draws (its decoding checked against the same vectors with plain swiftc,
`scripts/test-carplay-swift.sh`). *Fetching any club book's tracks from the server*: the track titles
come from the web player's own chapter logic, and a book never opened on the phone has no place known
to start from. *The entitlement always on*: an archive would not sign until Apple grants it and the
profiles carry it. *Up Next and album-artist buttons on Now Playing*: off; chapters are their own tab.

**Consequences.** `src/carplay/carplay.test.ts` (the model, the kept queues, the starting place, a tap),
`NativeAudioEngine.test.ts` ("CarPlay drives the player"), `test/carplay-plugin.test.ts` (the scene and
the off-by-default flag), and the Swift vectors. **Ships via.** A new native build (a scene delegate,
a module change, the CarPlay framework) with `STORE_TARGETS.carplay` on, once Apple has granted the
CarPlay audio entitlement for `ai.badland.books` and the App Store profile carries it. Off, the app
is as before, except that its player is made as the JavaScript starts.

a module change, the CarPlay framework) with `BOOKCLUB_CARPLAY=1`, once Apple has granted the CarPlay
audio entitlement for `ai.badland.books` and the App Store profile carries it. Built without the flag,
the app is as before, except that its player is made as the JavaScript starts.

## D222. The watch app is a remote and a progress view in v1; listening on the watch alone is planned, not built

*Cole's brief, 2026-11-07: "SwiftUI watchOS app: now playing controls, plus downloading the current
book's next chapters to the watch for phone-free listening. Scope v1 honestly."*

**Decision (v1).** A single-target SwiftUI watchOS app (`targets/watch`, `@bacons/apple-targets`'
`watch` type, watchOS 10, embedded in the iPhone app) with one screen: the book, the chapter, a bar
for the chapter that runs by itself while it plays, how far through the book, the time left in the
chapter at the speed chosen, and the lock screen's own buttons (15 seconds back, play/pause, 30
forward). The audio stays on the iPhone. What the watch shows is the Live Activity's own record
(`recordOf`, D189): the phone sends it through WatchConnectivity (`WatchBridge.swift`: the
application context, which the watch reads whenever it opens, and a message while both are awake),
only when something the watch shows changed (`WatchDriver`), whether or not the Live Activity is on.
The buttons come back as commands to the app's one player (D221's `appAudio.ts`): `toggle`, and
`skip` by the lock screen's own intervals. Nothing reaches the watch that the lock screen does not
already show: the title, author and chapter, and your place.

**Not built, the plan (v2): listening on the watch alone.**
1. *What to carry.* The kept queue of the book playing (D221's `keptQueues.ts`: tracks and titles)
   and the next two or three tracks' files, chosen on the phone from its place. The phone already
   keeps typed offline copies (D219) of what it played; it would send those with
   `WCSession.transferFile`, newest place first, and drop the watch's copies of tracks heard.
2. *Playing.* `AVAudioSession` with `.longFormAudio` (watchOS routes it to Bluetooth headphones and
   asks for them), `AVPlayer` on the watch's files, `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`
   for its Now Playing.
3. *The place.* Kept on the watch as the phone keeps it (D196), and sent back with
   `transferUserInfo`; the phone saves it as its own (newest wins, as D196). No session or cookie on
   the watch: it never talks to the server, so no media ticket (D219) is needed.
4. *What it needs that v1 does not.* Storage limits (a watch has a few GB, a book's tracks are 30 to
   100 MB each), transfer only while charging for large files, a downloads screen (mockup
   `watch-02-downloads.png`), and a real device: the watch simulator cannot test Bluetooth audio.

**Rejected.** *Streaming on the watch*: it would need the session on the watch and works only on
Wi-Fi or cellular models, draining the battery. *A WatchKit extension (two targets)*: the
single-target app is the current model. *The Live Activity on the watch (Smart Stack) alone*: it shows
what plays but its buttons are limited to the app intent already there; v1 adds the skips and a
screen of its own.

**Consequences.** `test/watch-app.test.ts` (the Info.plist keys, the record shared with the watch),
`NativeExtras.test.ts` ("the watch app's view of the player"), `NativeAudioEngine.test.ts` ("a skip
from the watch"), `scripts/test-watch-swift.sh`. **Ships via.** A new native build with a third target, once
`STORE_TARGETS.watch` (app.config.ts, as D220's) is turned on: the App ID `ai.badland.books.watchkitapp`
exists; its App Store profile (`BOOKCLUB_SIGNING_WATCH_PROFILE`) is still to make.

## D223. Cal answers in the narrator's voice: the narration's own, a consented clone, or one designed from words, never a clone from the recording

**Decision.** A listener who stops an audiobook to ask Cal something (a voice turn in a thread about
that book, D167) hears the answer in the narrator's voice, so the step from the narration to the
answer is not a change of speaker. Each book may keep up to three ElevenLabs voices
(`narrator_voices`, migration 026), spoken in this order:

1. **(a) The narration's own voice**, when the audiobook is itself ElevenLabs speech: the exact voice.
2. **(c) A clone of a human narrator, with their consent**, recorded beside it (`clone_consent`: who
   agreed, when, how). The table's CHECK refuses a clone without it, `resolveNarratorVoice` asks
   again, and `bookclub narrator-voice set --clone-voice-id` needs `--consent`.
3. **(b) A designed voice**: ElevenLabs Voice Design from a written description of the narrator
   (gender, age, accent, pace, timbre). The recording is only *measured*, on the host: its pace in
   words a minute from the transcript's word timings (`paceOf`), its median pitch by autocorrelation
   of a minute decoded with ffmpeg (`cal/voice/pitch.ts`). The design request is built from a fixed
   list of fields (`DESIGN_FIELDS`) that leaves out the endpoint's `reference_audio_base64`, so no
   caller can send it a narrator's audio. Of the previews, the one nearest the narration's pitch (in
   semitones) is kept, unless the owner picks one by ear (`--pick N`, previews saved with `--out`).
   While every preview is more than two semitones off, another round is designed (up to three),
   each with a seed of its own: measured, the same description without a seed returns the same
   three voices each time, and a different seed returns different ones.

The delivery is matched too. Speed: the voice's own pace at speed 1 is timed by ElevenLabs'
per-character timestamps (`ElevenLabsVoiceDesign.pace`, first spoken character to last, as the
narrator's is first word to last); the speed is first guessed as `narrator wpm / voice wpm`, within
ElevenLabs' 0.7 to 1.2, then timed again and corrected (`calibrateSpeed`), because ElevenLabs' speed
is not proportional to pace (measured on the live Red Rising voice: 0.7 gave 0.88 of the pace).
Stability, similarity, style, model and seed are per book (`settings_json`). A narrator's voice
defaults to Multilingual v2, not Cal's Flash v2.5: measured on that voice, Flash and Turbo speak at
about 280 words a minute at speed 1 and 195 at 0.7, where the narrator reads at 130; Multilingual v2
at 177 and 156, in its long-form delivery, for about 0.7 s more synthesis per reply. What even
0.7 cannot slow enough (that voice still read 156 against 130), the player makes up: the record
keeps a `rate` (0.75 to 1.25, set by `calibrateSpeed` only when the pace is still more than 5% off),
`speakingStart` carries it, and the reply plays at it times the listener's own speed, pitch kept.
The rate is not part of the cache key: it changes how the audio plays, not the audio. Each speed is timed
on five replies of the kinds Cal gives (`CALIBRATION_TEXTS`) and their median kept: measured on the
live voices, one voice at one speed read 101 to 162 words a minute from one text to another, and the
long preview paragraph was the fastest of all, so timing it alone set every speed too slow.
`narrator-voice calibrate` times a book's voice again, whichever of (a), (b) or (c) it is. On the device, a reply in the narrator's voice plays at the
listener's own speed for that audiobook (`AudioState.speed`, pitch kept), so 1.5x narration is
answered at 1.5x; Cal's own voice plays as spoken. `speakingStart` names the voice's kind, narrator
and source (never its id or settings), and the panel says so: "a voice made to sound like X, the
narrator. It isn't X" for a designed one; only a consented clone is called theirs. Cal's persona is
unchanged (D160): the voice changes, not who is answering.

Spoken replies are cached (`CachedTtsProvider`, `derived/tts-cache`): keyed by provider, model,
format, voice (Cal's by the configured id; a narrator's by id, settings and seed) and text, so the
same words in the same voice are read back for nothing (logged at $0). A fixed seed per voice makes a
cached copy the speech a fresh one would be. Only a reply spoken to its end is kept (a barge-in's
half sentence never is). Bounded by `CAL_TTS_CACHE_MB` (256, least recently used first) and
`CAL_TTS_CACHE_DAYS` (30), and never served over HTTP: a hit only happens for words Cal has just
generated for that asker, through the same spoiler-gated turn. `CAL_NARRATOR_VOICES=false` turns
narrator voices off everywhere.

Also fixed on the way: a voice turn with `CAL_TEST_FAKE_MODEL` called the real Anthropic API (the
text route used the stand-in, the voice pipeline did not). It now uses the same stand-in, which is
what lets `test/narrator-voice.test.ts` run real voice turns over `/ws/cal/voice`.

**Context.** ElevenLabs' Instant and Professional Voice Cloning require the rights to, or the consent
of, the voice cloned. The club's audiobooks are mostly commercial recordings (Recorded Books, Audible)
and LibriVox volunteers: none has agreed. A designed voice is the closest match available without
consent; the clone slot exists so that a narrator's yes can be acted on with one command.

**Rejected.** *Cloning from the audiobook's own audio* (IVC from a chapter, or Voice Design v3's
reference audio): no consent. *A preset voice picked by hand from the library*: no measured match,
and nothing per narrator. *Cal answering as the narrator (persona)*: a separate product decision from
D160's one consistent Cal, not made here. *Picking the preview by an AI listening pass*: sends the
recording to another service, where pitch measured on the host says what is needed. *Caching by
question rather than by spoken text*: two askers at different places get different, separately gated
answers; the spoken text is what the audio is of. *Matching loudness*: Voice Design's `loudness` is
left at its default; a measured match (LUFS of the narration against the reply) is not done yet.

**Consequences.** `test/narrator-voice.test.ts` (the order of the three voices; a clone refused
without consent at the table, the resolver and the command; settings over defaults; pace and pitch
measured; speed matched; ElevenLabs' TTS, design and timing requests, with no reference audio ever
in a design; the cache's hits, keys, cut-off replies, size and age; real voice turns over the
WebSocket in the narrator's voice, Cal's for other threads and when turned off, the second time from
the cache at $0; `design` end to end with a stand-in ElevenLabs), web `useCalVoice.test` (the reply's
rate and pitch for a narrator's voice) and `CalPanel.test` (what the panel says of whose voice it is).

## D224. Meet-ups: the next stop gets a time, a place and who is coming

*Revisits D53's rejection of "a calendar with invitations and RSVPs". Keeps D53's one stop per book,
set by anyone, shown by name.*

**Decision.** The next stop is where the club will talk next (D53); now it can say when and where,
and who is coming. Beside its day it may have a time, set on the setter's clock and kept as an
instant with that time zone (`starts_at`, `tz`), so each friend sees it on their own clock and, when
theirs reads differently, on the setter's too ("Saturday, 12:30 am (7:30 pm in New York)"). With a
time, the day is the one the time falls on where it was set; the server works it out
(`localDayIn`), so the two never disagree. It runs about an hour and a half unless the form says
otherwise (15 minutes to 10 hours). It is somewhere: the club's own voice room (D153, offered only
where voice is set up), a place as written ("Ana's, 12 Elm Street"), or a link to a video call (an
http(s) address, opened in a new tab, never fetched by the server). Any member answers Coming,
Maybe or Can't make it, changes the answer or takes it back; the card shows everyone's answers
("Ana and Ben are coming · Cleo maybe"), the library card how many are coming. An answer is for
one occasion, the meet-up's time (or, without one, its day) when it was given (`meeting_rsvps`,
migration 027): moving the meet-up to another evening leaves the old answers behind, still stored
but no longer counted, and moving it back brings them back; changing only the stop or the place
keeps them. Clearing the stop clears its answers. Someone who leaves the club is no longer among
them. In the quarter of an hour before a meet-up in the voice room and until an hour after it ends,
the card carries the club's voice bar, so joining the call is one tap from the book (its LiveKit
code still loads only then). The modal keeps the labels it had (Read up to, By) and adds Time, For
about and Where; it is still one PUT that replaces the whole state, so a field left empty is cleared.

**Context.** D53 rejected invitations because "the friends already have a way to agree on an
evening". That way is the group chat, which is the thing a club using this app should not need on
the side: since D176 anyone may start a club, and a club that has only this app had nowhere to say
when it meets. What the app knows that a calendar does not (the book, the stop, who is there) stays
the heart of the card; the evening and the answers sit beside it.

**Rejected.** *Separate meeting events with their own stops, a plan of several dates*: the club's
habit is one next stop at a time, and D53's single stop already moves on after each meeting; a plan
can come later as several stops. *Deleting answers when the evening moves*: moving back, a common
mistake, would lose them. *A time without a day, or a day computed in the server's own zone*: the
setter's zone is the only one that names the evening they meant. *Notifying everyone of every change
or reminding them from the server*: calendars remind people better (D207), and a server schedule is
a moving part a small instance does without. *Pressure on the slower reader*: the answers are about
the evening, not about reading; nothing nags anyone about how far they have read.

**Ships via.** Server, shared and web (and the iOS WebView). Migration 027 (columns on
`meeting_points`, `meeting_rsvps`, `calendar_feeds`). No native build.

## D225. Tests run in a pinned time zone: New York for what members see, UTC for the server

**Decision.** Every test run picks its zone from its package's `vitest.config.ts`, not from the
machine: `apps/web` and `packages/shared` run in `America/New_York`, `apps/server` in `UTC`. The
config sets `process.env.TZ` before vitest starts its workers, which inherit it, so a run on a
laptop anywhere and one in CI give the same results. `BOOKCLUB_TEST_TZ=<zone>` names another zone
for a run that hunts for zone bugs. A test in each of the three (`test-zone.test.ts`) fails if the
pin stops reaching the workers.

**Context.** A Club Pro date (D208) read "7 November" on a laptop in New York and "8 November" in
CI, which runs in UTC. The laptop was right that something was wrong: a date stored as midnight UTC
was shown on the local clock, and a member west of Greenwich would have seen the day before. The
component now formats it in UTC, as meant. What let it reach review was that the result of a test
depended on where it ran. The tests that work on the local clock (history's day labels, meet-ups)
are written relative to the zone they run in, and pass in every zone from UTC−11 to UTC+14.

**Rejected.** *UTC everywhere*: the zone CI already had, so it would only have hidden the Club Pro
bug on the laptop too. Every zone-dependent test would agree everywhere, and a date shown on the
wrong clock would pass every check and reach members. *A zone set only in `scripts/test-ci.sh`*: CI
already ran in UTC, and the runs that differed were the direct `vitest run` calls in AGENTS.md,
which never go through that script. *Every test file in several zones*: twice the run, or more, to
cover a kind of bug one zone west of Greenwich already exposes (a date at midnight UTC). *New York
for the server too*: the server runs in UTC (the container sets no zone), and its tests should see
the clock it has.

**Ships via.** Tests only (`apps/web`, `packages/shared`, `apps/server`). Nothing the app runs
changes.

## D226. Migration and decision numbers are checked before anything installs, and the next free one is read across open pull requests

**Decision.** `tools/check-numbers.mjs` checks the two series this repository numbers by hand: the
server's migrations (`apps/server/src/db/migrations/NNN_name.sql`) and these decisions. It fails
when a migration number is taken twice or skipped, when a `.sql` file there is not in the loader's
`NNN_name.sql` form (it would never run), when a D-number has two entries or a heading not in
`## D<n>. Title` form, or when a tracked file cites a D-number with no entry, such as a citation
left behind by a renumbering. It needs only Node, so `check.yml` runs it first, before
`pnpm install`, and a collision fails in seconds instead of near the end of the server's suite.
`--next` prints the next free migration number and D-number, counting what every open pull request
has already taken (each one's head, fetched from `refs/pull/<n>/head`, never checked out), and
names any number that two branches, or one branch and master, claim for different things.

**Context.** Four branches built side by side (#8 to #11) each took migrations 022 to 027 and D206,
because each took "the next" number from master. Every rebase then renumbered migrations, entries,
TRACEABILITY rows, citations in code and the unit tests that list the migrations, by hand. The
server's `unit.test` already failed on a migration number used twice (MU4), but only once both
branches had met on one tree, and only after most of the server's suite had run. Nothing checked
the decisions.

**Rejected.** *Numbers from dates or random ids*: migrations apply in order of their number past
`PRAGMA user_version` (db.ts), and D-numbers are short to cite on purpose. Both stay sequential,
and only their collisions need catching. *Failing CI when an open pull request claims the same
number*: which branch merges first decides who renumbers, and one branch's check should not fail
over another's unmerged work. So `--next` is for the person taking a number, not for CI. *Checking
TRACEABILITY's numbers too*: its `D` rows are the v1 design document's requirements, a different
series, and they are cited the same way, so they cannot be told apart from decisions. *A required
"branch up to date" rule or a merge queue on master*: those would make a pull request's check see
every merged number before it merges. They are a repository setting for the owner, not code here.

**Ships via.** CI and tooling only (`tools/check-numbers.mjs`, `check.yml`). Nothing the app runs
changes.

## D228. One person, one account: a verified address joins the upstream identity to the account that has it, and the admin can merge two accounts

**Decision.** Two things, one rule: a person has one account here.

*Sign-in.* A first sign-in through the upstream ("Continue with <name>", or the upstream's
password typed into this app's own form) whose address the upstream has verified, and which an
account here already has, now **joins that account**: the account gets the upstream's subject, and
its name and address follow the upstream from then on. This supersedes one sentence of D116,
"never a local account's address", under which that sign-in got a second account with no address
beside the first. It is what a first Apple or Google sign-in has done since D178, and it follows
D178's rules exactly (`auth/external-identity.ts`, both resolvers side by side):

- The address counts only because the provider vouches for it. For the upstream that is decided in
  one place, `identityOf` (`auth/upstream.ts`), which hands on an address only when the exchange
  said `emailVerified`; an unverified one joins nothing.
- The provider's proof wins outright. Book Club never verifies an address itself (D14), so a local
  password on the matched account is cleared, and everything its holder could come back with is
  revoked: every session, every unused reset link and sign-in code, and the account's live
  sockets (`hub.revalidate`, `hub.disconnectUser`). Revoking the reset links and codes is new for
  Apple and Google too: a link or a code made before the takeover no longer outlives it.
- **Never by an Apple private-relay address** (`@privaterelay.appleid.com`), for the upstream,
  Apple and Google alike. A relay address is a per-app alias, not a mailbox a person is known by;
  an account on one is found by its identity's subject only. A sign-in that brings one nobody has
  keeps it as its address; one that is taken gets an account with no address.
- **Never to a disabled account or an agent's row.** A verified address that leads to one links
  nothing, makes no second account, and the sign-in is refused (`takesSignIn`, the one check every
  provider route makes on the account it resolved).
- **Never a second upstream identity on one account.** `users.upstream_subject` holds one. Two
  upstream accounts with one address are two people until the admin says otherwise, so the second
  keeps getting an account of its own with no address, as before, and the clash is logged.

*Merging.* For two accounts a person already has, the server's admin runs
`bookclub merge-accounts --from ID --into ID --reason TEXT [--apply --backup-dir DIR]`
(`services/account-merge.ts`; `bookclub accounts` lists the ids):

- **A dry run unless `--apply`.** The plan is the merge itself, run in a transaction and rolled
  back, so it prints exactly what applying would do, checks included, and writes nothing.
- **A snapshot before the first write**, made as the backups make theirs (`VACUUM INTO` from a
  read-only connection, then `PRAGMA integrity_check`), mode 0600, in `--backup-dir`. No directory,
  or a snapshot that fails: no merge.
- **One transaction, a rule for every reference.** Each of the schema's references to a user has a
  rule (`RULES`), and the merge refuses before it writes if the schema holds one with no rule, so a
  table added later is never merged by guesswork. After the rules, `PRAGMA foreign_key_check` must
  be empty and the merged account's id must stand nowhere in any text of any table except its own
  `users` row and the record of merges; otherwise everything rolls back.
- **The rules.** Reading: what was read is the union of the two (on the book's timeline, and per
  edition in the edition's own measure, never clamped to [0, 1]), the place is that of whichever
  account had read furthest, the book was finished when the first of them finished it; every
  sitting is kept. Membership: one row a club, the higher role, the earlier joining, the kept
  account's colour. Notes, chat, media, uploads, Cal's conversations and everything the person
  made, set or asked: re-pointed; a replay key (`client_id`) both accounts used is cleared on the
  merged account's row, which keeps its words. One-row-each tables (a listening speed, Do Not
  Disturb, Cal's settings, the calendar feed): the kept account's, the merged one's where the kept
  had none. A reaction or a vote both made: once. A chat read marker and a meet-up answer: the
  later one, whichever account gave it. Notifications: re-pointed, except one that would tell the
  person about themselves or repeat one they already have. Apple and Google identities and push
  tokens move. The upstream identity and the address move only where the kept account has none
  (both columns are unique); otherwise they stay on the merged row.
- **Nothing that signs the merged account in is carried across.** Its sessions, sign-in codes, app
  codes and reset links end (and a reset link it had made for the kept account, which would
  otherwise read as self-issued and skip the reset route's club check). Its own password is never
  checked again.
- **Soft, and nothing is lost.** The merged account's row stays: `disabled_at` set and
  `merged_into` naming the kept account (migration 031; a schema check makes every merged row a
  disabled one, never pointing at itself). Each merge appends one row to `account_merges`: who into
  whom, when, the admin's reason, per-table counts, and, whole, every row dropped, every value
  overwritten and the key of every row moved. Triggers refuse any update or delete of that table.
- **Sign-in afterwards.** `followMerge` (`repos/users.ts`, a few hops, never round a loop) leads a
  sign-in that still finds the merged row to the account kept: by provider identity, by upstream
  subject, and by an address a provider has verified. The password form skips a merged account's
  own password and goes on to the upstream's check, as for an address with no password here.
- **Refused:** the same account twice; an account that is not there; an agent's row; a kept
  account that is disabled or was itself merged; an account already merged elsewhere. The same
  merge asked for again prints "already merged" and exits 0.

**Context.** A friend who joined with one sign-in method and later used another could end up with
two accounts: their notes and reading under one, their club under the other, and nothing in the app
to join them. Apple and Google sign-ins already avoided that for a verified address (D178). The
upstream grant did not: D116's rule came from when the only address an account could have was one
somebody typed at sign-up, which proved nothing, so handing that account to an upstream sign-in
would have been wrong. Since D178 the same account may hold an address a provider has proved, and
D178's answer for an unproved one (the provider's proof wins, and the password goes) is as right
for the upstream as for Apple and Google.

**Rejected.** *Joining by any matching address, verified or not*: an address somebody typed, here
or at the upstream, is a claim; it would let anyone take an account by registering its address
elsewhere. *Joining by a private-relay address*: Apple's own sign-in already finds such an account
by its subject, so a join by the address adds nothing there, and another provider that reports a
relay address is repeating what it was given, not vouching for a mailbox of its own. Declining
costs a second account the admin can merge; a wrong join puts one person in another's account. *Linking a second upstream
subject to an account that has one*: it needs a table where a column is (as `external_identities`
is for Apple and Google) and a decision about whose name the account follows; nobody has needed it,
and a merge handles the case. *Asking the person at sign-in whether an existing account is theirs*:
proof of the address is already the answer, and a prompt adds a step where a wrong tap makes the
duplicate this removes. *A hard merge that deletes the second account*: its row is referenced by
foreign keys that do not cascade (the clubs, books and invites it made), a later sign-in with an
identity or address still on it would make a third account, and an admin's mistake would be
permanent. *Carrying the merged account's sessions and password over*: a credential proves the
account it was issued for; after a merge it would open one its holder may never have proved.
*Merging by address in the command*: an account can have no address, and two can share none; ids
are exact. *Planning with separate read-only queries*: a plan that is not the merge can disagree
with it; run and rolled back, it cannot. *A merge button for club owners in the app*: a merge moves
identities and data across every club an account is in, which no single club's owner may decide.

**Consequences.** Someone with an account here who continues with the upstream for the first time,
on an address the upstream has verified and their account has, lands in their account instead of
an empty second one. If that account had a password, it is gone from then on and its other devices
are signed out: they sign in through the upstream (whose name the account now carries, and which
locks the name here, as for any upstream account), or get a password again by a reset link. A
relay-address sign-in whose address an account already has no longer joins it. A sign-in whose
verified address is a disabled account's is refused instead of being given a new account (the
upstream) or linked to it (Apple and Google, where it was refused all the same). Sign-up with an
address that a merged row still holds is told to sign in, as for any taken address. Not built here:
a signed-in "connect Apple / Google / the upstream to my account" page, which is the only way to
join an account that sits on a private-relay address without the admin, and its buttons in the web
and iOS apps.

**Ships via.** The server only: migration 031, the sign-in resolvers, the command line. No client
or app change.
