# Reviews

Fresh-context reviews of the whole repository, each by a reviewer that had not seen the work
before: code quality and correctness, product fidelity to the brief and the v1 documents, and
authorisation and privacy. Every finding was checked against the code before it was acted on;
the status says what was done, and the evidence names the test that now proves it.

Status values: **fixed** (with the commit), **justified** (deliberately not changed, with the
reason), **open** (still to do; none may remain at P0 to P2 at the end).

## Round 1 (2026-10-23)

### Code quality and correctness

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| CQ1 | P1 | Resuming a folder upload re-sent every finished file; retrying an error started a new import while the old workers kept going | fixed 8c248d6 | e2e `resumable.spec` "a folder interrupted by a reload sends only what the server lacks"; server `uploads.test` idempotent finish, concurrent finish, one upload per file |
| CQ2 | P1 | Tapping a spoiler-free marker on the book page opened the reader at the note (revealing it and moving your place) | fixed 825bc76 | e2e `visits.spec` "a note ahead of you on the book page opens locked, and never takes you there" |
| CQ3 | P1 | A followed link became your reading position, and a reload went back to the link | fixed e3b5912 | e2e `visits.spec` (both tests), `touch.spec` audio visit |
| CQ4 | P2 | The offline outbox dropped read spans beyond 64 | fixed e3b5912 | spans are never dropped and go out in parts (`lib/outbox.ts`); web unit tests |
| CQ5 | P2 | A section that failed to load (offline 504, 401 JSON) was shown as an empty page and wrong page totals were cached | fixed e3b5912 | `SectionFrame.load` refuses anything that is not the section; `PageCounter` keeps nothing after a failure |
| CQ6 | P2 | The start position could come from stale cached progress and overwrite newer progress from another device | fixed e3b5912 | readers wait for progress fetched after they open (`useProgress(…, { fresh: true })`) |
| CQ7 | P2 | "Sleep at end of track" then Play replayed the chapter just heard | fixed e3b5912 | e2e `audio.spec` "the sleep timer can stop at the end of the track" now plays on into chapter 2 |
| CQ8 | P2 | Sign-out deleted unsent progress; offline sign-out did not sign out | fixed e3b5912 | `SettingsPage` sends the outbox first and refuses offline |
| CQ9 | P2 | Track-to-chapter matching misplaced common audiobook layouts by whole chapters | fixed 1404a2b | shared `align.test` "refuses a match that would put half an audiobook into its last chapter", "matches tracks that each hold two chapters", "keeps an honest match whose chapters differ in length"; `titles.test` chapter ranges |
| CQ10 | P2 | Swiping to turn pages did not work on touch screens | fixed e3b5912 | e2e `touch.spec` "a swipe turns the page, and the next tap still works" |
| CQ11 | P2 | No error boundary: one render error blanked the app | fixed e3b5912 | `components/ErrorBoundary.tsx` around every route |
| CQ12 | P2 | Realtime never noticed a dead socket nor caught up on missed events | fixed e3b5912 | pong timeout, presence cleared while disconnected, queries refetched on reconnect |
| CQ13 | P2 | `pnpm test` failed: the web app had no unit tests and a missing setup file | fixed 7937ce9 | 486 web unit tests; `pnpm test` runs all four packages |
| CQ14 | P2 | `bookclub restore --force` deleted the data before the archive was known to be good | fixed 1404a2b | server `cli.test` "a damaged or truncated archive, even forced, leaves the current data exactly as it was" |
| CQ15 | P2 | Reactions in the PDF reader failed silently | fixed e3b5912 | error toast |
| CQ16 | P3 | Two concurrent finishes made an extra book | fixed 8c248d6 | `uploads.test` "two finishes at once make one book" |
| CQ17 | P3 | A retried comment could be posted twice (new client id per send) | fixed e3b5912 | one client id per draft; `api.createComment` retries with it |
| CQ18 | P3 | The finished card reappeared on every relayout or reopen at the end | fixed e3b5912 | shown only when a page turn reaches the end |
| CQ19 | P3 | Reports queued during a flush waited up to 15 s | fixed e3b5912 | the running flush sends them |
| CQ20 | P3 | A cancelled page count left a frame load unsettled | fixed e3b5912 | `SectionFrame.destroy` settles it |
| CQ21 | P3 | Other P3s: `%` in EPUB file names, delete failures without a message, "1 notes", SW range fallback, paused audio shown as listening, TOC order labels, mixed clocks in "read up to here", unused code, fixed sleeps in tests, weak test assertions, non-atomic cover writes, `Db.tx` depth on a failed commit | fixed b3bab02 | server `media.test` "serves a file whose name has a percent sign or a space in it"; tests that waited a fixed time for a save now wait for the server to hold the place (`placeSaved`, `serverPlace`); the jump-ahead test checks the read ranges; the speed test crosses a track; orphan blobs are swept hourly; the rest as named |

### Product fidelity (rating 7/10)

| # | Kind | Finding | Status | Evidence |
|---|------|---------|--------|----------|
| FR1 | must | The PDF reader opened on a blank page | fixed e3b5912 | e2e `touch.spec` "the PDF opens with its first page drawn" |
| FR2 | must | On iPhone a tap neither turned the page nor showed the controls | fixed e3b5912 | e2e `touch.spec` taps with a real touch screen, both engines |
| FR3 | must | "Finished" meant touching the last page | fixed e3b5912 | `rangesFinished` needs the ending and 90 % read; e2e `moments.spec` "jumping to the end … is not finishing" |
| FR4 | must | Going to a friend's earlier note lost your place | fixed e3b5912 | e2e `visits.spec` |
| FR5 | should | Continue / Play below the fold on iPhone | fixed c6ebdfb | phone layouts (small cover beside the title, Continue below; listen cover at most 30 % of the screen height) |
| FR6 | should | Chapter-end and finished moments only in the EPUB reader; listeners get no cue at a friend's note | fixed 7937ce9 | e2e `moments.spec` "the PDF has the moment too" and "listening: a friend's note is announced as you pass it, and a chapter's end shows what was said in it" |
| FR7 | should | Margin markers of later pages were focusable and scrolled the hidden pages into view | fixed c6ebdfb | off-page markers are `inert`; the page viewport uses `overflow: clip` |
| FR8 | should | Offline saving automatic only for EPUB | fixed b3bab02 | PDFs are kept on opening (e2e `offline.spec` "a PDF read once is kept on the device and opens with no network"); the next audiobook track is kept while the current one plays |
| FR9 | should | PDF: no tap or swipe paging, no zoom, no themes | fixed e3b5912 (paging, zoom), this commit (themes) | e2e `touch.spec` PDF tap; themes shared with the EPUB reader tint the page |
| FR10 | should | No mini player in the readers; presence flips between formats | fixed 9ad94fb | a floating player over the readers; while audio plays, presence comes from the player only |
| FR11 | should | Upload: "a new book" pre-selected when the book exists | fixed c6ebdfb | a matching book is the default; "A new book" must be chosen |
| FR12 | should | No error boundary | fixed e3b5912 | see CQ11 |
| FR13 | should | Notes show no date | fixed c6ebdfb | `formatWhen` (shared `format.test`), shown in the discussion and the note sheet |
| FR14 | should | Only owners can invite; no hint of more members off-screen | fixed c6ebdfb (D40) | server `clubs.test` members see the invite and cannot renew it; the members row fits a phone (825bc76) |
| FR15 | should | Demo note quoting chapter VI pinned in chapter VII | fixed c6ebdfb | seeded quotes are found in the text and pinned to their own words |
| FR16 | should | Small: share sheet cancel says "copied", no 0.5×, tooltip counts, card dot names, skip digits overlap, contents do not mark chapters ahead | fixed (this commit, c6ebdfb for the digits) | each item done as named |
| FR17 | v1 | A book shared by several clubs (`Book.clubIds`) dropped without a recorded decision | fixed (D45) | decision recorded; identical uploads now share storage: server `uploads.test` "keeps a file uploaded twice once" |

### Authorisation and privacy

Two attempts by the default reviewer model were stopped by an automated content filter part way
through; the review was rerun read-only on a second model.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| SA1 | P0 | An EPUB could declare a reading-order file as `text/html;charset=utf-8` (or any type other than exactly `text/html`), skip sanitising, and be served without the no-script CSP; standalone SVG was checked by a regular expression | fixed e3b5912 | epub `edge-cases.test` "decides what each file is served as itself" and "sanitises standalone SVG"; server `media.test` "never serves a file as a type an EPUB declared" and CSP on every book file |
| SA2 | P1 | A removed member could rejoin with the old invite link (and their read ranges came back) | fixed 1404a2b | server `security.test` "someone the owner removed cannot come back with the invite link they had" |
| SA3 | P1 | The audio player and the outbox survived sign-out and could be replayed under the next account on a shared phone | fixed 1404a2b (D44) | e2e `auth.spec` "on a shared phone the next person gets nothing of the last one" |
| SA4 | P1 | Sign-out ignored a failed request and showed the sign-in page while still signed in | fixed e3b5912 | see CQ8 |
| SA5 | P2 | An expired or revoked session left IndexedDB, local storage and the query cache | fixed 1404a2b (D44) | the signed-in area forgets the last person whenever the session ends or changes |
| SA6 | P2 | A revoked session kept its WebSocket | fixed 1404a2b | server `security.test` "closes the live connection of a session that ended" |
| SA7 | P2 | A reset link could be redeemed twice in a race | fixed 1404a2b | server `security.test` "a reset link works once, even when two requests race with it" |
| SA8 | P2 | An owner's reset link could take over a member's account in other clubs | fixed 1404a2b | server `security.test` "only someone who runs every club a member is in can make their reset link" |
| SA9 | P3 | Rate limits: invite accept, password change and reset unlimited; keys include caller-chosen parts | fixed 1404a2b | server `security.test` "failed sign-ins are limited per address whichever emails are tried" |
| SA10 | P3 | Cookie `Secure` only from the request protocol | fixed 1404a2b | server `security.test` "marks the session cookie Secure when the public address is https" |
| SA11 | P3 | Upstream mode: sign-out signs straight back in | justified | In upstream mode Book Club has no identity of its own: like any single sign-on app, while you are signed in to the main site you are signed in here; signing out of the main site signs you out (documented in RUNBOOK) |
| SA12 | P3 | Deleted comments keep their text in the database | fixed 1404a2b | server `security.test` "a deleted note keeps no words on the server" |
| SA13 | P3 | Read spans are self-attested | justified | D12: gating protects friends from accidental spoilers, not from a member who wants to read ahead; anyone can also just read ahead. The UI asks before "I have already read up to here" |
| SA14 | P3 | A far-future client timestamp freezes the saved position | fixed 1404a2b | server `security.test` "a device with a fast clock cannot freeze the saved position" |
| SA15 | P3 | Service worker and IndexedDB leftovers after a wipe | fixed 1404a2b | answers fetched before a wipe are never cached after it; the next person's session starts only after the wipe (D44). A removed member's own offline copies stay on their own device: we cannot reach into it |
| SA16 | P3 | The WebSocket handshake completes before the auth and origin checks | justified | nothing is sent before the checks; the close codes 4001/4003 tell the client to stop retrying, which an HTTP refusal of the upgrade could not |
| SA17 | P3 | Deployment defaults: the demo target seeds published passwords; the first visitor can claim setup | justified | the demo image exists to be tried locally (bound to 127.0.0.1); the `runtime` target seeds nothing, and RUNBOOK says to create the owner with `bookclub create-owner` (or finish setup) before the address is shared |
| SA18 | P3 | A stuck outbox can block sign-out | fixed 1404a2b | "Sign out anyway" appears when reading cannot be sent |

### Bugs found by the new web unit tests

Written as failing tests first, then fixed; the tests now pass.

| # | Finding | Status |
|---|---------|--------|
| WT1 | An outbox report merged in the same millisecond as one being sent was deleted unsent | fixed 7937ce9 (entries carry a revision) |
| WT2 | Invalidating your own moved progress was undone by the cache update right after it | fixed 7937ce9 |
| WT3 | One person's unsent entry could absorb the next person's report for the same edition | fixed 7937ce9 (keyed by person) |
| WT4 | Cancelling while finishing waited to retry still sent one more request | fixed 7937ce9 |
| WT5 | Sign-in followed `/\evil.example`, `/<tab>/…` and `/<newline>/…` paths, which browsers resolve off the site | fixed 7937ce9 |
| WT6 | An upload cancelled before it started resolved as if complete | fixed 7937ce9 |
| WT7 | A page count answered from the cache left an earlier measuring frame in place | fixed 7937ce9 |
| WT8 | Initials split a character outside the BMP (an emoji) in half | fixed 7937ce9 |
| WT9 | Stored settings like `toString` passed as a theme or font | fixed 7937ce9 |


## Round 2 (2026-10-23)

### Authorisation and privacy

A second fresh reviewer re-read the server, the client's session handling and the sanitiser, and
checked that every round-1 fix still holds (it found that SA1 to SA18 do). New findings:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| SA19 | P2 | `TRUST_PROXY=true` trusted every hop, so a client behind the proxy could put any address in `X-Forwarded-For` and walk past the sign-in limits | fixed 93983d9 | `TRUST_PROXY` now lists the proxies (`loopback`, ranges, keywords) and refuses `true` and hop counts (Fastify ignores those); server `auth.test` "behind a trusted proxy, a client cannot choose the address its sign-in attempts count against", `unit.test` "trusts only the proxies it is told about" |
| SA20 | P2 | A note on a passage was released when its first word was read: a quote running onto the next page gave that page away | fixed 93983d9 | `isRevealed` needs the whole passage read (`rangesCover`); server `comments.test` "a note on a passage stays a marker until the whole passage is read, then arrives with the progress"; shared `ranges.test` `rangesCover` |
| SA21 | P2 | Signing someone else in in another tab went unnoticed: the first tab kept the last person's revealed notes on screen and could send their reading under the new session | fixed 93983d9 | pages name their person (`X-Bookclub-User`, `?as=` on beacons) and the server refuses a mismatch (409 `session_changed`); the signed-in area keeps its person per tab and forgets on a storage event or the socket's 4001; IndexedDB lets go when another tab forgets the device; server `auth.test` "a page that names someone other than the session's person"; web `api.test` "whose page it is", `outbox.test` "keeps the report, and stops, when the device's session has become someone else's" |
| SA22 | P3 | The sanitiser checked URL attributes by their literal name, so a made-up XLink prefix (`x:href="javascript:…"`) passed it (the CSP still blocked it) | fixed 93983d9 | URL attributes are checked by local name; prefixes are allowed only for known namespaces, so unknown ones go with their attributes; epub `edge-cases.test` "checks links whatever prefix a book gives XLink" |
| SA23 | P3 | PDF, track and cover responses had no CSP | fixed 93983d9 | `FILE_CSP` (sandboxed, nothing allowed but the browser's own viewer); server `media.test` "every successful media response above carries a CSP" |
| SA24 | P3 | A reset link outlived a password change and newer links, and an owner's link was checked only when it was made | fixed 93983d9 | `repos/resets.ts`; server `security.test` "a reset link stops working once the password is changed, or a newer link is made", "a reset link is checked again when used" |
| SA25 | P3 | A removed member's unfinished upload kept taking bytes | fixed 93983d9 | tus requests check the import and the membership; server `uploads.test` "a member removed from the club cannot go on sending an upload they had started" |
| SA26 | P3 | Raw exception text (a disk error naming the server's paths) was stored as the edition's error and shown to members | fixed 93983d9 | only `IngestError`/`EpubError` reasons are shown, anything else is "This EPUB could not be read." with the details in the log; server `ingest.test` "a failure that is not about the book never shows members the server's paths" |
| SA27 | P3 | Sign-up answers 409 `email_taken`, so an invite holder can learn whether an email has an account | justified | Sign-up needs a club's invite link, which only members share, and is rate-limited per invite and address. The useful answer to a friend who already has an account is "sign in instead"; hiding it would need email verification, and the app sends no mail (D14). |
| SA28 | P3 | Small items: malformed `%` escapes in a path or cookie gave 500s; no `secure_delete`; covers cached without the wipe guard; a failed wipe left the splash screen up; a removed member's progress is kept; a stale schema comment | fixed 93983d9, except one justified | 400s; `PRAGMA secure_delete = ON`; the service worker's cover cache takes the wipe generation; the forget path finishes in `finally`. Kept on purpose: a removed member's own progress row (if they are invited back they find their place, and the notes it reveals are ones they had already read). |

### Acceptance dry run

The first full acceptance run from a fresh clone, against the Docker stack, found
three tests that failed there (in some or all of three runs) and one script defect:

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| DR1 | The script's work directory was never created, so every later step wrote to `/`, and an empty axe count read as zero | fixed 90c0213 | the script stops on a setup failure and reads every number through `num()` |
| DR2 | Offline (WebKit, every run): the reader kept the book offline 2.5 s after the first page and cancelled that when it unmounted; the test left as soon as the cache bucket existed | fixed 1170ffe | `keepOffline` is not cancelled by leaving and drops what it kept if someone else signs in; the reader reports `data-offline`; e2e `offline.spec` "a book left at once after opening is still kept on the device" |
| DR3 | A listener's presence was first sent at the first progress report, 5 s after pressing play (crossformat, Chromium) | fixed 1170ffe | announced when playback starts |
| DR4 | A scrub right after choosing a track was undone by the track's queued start position (crossformat, Chromium) | fixed b7fd8bb | the newest seek clears the queued one |
| DR5 | A page-number test read the numbers before a chapter jump had landed (WebKit) | fixed 1170ffe | the test waits for the new section's first page |

### Product fidelity (rating 8/10)

A second fresh reviewer drove the running app for an hour with 30 scripts (iPhone 15 WebKit,
desktop Chromium, a Pixel 7 for touch), several friends at once. It found that almost every
moment of the brief happens for real, and four things that would break the first evening on a
phone. All are fixed; each fix has a test that would have caught it.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR18 | must | Selecting a passage on an iPhone pushed the reaction menu (and its Note button) off the screen: only its centre was kept inside | fixed 4a70a6e | the menu is measured and kept whole on screen, below the selection on touch screens (where the system's menu is above it); e2e `selection.spec` "the reaction menu is whole on screen wherever the passage is on the line" (first, middle and last word of a line) |
| FR19 | must | Tapping a friend's dot on the club bar showed nothing on touch screens: the tap's emulated hover and focus opened the tip and its click closed it | fixed 4a70a6e | hover and focus that come from a tap are ignored; a tap or click pins the tip, the next closes it; e2e `clubbar.spec` (real taps in WebKit), web `ClubBar.test` |
| FR20 | must | A book read on the very first visit could not open offline: the session was fetched before the service worker took control, and WebKit loads nothing from the service worker into the page-counting frame (sandboxed without `allow-scripts`), so it counted pages forever | fixed 4a70a6e | refetch through the worker on first control; the session falls back to the last answer offline; both frames sandboxed alike (D27); e2e `offline.spec` "a book read on the very first visit opens with no network, without a second visit online"; web `queries.test` `sessionOrSnapshot` |
| FR21 | must | The test cited for the v1 modal lesson (L8) did not re-render the dialog's parent | fixed 4a70a6e | e2e `a11y.spec` "a dialog keeps the field you type in while live updates re-render the page behind it (v1 modal bug)": a friend's progress re-renders the reader while a note is typed key by key |
| FR22 | should | A listener appeared 5 s after pressing play and then moved in 5 s steps | fixed 1170ffe, c5e0d30 | presence is announced on play and every second of playback (progress is still saved every 5 s); e2e `presence.spec` "a listener shows within two seconds of pressing play, and their marker keeps moving" |
| FR23 | should | Someone in exactly one club could not start another (home skips the list) | fixed c5e0d30 | Settings lists your clubs and starts a new one; e2e `clubs.spec` "a member in one club can start another, and can leave a club" |
| FR24 | should | Margin markers were 22 px and sat over the screen's edge on an iPhone (6 px off it in the PDF) | fixed c5e0d30 | 44 px targets in a right margin never narrower than a marker (`pageGeometry`, `MARKER_TARGET`), markers closer than a target merge; PDF markers sit inside the page; web `layout.test` |
| FR25 | should | The PDF header's six controls squeezed the title on a phone | fixed c5e0d30 | zoom and theme moved into one "Zoom and theme" panel; e2e `pdf-pwa-settings.spec` zoom test and "a theme chosen in the PDF reader tints its pages and stays after a reload" |
| FR26 | should | A club's description could not be set anywhere | fixed c5e0d30 | owners edit name and description; a new club can have one; e2e `clubs.spec` "an owner says what the club is about" |
| FR27 | should | "Continue reading" did not say which format | fixed c5e0d30 | "Continue in the PDF" / "Continue reading" / "Continue listening" |
| FR28 | should | The chapter-end card covered the first lines of the new chapter | fixed c5e0d30 | it covers the footer until the next page turn; e2e `moments.spec` checks it is below the page |
| FR29 | should | In the PDF reader, a single note from the club bar opened without going to its passage | fixed c5e0d30 | as in the EPUB reader: a note you may read takes you there (a visit) |
| FR30 | should | Every format row on the owner's book page carried a delete icon and "Chapters" | fixed c5e0d30 | one "More" menu per format (Match to chapters, Delete); e2e `formats.spec` "the owner deletes one format from its menu" |
| FR31 | should | The upload preview cropped square audiobook covers; the "another format of" radios were default blue | fixed c5e0d30 | the whole cover is shown; gold radios |
| FR32 | should | Members had no way to leave a club | fixed c5e0d30 | "About this club" for members, with "Leave"; e2e `clubs.spec` |
| FR33 | should | Small: the back chip said 12 % where the footer said 13 %; offline, the book page showed the last place the server knew; library cards did not show who finished; TRACEABILITY P6 cited the wrong test | fixed c5e0d30 | the chip names the chapter of the page you left and the percentage its footer showed; the book page prefers a newer unsent place on the device; cards say "Finished by …"; P6, P10 and C6 point at the tests that prove them |

## Round 3 (2026-10-23)

### Security of "Continue with the upstream" (D52)

A fresh reviewer read the new sign-in route, the sign-out hold, the token check, the stand-in
issuer and the service worker change, ran the server tests and probed the edges (hostile `next`
and `returnTo` values, cookie parsing, jose's options). No P0 or P1. A full E2E run before the
review had also caught a real race (SA29b, below).

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| SA29 | P2 | Over HTTPS on a subdomain of the upstream's cookie domain (the deployment D52 needs), a sibling subdomain could plant a session cookie of its choosing (`Domain=example.com`), which the server read first | fixed | over HTTPS the session and hold cookies are `__Host-` prefixed (only this host, Secure, path `/`, no Domain), and the plain names are not read there; server `security.test` "over HTTPS, a session cookie without the __Host- prefix (one a sibling subdomain could plant) is not used"; `auth.test` (both HTTPS setups check the prefixed cookie and no other); `scripts/deploy-drill.sh` (cookie `__Host-bc_session`, Secure, WebSocket through the proxy) |
| SA29b | P2 | Signing out could sign an upstream account straight back in: the server closes the page's socket first, and the page's next request, sent before the sign-out's answer had cleared the cookie, carried the ended session and the upstream cookie, so it started a new session (seen in an E2E trace, 1 run in 3) | fixed | ended sessions are remembered until their cookie would expire (`ended_sessions`, migration 005); a request with one gets no session and holds the device; server `upstream.test` "a request already on its way with the session just ended does not sign this device back in", "signing out everywhere keeps every device out…"; `unit.test` "an ended one is told apart from one that expired or never was"; e2e `upstream.spec` (repeated 6 times in both browsers) |
| SA30 | P2 | The token check failed open: issuer and audience were checked only when set, and a token without `exp` never expired, so another token the upstream signs with the same key could pass for a sign-in | fixed | a secret needs `UPSTREAM_JWT_ISSUER` and `UPSTREAM_JWT_AUDIENCE` (the server refuses to start without them) and 32 characters or more (RFC 7518 3.2); `exp` is required; server `unit.test` "refuses a short upstream secret, or one without the issuer and audience it accepts", "refuses a token that never expires" |
| SA31 | P2 | One valid upstream token gave unlimited sessions (every request without a session cookie made one, health checks and files included), and any upstream account holder could start clubs and upload, so invites no longer gated use | fixed | at most 50 live sessions per person (the least used go first); only `/api/` requests start a session from the upstream cookie; an upstream account in no club could not start one until a club let it in (`mayStartClub`; removed by D176 at Cole's request, replaced by a cap of clubs owned per person and an instance-wide monthly Cal budget); server `unit.test` "one person keeps at most 50 live sessions", `upstream.test` "the upstream cookie starts sessions only for the app…" (fails without the fix: checked), "an upstream account in no club cannot start one…"; shared `clubs.test` |
| SA32 | P3 | Any site could navigate a browser to `/api/auth/upstream` and so undo a sign-out (the person's own identity, not an attacker's) | fixed | `Sec-Fetch-Site: cross-site` is sent to the sign-in page instead (the upstream shares the cookie, so it is the same site); server `upstream.test` "another site cannot send a browser here to undo a sign-out" |
| SA33 | P3 | No hold was set when the upstream cookie had expired before signing out, so it signed the device in again when it came back | fixed | the hold is also set for every upstream account; server `upstream.test` "an upstream account signing out after its upstream cookie expired is held all the same; a local account never is" |
| SA34 | P3 | A `next` with characters beyond Latin-1 made the redirect throw (500) | fixed | the Location is built through the URL parser (percent-encoded, escapes kept); server `upstream.test` "a next with characters beyond ASCII is sent on percent-encoded" |
| SA35 | P3 | The stand-in's sign-in and sign-out took posts from any page, so any site could plant a demo upstream account in the developer's browser | fixed | both need the upstream's own page (`Origin`, `Sec-Fetch-Site`); server `upstream.test` "the stand-in signs nobody in from another site's page" |
| SA36 | P3 | An address the upstream marks unverified was taken as the person's, and could block the real owner's sign-up with it | fixed | `emailVerified: false` (or `email_verified: false`) leaves the address out; server `unit.test` "does not take an address the upstream says is unverified" |
| SA37 | P3 | An account deactivated upstream keeps its live sessions here | justified | A session here stands on its own once started (D15); an owner removes the member, and RUNBOOK says so. Checking the upstream on every request would need its cookie on every request, which a session exists to avoid. |

### Code quality and correctness, round 2

A fresh reviewer read everything after 93983d9 (read-along, replies and notifications, long-book
page counting, the deploy kit, the upstream sign-in, the next stop), ran the unit tests and small
scripts against the real code, and applied migrations 003-006 to a populated older database.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| CQ22 | P1 | Open redirect: a `next` with dot segments (`/..//evil.example`) passed the same-app check and resolved to another site in the Location (and in the sign-in page's `next`) | fixed | `appPath` (shared) checks the path again as the URL parser resolves it; server and sign-in page use it; shared `paths.test` "never another site", server `upstream.test` and web `SignInPage.test` with dot segments |
| CQ23 | P1 | The EPUB reader could send progress in an endless loop: the reader page split the comments into threads on every render, so the markers changed every render and, with a note whose quote runs onto the next page still hidden, each render sent an urgent report | fixed | the threads are memoised; the urgent report is sent once per page and set of hidden notes |
| CQ24 | P1 | Deploy kit: on a fresh host Docker creates the backup directory as root, the image runs as `node`, and the loop failed silently forever; the drill did not notice (it made the directory itself, and only printed whether the loop had written) | fixed | the backup service gives the directory to the app's user, then drops to it (`setpriv`); archives are 0600; a failed backup is logged loudly and retried hourly; the service is unhealthy without a recent archive; the drill lets Docker create the directory and asserts the loop's archive, its mode and the service's health |
| CQ25 | P2 | Re-aligning could widen read ranges: a range moved clear of itself became the gap between the two maps (inverted, then swapped by `normalizeRanges`) | fixed | `agreedRanges` drops such ranges; server `unit.test` "keeps what both maps agree was read, and never the gap a far move would open" |
| CQ26 | P2 | The PDF was still downloaded twice: the response was copied after its body had started to be read, which fails (silently), so nothing was cached | fixed | the copy is taken before the body is read |
| CQ27 | P2 | Server-side transcription was lost on a restart, and a recogniser that ignored SIGTERM could stall its queue | fixed | `resumeTranscriptions` at start; SIGKILL after a grace period; the server stops recognisers when it stops; server `readalong.test` (a restart before a transcription finished) |
| CQ28 | P3 | A book change refreshed only the book and the library, not the comments, progress and read-along that lining up an audiobook moves | fixed | `book:changed` also refreshes them; web `realtime.test` |
| CQ29 | P3 | Notes at one place were ordered by their random ids rather than when they were written | fixed | ordered by the note's creation; server `comments.test` "notes at one place come in the order they were written" |
| CQ30 | P3 | With two transcribed audiobooks, the second was lined up against a stale copy of the text's map | fixed | the reference audiobook goes first, and each pair reads the editions afresh |
| CQ31 | P3 | A read-along test wrote scratch files into the source tree (one was committed) | fixed | it writes to a temporary directory; the file is gone |
| CQ32 | P3 | The transcriber's docstring named a command that does not exist, and RUNBOOK's TRANSCRIBE_COMMAND example needs tools the image lacks | fixed | both say what is needed and where |
| CQ33 | P3 | The read-along E2E read the current sentence, then tapped while the audio played on | fixed | it pauses first |

### Authorisation and privacy, round 3

A fresh reviewer read the code added after 93983d9 other than the upstream sign-in (reviewed above):
replies, notifications, read-along, the next stop, the deploy kit and backups, and ran attacks
against the real shared code and Fastify.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| SA38 | P1 | An anonymous 64 MB transcript body was read and parsed before anyone was asked who they were (a few in parallel could exhaust the server's memory) | fixed | who may is checked before the body is read (`preParsing`); transcripts are capped at three million words; server `readalong.test` (broken JSON from anyone but the owner is never parsed: 401 and 403, not 400) |
| SA39 | P1 | A transcript's timings were trusted: one that "heard" the whole book in the last minutes moved notes across the book, and re-aligning could widen read ranges (any member who added an audiobook could upload one) | fixed | only the club owner gives or removes a transcript (as D46 and RUNBOOK said); a track whose sentences leave the chapters the chapter map puts them in is not trusted (`withinChapters`); read ranges never widen (CQ25); shared `forced.test` "does not trust a transcript that hears the whole book in the last minutes of the recording" |
| SA40 | P2 | A note's author read the answers to it wherever their own reading was, so a note planted ahead of its author's reading (through the API) collected friends' answers about a part they had not read, in the book, on the socket and in notifications | fixed | answers open by your reading like everyone's (the app records reading before posting); a reply notification carries its words only for someone who may read them; server `replies.test` "a note placed ahead of its author's reading collects no answers' words for them" |
| SA41 | P2 | The next stop's labels took time quadratic in the number of chapters (60,000 contents entries: 13 s on every library request) | fixed | one sorted pass; shared `meeting.test` "stays fast with a contents list of tens of thousands of entries" |
| SA42 | P3 | Deploy kit: the default backup directory was not ignored by git, archives took the process umask, a root-owned directory failed silently, `BACKUP_KEEP=0` deleted every archive, and the containers kept every capability | fixed | `deploy/backups/` ignored; archives 0600; CQ24; at least one archive kept; `cap_drop: ALL` (with only what each service needs), `no-new-privileges`, a read-only proxy, log rotation |
| SA43 | P3 | Between `up` and `create-owner`, anyone could claim the empty public instance through the browser's setup screen | fixed | the deploy kit sets `WEB_SETUP=false`: the owner comes from the CLI only; server `auth.test` "cannot be claimed from the browser while it has no owner"; the drill checks the 403 |
| SA44 | P3 | Restore moved whatever tar produced into place (links included), and a database-only archive replaced every book's files with nothing | fixed | the unpacked archive may hold only its three entries, only regular files and directories, and every stored file its database lists; server `cli.test` "refuses an archive with links, special files or anything unexpected in it, and one without its files" |
| SA45 | P3 | The recogniser inherited the server's whole environment (its secrets), and a timeout only sent SIGTERM | fixed | it gets PATH, HOME, the locale, TMPDIR, HF_HOME, XDG_CACHE_HOME and `TRANSCRIBE_*` only; SIGKILL after a grace period (CQ27) |
| SA46 | P3 | No quotas on members' writes (replies notify everyone in the conversation; every change to the next stop is broadcast) | justified | Members are a handful of invited friends; every write is checked for membership and validated, sign-in is rate-limited, and an owner removes a member who misbehaves. Quotas would guard against an abuse that the invite-only model already rules out. |

### Product fidelity, round 3 (rating 8/10)

A fresh reviewer drove the reviewer stack for an hour with about 40 scripts (iPhone 15 WebKit and
desktop Chromium, several friends at once) and found that almost every moment of the brief works,
with friends side by side: spoiler gating airtight on every path, presence within 0.3 s, page
numbers stable through font changes and rotation, read-along and format switching on the
sentence. What kept it below 9 was the iPhone. All fixed, each with a test that would have caught it:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR34 | must | On an iPhone the Listen screen had no Play button on screen (the read-along panel above the controls pushed them below the fold), and the controls moved as the narrated sentences changed length; the track list opened out of sight | fixed | the read-along panel follows the controls, the cover is smaller with it, and the track list scrolls into view; e2e `readalong.spec` "Play is on the first screen, and the controls stay put while the narrated sentences change" (393×659) |
| FR35 | must | The chapter-end and next-stop cards broke on an iPhone: their buttons wrapped out of the footer, over the page's last line and off the screen, and the greeting was cut | fixed | the text takes what is left of the row (two lines at most, the short chapter name, a short greeting with the stop's name as its title), the buttons never wrap; e2e `moments.spec` and `meeting.spec` check the card and every button on it lie inside the footer and the screen |
| FR36 | should | The notification panel ran off the left edge on a phone | fixed | on a phone it spans the screen under the bar; e2e `replies.spec` checks it is whole on screen |
| FR37 | should | Following a notification opened the book page at its top when the notes arrived before the book | fixed | it scrolls once both are on the page; e2e `replies.spec` checks the conversation is in view |
| FR38 | should | "Go to passage" on a listener's note sent a reader to the player (and the player ignored the note) | fixed | a note opens in the format you use, at its place; the player opens a linked note and goes to a link's place even while it already plays the book; e2e `crossformat.spec` "a reader tapping Go to passage on a listener's note opens it in the book" |
| FR39 | should | Two friends' colours were nearly the same (teal and blue were slots 2 and 3) | fixed | v1's eight colours reordered so the first four are far apart; shared `constants.test` |
| FR40 | should | Opening the app offline, before the club list had been kept, said "You are not in a club yet" | fixed | everything is fetched again through the service worker once it takes the page (the club list included); offline without the list, the home page says so and lists the books kept on the device; web `HomePage.test` |
| FR41 | should | A single-file M4B audiobook lost its chapters | fixed | chapters marked inside a file become its units: they line up with the book's chapters and the player lists them and goes to each (D54); server `ingest.test`, `unit.test`; web `tracks.test`; e2e `upload.spec` "a single-file audiobook (M4B) keeps the chapters inside it" |
| FR42 | should | One place, two percentages: the footer used the page's end, the marker and the book page its start; a finished book said "99% · finished" | fixed | a page's percentage is where it starts (the page the story ends on is 100%), in both readers and the "Back to" chip; a finished book says so |
| FR43 | should | Small things on a phone: format buttons wrapped raggedly, "Reply" floated in the middle, the "Follow the narrator" chip covered the first line, the club page said "reading" for a listener, a new book's card showed a dot as if someone were reading, War and Peace's author was "graf Leo Tolstoy" | fixed | even rows of format buttons and editions; Reply at the start; the chip sits over the club bar; "listening now" (web `People.test`); members who have not started are faint on the card (web `ClubBar.test`); lower-case titles before Gutenberg author names are dropped (epub `edge-cases.test`) |

### Found by full E2E runs on the Docker stack

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| E1 | Signing out an upstream account could sign it straight back in (the late request after the socket closed) | fixed 3071254 | SA29b above |
| E2 | The PDF offline test reloaded the page while the reader was still keeping the book (a reload stops the page's work), and the reader downloaded the PDF twice | fixed 454c894 | the reader waits for the file's put; the test waits for `data-offline="kept"` like the EPUB test |
| E3 | The folder-upload test reloaded while its long tracks were still being created, so they were rightly created again | fixed 2d2bf93 | the test reloads once the long tracks are under way on the server |
| E4 | Finishing an upload whose content was already stored (shared, D45) could fail for good: the shared blob was chosen, then a book holding it was deleted before the new edition recorded its use (`FOREIGN KEY constraint failed`), and the upload's file had already been moved, so every retry hit `ENOENT` (seen in the server log: two 1 GB tests with the same file, one deleting its book as the other finished) | fixed | choosing what to share and recording the use are one transaction, the files move only after it commits (a failure before leaves the upload ready to finish again), and an upload whose files are gone answers 410 `upload_gone` instead of 500; server `uploads.test` "a book deleted while another with the same file is being finished cannot take the file from it", "an upload whose files have gone answers 410, not a server error" |

## Round 4 (2026-10-24)

### Product fidelity, round 4 (rating 8/10)

A fresh reviewer drove the reviewer stack (rebuilt on d0483b5 with fresh data and the upstream
stand-in) for about seventy minutes with some forty scripts, friends side by side on an iPhone 15
(WebKit) and desktop Chromium. It found the brief's moments working: a note posted ahead of a
friend never reached her by WebSocket, HTTP or screen; presence in 0.05 to 0.4 s; page numbers
stable through reloads and two font steps (201 to 279, no doubling); read-along on the sentence;
offline reading synced 0.5 s after reconnecting; a 275 MB upload resumed at 65 % after a reload;
upstream sign-in in 1.8 s. Two iPhone layout bugs kept it below 9. All fixed, each with a test:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR44 | must | Turning the phone sideways and back left the EPUB reader at the landscape width (lines cut, buttons off screen) until a reload, and each relayout saved the start of that wrong page as your place | fixed | the reader's grid column is `minmax(0, 1fr)`, so the page is measured from the screen again; a relayout keeps your place where it was (it only counts the page as read); e2e `reader-pages.spec` "sideways and back: the page fits the screen again, the same numbers return, and your place stays put"; web `useReadingReport.test` |
| FR45 | must | For the owner, the book page was wider than an iPhone (the format rows with their "More" menu held the hero's grid column open): the gold button was cut and the page slid sideways | fixed | the hero's column is `minmax(0, 1fr)` and a phone lays each edition row out as a grid; e2e `formats.spec` "the book page on a phone › fits the screen, the owner’s format menus and buttons included" (393 px and 375 px wide) |
| FR46 | should | A friend's answer was said only on the club pages: reading or listening, nothing told you | fixed | the toast for a new notification lives with the signed-in pages, the reader and the player included (the bell stays in the club pages' bar); e2e `replies.spec` "an answer reaches you in the reader and in the player too" |
| FR47 | should | The next stop greeted EPUB readers only; in the demo the PDF reader and the listener never saw it | fixed | the PDF reader greets on the page turn past the stop and the player when listening carries you past it (not a seek or a track chosen from the list, judged against the clock: web `arrival.test`); e2e `meeting.spec` "turning the PDF’s page past the stop, and listening past it, greet you as the EPUB does" |
| FR48 | should | "You finished the book" came back on every forward turn around the end (5 times in 9 turns), and a finished book reopened in the Gutenberg licence | fixed | the card comes once per person, book and device, and once more on finishing for real (web `panels.test`); pages after the story never become your place; e2e `moments.spec` "the end is a moment, not a nag" |
| FR49 | should | Square audiobook covers were cut to a 2:3 strip ("he Synthetic T") | fixed | a cover squarer than 4:5 is shown whole on a blurred, darkened copy of itself; the new drawing has its own file, ETag and URL so no browser keeps the old crop; server `unit.test` "shows a square cover … whole", `media.test` |
| FR50 | should | One tap deleted a friend's note for everyone, with no confirmation; Clear on the next stop too | fixed | deleting a note or reply, and clearing the stop, ask first and say who loses what ("Delete Ana’s note for everyone in the club?"); e2e `spoilers.spec` (your note: dismissed, then accepted), `moderation.spec` "the owner removes a friend’s note only after saying yes, told whose it is", `meeting.spec` (Clear) |
| FR51 | should | Opening the book on a second device without reading moved your place back to that device's page start (character 1920 to 1284) | fixed | opening keeps the saved place when its page holds it; e2e `reader-pages.spec` "opening the book on a bigger screen, without reading, leaves your place where the phone had it" |
| FR52 | minor | With the audiobook playing in the reader the phone's footer wrapped with a dangling "·"; the title page's footer said "Last page in chapter" | fixed | on a phone with the player in the footer the chapter page is left out; a one-page section has no "page 1 of 1" |
| FR53 | minor | The 5th and 6th members' colours are close to the 1st and 2nd (sky blue near teal, tangerine near coral) | justified | v1's eight colours are kept (the brief's palette); the first four, a typical club, are far apart (FR39); every colour always comes with the member's name or initial, so colour never carries meaning alone (WCAG 1.4.1) |

### Security, round 4

A fresh reviewer read everything changed after 228337e (audio chapters, cover drawing, finishing
uploads, read-along transcripts, backup and restore, the deploy kit, auth, notifications, the web
app's caches and rendering), ran the server suite and probed the real parsers in memory. No P0.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| SA47 | P1 | A crafted M4B froze the whole server: with chapters asked for, the parser walks the audio's chunk table once per chapter, synchronously (a 3.3 MB file held the event loop 5.4 s; 64 MB would be about 90 s, repeated at every restart) | fixed d18b0ce | audio is read in a worker thread with time limits (chapters only for MP4, 20 s; a plain read 60 s plus 1 s per 256 KB), stopped when over and read again without chapters, failing the edition clearly if even that runs over (D60); a crafted 4 MB file: 7.9 s of blocked event loop before, an 11 ms stall now; server `unit.test` "ingest/audio TrackReader" (with an in-thread control), `ingest.test` "audio files made to cost the server" |
| SA48 | P1 | Chapter and unit counts were uncapped, and placing and matching them was quadratic (400 files × 1000 chapters reachable) | fixed d18b0ce | 500 chapters per file, 2000 units per edition (an audiobook with more is one unit per file; a long contents list drops its deepest levels first), linear placing, title matching bounded at 40,000 pairs; shared `align.test` "thousands of units" (old code still running after 60 s, new about 1 s); server `ingest.test` unit-cap and contents tests |
| SA49 | P1 | ID3 chapter times were read 1000× too small (the parser gives seconds), and an alignment too thin to judge was accepted, so an ordinary MP3 with chapters could place friends' notes far too early on a listener's timeline | fixed d18b0ce | ID3 starts read as seconds, MP4 and Nero chapters scaled by their time scale; the pace check measures both sides and pools short stretches, so the 11-chapters-in-33-seconds case is refused and falls back to a linear map (D61); tests with a real MP3 carrying ID3 chapters, a Nero-only M4B, four new shared `align.test` cases and server `ingest.test` "squeezed" |
| SA50 | P2 | Covers inside files (audio tags, EPUBs) reached the image library unchecked (it also decodes SVG, TIFF, HEIF) | fixed d18b0ce | every cover must be JPEG, PNG, GIF or WebP by its bytes and by what the image library detects; server `unit.test` (SVG and TIFF refused), `ingest.test` (an SVG cover in an EPUB and in an MP3 tag gives no cover; the PNG one does) |
| SA51 | P2 | Titles, artists and albums from tags were kept whole (a 5.6 MB title was returned with every book) | fixed d18b0ce | `ingest/text.ts` `cleanTitle`: held to the book title and author limits, cut without splitting a character; applied to tags, chapter titles, EPUB and PDF contents and the EPUB's own title, author and language; server `unit.test` |
| SA52 | P2 | A cover file was read whole into memory, and could be declared up to 4 GiB | fixed d18b0ce | 32 MB at most, declared (schema) and real (checked before reading); the upload form leaves a bigger folder image out (48fd271, web `metadata.test`) |
| SA53 | P3 | Control characters in a title or author broke its drawn cover (500) | fixed d18b0ce | characters XML forbids are dropped before drawing; server `unit.test`, and the cover answers 200 over HTTP |
| SA54 | P3 | The backup service lacked no-new-privileges; the documented backup and restore commands ran as root and would fail on the app's private directories | fixed 959edf4 | `security_opt` on `backup`; DEPLOY.md runs them as the app's user with `umask 077`; the drill asserts `NoNewPrivs: 1` and the backup loop's user (drill passed) |
| SA55 | P3 | Any file error while finishing an upload became 410 "start again", unlogged | fixed d18b0ce | only a missing file is 410; anything else is a logged 500 and the upload can still be finished; server `uploads.test` (EIO) |
| SA56 | P3 | Membership was not checked again when an upload's book is created | fixed d18b0ce | checked again inside the finishing transaction; server `uploads.test` (a removal during measuring) |
| SA57 | P3 | Invite codes and reset tokens in addresses reached the request log | fixed 959edf4 | a request serializer redacts `/join/`, `/reset/`, `/api/invites/` and a `next=` carrying them, encoded or not; server `logs.test` (with a control: the old serializer leaked the code) |
| SA58 | P3 | Control and bidi characters in chapter titles from files | fixed d18b0ce | `cleanTitle` (SA51) |
| SA59 | P3 | With TRANSCRIBE_COMMAND set, members' audio feeds the recogniser with no memory limit, and its queue was replayed at every start | fixed 959edf4 (queue) / justified (memory) | one recogniser at a time, each audiobook queued once, two runs at most across restarts, its whole process group stopped at shutdown and timeout, its output refused over 64 MiB. Memory is the owner's to bound: they choose the recogniser and model (small.en needs about 1 GB, large models several), a limit set by the server would break legitimate runs, and the command can be wrapped (`prlimit`, `systemd-run -p MemoryMax=`) or the container limited (RUNBOOK) |

### Code quality and correctness, round 3

A fresh reviewer read the commits after 228337e and ran every unit suite, typecheck and lint.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| CQ34 | P1 | A file with chapters of its own (an M4B) holds several units, but each track took the chapter of the unit with its file's index, so the player named the wrong chapter and ended the wrong one | fixed 3182709 | tracks take the unit they start with (server `tracks.test`); the player's title, lock-screen metadata and chapter-end card follow the unit playing, and a chapter heard to its end inside a file has its card (web `tracks.test`, `arrival.test`; e2e `upload.spec` "a single-file audiobook (M4B)… names the one playing and ends each") |
| CQ35 | P2 | ID3 chapter times 1000× too small (SA49) | fixed d18b0ce | SA49 |
| CQ36 | P2 | The reader's urgent report (a friend's hidden note on the page) and opening a note saved the page's start, undoing a kept place; a relayout while the narrator turned the pages saved the last page turned by hand | fixed 3182709 | both report the place kept on the page; a relayout while following the narrator is not reading by hand; e2e `reader-pages.spec` "opening the book on a bigger screen…" now with a friend's hidden note on the laptop's page |
| CQ37 | P2 | Shutting down waited for every queued transcription (hours) | fixed 959edf4 | server `readalong.test` "stops at once with transcriptions queued" (timed out at 30 s before) |
| CQ38 | P2 | A restart undid the owner removing a transcript, and re-ran a failing one at every start | fixed 959edf4 | migration 007 `transcriptions`; server `readalong.test` "never transcribes … once its owner removed the transcript", "runs a recogniser that failed once more at a later start, and then no more" |
| CQ39 | P2 | The phone layout sweep could not fail inside anything that scrolls (dialogs, panels, the player) | fixed 3182709 | it now checks nothing scrolling up and down is wider inside than its box (the strips meant to scroll sideways excepted), with a second control inside a dialog; e2e `layout.spec` |
| CQ40 | P2 | Cancelling while an upload was being finished could still produce a book | fixed d18b0ce | the status is checked again inside the transaction and only an import still uploading changes status; server `uploads.test` (a deterministic cancel race), `unit.test` |
| CQ41 | P3 | `.catch(lost)` hid real file errors (SA55) | fixed d18b0ce | SA55 |
| CQ42 | P3 | The home page said "You are offline" for any error, and with the app's own query client stayed blank offline while its next try waited | fixed 3182709 | offline is said at once; a server failure is said as one, with Try again; web `HomePage.test` (with the app's client) |
| CQ43 | P3 | Orphan cleanup could delete a blob a finishing upload had just shared, and its unhandled rejection could end the process | fixed d18b0ce | each delete is one statement that deletes only what is still unreferenced; the cleanup never rejects (it logs); server `unit.test` |
| CQ44 | P3 | `retime`'s doc comment sat above another function | fixed 959edf4 | moved back |
| CQ45 | P3 | Weak test assertions: "the note stays" checked right after dismissing; "no second card" checked before the reader had its answer | fixed 3182709 | the dismissals count the delete requests (exactly one); the reader shows `data-end-checks`, which the test waits for |
| CQ46 | P3 | A manual alignment was capped at 400 entries, which now counts units | fixed d18b0ce | capped at the 2000 units an edition may have (2000 accepted, 2001 refused) |

## Round 5 (2026-10-24)

### Product fidelity, round 5 (rating 8.5/10)

A fresh reviewer drove a fresh reviewer stack (d8d5fef) for about seventy minutes, friends on an
iPhone 15 (WebKit) and desktop Chromium, and added members and books through the app. Markers moved
on another screen in 6 to 28 ms; a note ahead of a friend never reached her by screen, HTTP or
WebSocket; War and Peace opened in 0.8 s; an 82 MB upload cut off at 40 % carried on. One must-fix:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR54 | must | One tap in the contents moved your place for good (a listener's too), with no way back, and showed friends a place you were not reading | fixed f944d0a | a chapter from the contents is a look (D41, D58): a "Back to" chip, your place and the audiobook's stay, friends see you where you read, and reading on makes it your place, counting the page looked at; Back returns to the very character; e2e `visits.spec` "a chapter from the contents is a look: the place stays (a listener’s too), friends still see you there, Back returns, and reading on moves it" (EPUB) and `pdf-pwa-settings.spec` (PDF, reading on) |
| FR55 | should | With seven members the club page slid sideways on an iPhone: the hidden labels of members scrolled out of the strip escaped it | fixed f944d0a | the strip is positioned, and fades out where more members are; e2e `layout.spec` "a club of seven still fits…" |
| FR56 | should | Bringing a format the club already has made a second book, silently | fixed f944d0a | the dialog says the club has it, links to it, and makes a separate book only when asked; e2e `upload.spec` "bringing a format the club already has says so…" |
| FR57 | should | Reopened at a larger font, two sizes down landed one page early | fixed f944d0a | opening anchors relayouts on the place asked for, not the page's first letter; e2e `reader-pages.spec` "reopened at a larger font, going back down returns to the very page it was on" |
| FR58 | should | On its side, the player's Play button was below the fold | fixed f944d0a | on short landscape screens the cover sits beside the controls; e2e `layout.spec` "on its side, the player keeps Play on the first screen, and fits" (734×343, 667×375) |
| FR59 | should | A first offline launch, before the club list was ever kept, was blank for about 3 s | fixed 3182709 | the home page says offline at the first failure; e2e `offline.spec` "opened offline before the club list was ever kept…" |
| FR60 | minor | "the pdf of"; the finished card counted friends who never started as still reading; "Reset link" offered for upstream members (then refused); the note sheet's Delete floated in the middle | fixed f944d0a, 48fd271 | "the PDF of"; web `panels.test` "who has the ending still to come"; e2e `moments.spec` "finishing the book is celebrated…" (one reading, one not started); members carry how they sign in, and an upstream member's row says "Signs in with the upstream" instead of offering a reset link (e2e `upstream.spec` "a friend with an upstream account joins…"); the sheet's actions sit in a row at the start |

## Round 6 (2026-10-24)

### Product fidelity, round 6 (rating 7.5/10)

A fresh reviewer drove a fresh reviewer stack (75fb53a) for about seventy minutes with some fifty
scripts, friends on an iPhone 15 (WebKit) and desktop Chromium, and built a club of its own from
real uploads (no transcript). Presence moved on another screen in 6 to 35 ms; same-format notes
opened on exactly the right page; War and Peace reopened at its page in 0.9 s; an 82 MB upload
paused on a dropped connection and resumed itself. Two must-fixes, both in the brief's "must never
happen":

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR61 | must | Flipping back to find a passage lost your place: after a chapter from the contents, one page turn there, or a reaction there, made that page your place | fixed cc21528 | a look ends only where reading takes over (D62): ahead of your place a page turn, or a note opened or written there, reads on; behind it only reading forward through your place does, or "Read from here"; Back and Read from here sit on the club bar; e2e `visits.spec` "flipping back to find a passage never loses your place: paging there, or reacting there, keeps it, and Back returns", "paging on from a visit behind your place keeps it; Read from here makes it your place" |
| FR62 | must | On a club's own audiobook (lined up by chapters only) a listener was shown readers' notes 8 to 22 s before the narrator reached them | fixed ecdc581, cb0023c | reading is kept per edition (migration 008); within the note's edition it opens exactly, from another only once every place it may really be has been read (60 s of a chapter-aligned audiobook, one PDF page, 2,000 characters between EPUBs; none under a trusted forced alignment; D63), for lists, pushes, replies and notifications; the player tells of a note as it opens, never of a closed one; server `crossformat.test` (19 tests over HTTP and WebSocket: the bug reproduced, the margin's edges at +59 s and +61 s, a reader's and a listener's notes both ways, PDF and EPUB, old progress), 14 gate tests in `unit.test` |
| FR63 | should | A group of notes on the club bar showed the first note's emoji with the total ("🤯 2" for a 🤯 and a 😂) | fixed 8c24fee | each reaction with how many, the two most frequent and "+N" (v1's "😱2 😢1"), named for a screen reader; web `ClubBar.test` "reactionTally", "gathers notes too close to tap one by one…" |
| FR64 | should | A listener's presence vanished when the phone locked | fixed 8c24fee | playing with the page hidden is still listening: presence stays and the place moves; a hidden reader still goes idle; web `realtime.test` "stays listening with the page hidden while the audiobook plays" |
| FR65 | should | Reading along existed only in the demo; an audiobook uploaded before its EPUB kept "Chapter 1…12" | fixed 5af3675, e0caa16 | the owner adds (or removes) a transcript from the audiobook's menu on the book page, its details say "reads along"; the README says what reading along needs; e2e `readalong.spec` "from the book page: it reads along, and can stop again". Chapters known only by number ("Chapter 7", "Track 07", a file name) learn the real names a later edition's alignment pairs with them, nothing moving; server `chapter-names.test`, `ingest.test` "a book whose first format names its chapters only by number" |
| FR66 | should | Offline, pages turned just before the app closed were lost (it reopened five pages back, and the server never heard of them) | fixed 4d11c51 | a closing page keeps its progress synchronously on the device; the next start sends it, and the book reopens there before that; web `outbox.test` "progress kept as a page closes"; e2e `offline.spec` "pages turned quickly offline, then the app closed at once…" |
| FR67 | minor | The Back chip covered a line of text; the gold button's icon shrank to a dot; "12 tracks…" was cut; the join form said "at least 10 characters" twice; opening the PDF moved the place to its page's top (8 % to 7 %) | fixed cc21528, cb0023c, 7da7ddf | the chip is on the club bar; icons never shrink; details wrap; a field's error takes its hint's place (web `Form.test`); the PDF keeps the place it opened at until a page is turned (e2e `pdf-pwa-settings.spec` "opened at a place inside a page…") |

### Code quality and correctness, round 4

A fresh reviewer read the commits after fc66861 (the round-5 and round-6 work, the ingest worker,
the recogniser's lifecycle, the cross-format gate) and ran every suite, typecheck and lint; two
findings were confirmed by running the real code in scripts outside the repository.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| CQ47 | P2 | Reading from before migration 008 was not narrowed by the note's own edition, so after a transcript refined that edition, a note in it could open early for that old reading (by up to the chapter map's error) | fixed 2195d9a | old reading is narrowed by the note's own edition's chapter margin too once a forced alignment has refined it; server `unit.test` "counts for nothing in reading from before ranges were kept per edition…" (a note in the refined audiobook) |
| CQ48 | P2 | Adopting progress a closing page kept could put an older place over a newer one on the device, and then on the server | fixed 2195d9a | a place is stored only over an older one; web `outbox.test` "never puts an older place over a newer one…" |
| CQ49 | P2 | Deleting a format deleted its readers' reading in it, closing again the notes it had opened | fixed 2195d9a | before the edition goes, its reading is kept as reading in a format no longer known (through its map, counted with the margins of D63); server `unit.test` "keeps what was read in an edition that is deleted as read…" |
| CQ50 | P3 | The hourly sweep could discard the files of an import a finish had just taken | fixed 2195d9a | only an import it moved to cancelled is discarded |
| CQ51 | P3 | Transcript actions were offered to whoever added the book, but only the club owner may use them; a stored transcript that lined nothing up could not be removed from the page | fixed 2195d9a (owner) / justified | the actions are the owner's; a new transcript replaces a stored one, which covers the case that one lined nothing up |
| CQ52 | P3 | A look in the PDF returned to the top of the page, not the line | fixed 2195d9a | Back restores the place within the page, which friends see during the look |
| CQ53 | P3 | Wall-clock thresholds in unit tests (the worker's event loop stays free; placing units is linear) could flake on a loaded machine | justified | each asserts the property it names with wide headroom (a stall under 250 ms where the work it moves off the thread takes seconds; linear time under 1 and 3 s where the old code took minutes), and the in-thread control proves it can fail; they passed in the acceptance script's coverage run with three reviewers and the E2E suite loading the box |
| CQ54 | P3 | Four doc comments sat above the wrong declarations | fixed 2195d9a | moved back |

## Round 7 (2026-10-24)

### Security, round 5

A fresh security reviewer read the commits after fc66861 and probed the real app and the spoiler
gate with scripts outside the repository (no P0). Two follow-ups came from the fixes' own reports:
SA73 (the remaining linear EPUB parsing on the main thread) and SA74.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| SA60 | P1 | Any member can start a club and, as its owner, upload a 64 MB transcript that was parsed and aligned on the server's thread: a 50 MB one stalled every club 23.8 s at 1.9 GB of heap | fixed 5fef0e7 | transcripts are parsed in one worker (30 s, 512 MB) and aligned in another (60 s, 768 MB) (D67); before the body is read: owner only, Content-Length (411), 32 MiB and eight words a second of the measured audio plus 10,000 (413), two at once (503), ten an hour (429); a transcript over its limits is not retried; queued jobs of one name are replaced; server `readalong-limits.test` (12 tests: 413/411 from headers alone, the word cap at and over it, a 10 MB transcript with the event loop under 250 ms, time and memory limits, rate limit, the gate, job dedupe) |
| SA61 | P1 | For every contents entry that did not resolve, the EPUB reader scanned every section, on the main thread: 50,000 dangling entries over 1,000 sections took 15 s | fixed d6777c2, dfaef79 | entries are found through maps built once and capped at 10,000 (D68), and the whole EPUB is read in a worker against the clock (D66); `epub` `crafted.test` (23 tests: 10k / 50k dangling entries 0.31 s / 0.80 s; nested NCX, encryption entries, deep documents, backtracking patterns, long spines, whole-archive ratio) |
| SA62 | P2 | Cross-format margins were constants: on half-hour chapters an EPUB note opened 119 to 209 s before the narrator reached it | fixed 48dbdad | the margin is at least a tenth of the chapter around the place (D63); server `unit.test` "widens the margin to a tenth of the chapter…", which fails with the share at zero; the reviewer's 60k random pairs had no early opens within the margins |
| SA63 | P2 | Whoever added a format could line it up with the book by hand (or by its own tags) so that listeners of its first tracks opened later chapters' notes | fixed 48dbdad (by hand) / justified (tags) | lining up by hand is the club owner's alone (server `ingest.test`); tags can at most shift a format by the chapter its numbers name, the pace check still applies, the owner can correct it by hand, and the uploader is a member who could as well write the spoiler in a note |
| SA64 | P2 | An uncapped contents list reached every reader, and the reader recounted each entry's page on every render (9.7 s a render at 20,000 entries) | fixed 48dbdad, d6777c2 | contents are capped at 10,000 entries when the EPUB is read (D68), and the reader works out every entry's page in one pass, once per count (web `pagecount.test`) |
| SA65 | P3 | Reading ranges are unbounded and the gate scans them linearly: 44,800 crafted ranges took GET comments from 51 to 427 ms | justified | only the member's own requests slow down (the gate reads the viewer's own reading), real reading stays in tens of ranges because touching ranges merge, and every request is still answered |
| SA66 | P3 | The audio worker bounds only its JS heap and its wall time; tag and picture buffers sit outside the heap limit | justified | the buffers are bounded by the file, which is bounded by the upload limit; the time budget (D60) stops a slow read; one edition is read at a time |
| SA67 | P3 | Every member is told how each member signs in (`source`) | justified | in a club of friends whether someone came through the upstream is not a secret, and the members list shows it so that the owner can tell accounts apart |
| SA68 | P3 | A file's original name went into the edition's error unclean (bidirectional marks got through) | fixed 48dbdad | names are cleaned of control and bidirectional characters as they are stored (server `ingest.test`) |
| SA69 | P3 | Reading spans are the reader's own claim: one request can cover the whole book and notify every note's author | justified | the server cannot know what anyone read; the same is offered openly as "I've already read up to here" (with a confirmation), and a member who wants to spoil themselves only spoils themselves |
| SA70 | P3 | The recogniser's timeout trusts the audio file's own duration | justified | the recogniser is opt-in (`TRANSCRIBE_COMMAND`), one runs at a time, each audiobook gets two runs at most, and its process group is stopped at the timeout and at shutdown (D59) |
| SA71 | P3 | No upload quota beyond being a member: partial uploads can fill the disk | justified | uploads come only from invited members of a club; an unfinished upload is dropped after `UPLOAD_EXPIRY_HOURS` (a week), checked hourly; identical files are stored once (RUNBOOK, Disk) |
| SA72 | P3 | Deleting a format deleted everyone's reading in it, re-hiding the notes it had opened | fixed 2195d9a | the format's reading is kept as reading of a format no longer known (CQ49) |
| SA73 | P2 | Even linear, an EPUB was still parsed and sanitised on the server's thread: crafted markup costs about a second per MiB and an archive may unpack 200-fold, so a 100 KiB upload could hold every request for 8 to 17 s | fixed dfaef79 | EPUBs are read in a worker thread (a minute plus a second per MB, 1 GB) (D66); server `ingest.test` "EPUBs made to cost the server": a book that holds the event loop 985 ms inline leaves it under 250 ms, and one over its time fails with a plain message |
| SA74 | P3 | Two transcript uploads held open keep others at "busy" (503) for as long as they hang | fixed 806bdfd | first justified by Node's 300 s request timeout, which Fastify turns off (SA76): requests now have ten minutes, a transcript's body its own deadline, and one place per user (D71) |

### Product fidelity, round 7 (rating 8/10)

A fresh reviewer drove the stack on 2a7a200 with about 50 scripts, as friends on iPhone 15 WebKit
and desktop Chromium side by side, and brought a book of their own (Peter Pan from Gutenberg with
its 17-track LibriVox recording). Presence moved in milliseconds, no note reached anyone ahead by
screen, HTTP, WebSocket or bell, page numbers went 201 → 236 → 279 → 201 across font sizes with the
passage on screen, a 418 MB upload survived a cut connection, and the upstream sign-in worked end to end. Two
must-fixes:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR68 | must | A listener who paused and played on never met readers' notes near the pause: WebKit resumed 3 ms past it, the two stretches were kept apart, and the margin was taken off both ends of each | fixed 832f831 | pieces of listening within two seconds join, as saved and as the gate reads older reading (D65); server `unit.test` "takes listening paused and played on again for one stretch heard…" (fails with the join at zero; a 30 s skip still leaves a gap) |
| FR69 | must | In the PDF on a phone the reaction menu ran off the screen: ❤️ half cut, 🤯 and Note out of reach | fixed 9a2e2d2 | the PDF uses the EPUB reader's measured menu; E2E `selection.spec` "in the PDF on a small phone too…" (every button inside 375 px at the left, middle and right of a line, and a reaction pinned from it), which fails on the old build |
| FR70 | should | In the PDF a tap that turned the page also opened a friend's note the new page had under the finger | fixed 9a2e2d2 | the click that follows a page-turning tap is swallowed; E2E `touch.spec` "a tap that turns the PDF page does not also open a note…" (fails on the old build) |
| FR71 | should | Club-bar group pills (65 to 83 px) overlapped single markers by 4 to 17 px, so a tap on one opened its neighbour | fixed 9a2e2d2 | groups are laid out by how wide each is drawn, and a widened group is checked again against the one before (D31); web `ClubBar.test` (any width, any input: never overlapping); E2E `layout.spec` "the club bar…never cover each other" in both engines (fails on the old build) |
| FR72 | should | "A little late" was more than a minute: 71 s measured, and a tenth of a 20-minute chapter is two | justified, docs | spoilers are what must never happen (the original brief), so the margin stays as large as the chapter map's error can be; D63 and ARCHITECTURE now say "a minute or two, at most a tenth of the chapter, exact with a transcript"; a bundled recogniser was weighed and rejected (D63) |
| FR73 | should | The gold button was clipped at 375 px ("Continue in the PDF") | fixed 9a2e2d2 | on a phone it takes its own row; the layout check now flags any button whose label is wider than it (E2E `layout.spec`, with a self-test) |
| FR74 | should | On a computer the next-stop and chapter-end card covered the page arrows; the finished card let the arrow keys page the book behind it | fixed 9a2e2d2 | the card sits between the arrows at 600 px and wider (E2E `expectInFooter` clicks them); page keys stand aside while a dialog is open (web `view.test`) |
| FR75 | should | On iOS the lock screen would likely show chapter tracks instead of the skips an audiobook wants | fixed 509fb9e | on iPhone and iPad the skips, chapters in the app (D64); web `media.test`; E2E `audio.spec` asserts each engine's handlers |
| FR76 | should | The speed and sleep menus looked unfinished in WebKit (a pill inside a square box) | fixed 9a2e2d2 | every select has the app's box and chevron in every engine |
| FR77 | should | Offline, your own status still said "online" beside the header's "Offline" | fixed 9a2e2d2 | the socket is let go as the browser goes offline, presence is forgotten, and your status says offline (web `realtime.test`, `People.test`) |
| FR78 | should | The book page said 8 % where the reader's footer said 7 % for the same place | fixed 9a2e2d2 | the footer shows your place's percentage, as saved, also when the place was kept inside the page |

### Acceptance dry run 5 (2026-10-24, from a fresh clone)

Every E2E run passed (3 runs × 2 projects: 142 and 140 distinct tests, 0 failed, skipped or flaky),
with axe, Lighthouse, typecheck, lint and the documents; the unit stage did not:

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| DR6 | Five of the crafted-EPUB tests held fixed millisecond limits, which coverage (2.3 times slower) broke, and the recursive test run then stopped before the server suite | fixed f20be79 | the limits grow with the pace measured at the start when the machine is slower than idle, never shrinking below their idle values; every package's tests run even when one fails; `pnpm test:coverage`: 1572 passed, server 98.36 %, shared 91.83 % |


## Round 8 (2026-10-24)

### Code quality and security, round 6

A fresh reviewer read the commits after 2195d9a and ran probes outside the repository (no P0 or
P1; three P2s reproduced by running code).

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| SA75 | P2 | Closing tags that match nothing open are never reported to the DOM builder, yet each costs a scan of the parser's stack: a 91 KB EPUB took 15.6 s and a 561 KB one held the job queue 61 s | fixed 70c18cc | closing tags are counted before a document is parsed, every document of a book shares a budget of five million nodes, attributes and closing tags, and the worker's floor is 20 s; `epub` `crafted.test` "closing tags that match nothing open", "a book of many documents" |
| SA76 | P2 | Fastify never times a request out, so two transcript uploads that sent a byte and waited kept every other upload out (503) indefinitely; SA74's justification was wrong | fixed 806bdfd | requests have ten minutes to come in, a transcript's body max(60 s, its length at 64 KiB/s) and is then cut off with 408, one place per user, a place given back exactly once (also when the client hangs up during sign-in) (D71); server `readalong-limits.test` (deadline, floor, the slot passed on, one user cannot hold both, the hang-up case) |
| SA77 | P2 | The EPUB worker's heap limit does not bound buffers: a 22 MiB EPUB unpacking to 1000 MiB peaked at 3.25 GiB; a file that OOM-kills the server would be read again at every boot | fixed 70c18cc | a book unpacks to at most 512 MiB and a larger file is refused before any worker starts; the file is read without a second copy and its files handed over, not cloned; an edition that stopped the server three starts running is put aside (migration 009); server `ingest.test` "one larger than all a book may unpack to…", "…put aside, not read for ever" |
| CQ55 | P3 | The log lost which limit stopped a book | fixed 70c18cc | the cause is logged beside the members' words |
| CQ56 | P3 | Alignment after a transcription ran outside the deduped queue and could overlap a queued one | fixed 806bdfd | it is queued as `align:<book>` and awaited; server `readalong.test` (one run where there were two) |
| CQ57 | P3 | A one-off time limit deleted a good read-along until the transcript or text changed | fixed 806bdfd | the read-along is kept and tried once more 30 minutes later; a second hit stops (SA60 still holds) |
| CQ58 | P3 | The first read-along request parsed every stored section on the main thread | fixed 806bdfd | section texts are cached per server (32 M characters, least recently read evicted); War and Peace parses in 42 to 54 ms |
| CQ59 | P3 | Dead code (`findPath`, `LoadedText.publication`), a copy of `keepShallowest`, a doc comment above the wrong function, reconnect tries while offline, comments overstating the worker's memory bound | fixed 70c18cc, 806bdfd | removed or reused; comments now say the heap is bounded and buffers by the EPUB's own limits |

### Product fidelity, round 8 (rating 8/10)

A fresh reviewer drove the stack on 509fb9e as several friends in WebKit iPhone 15 and desktop
Chromium. Spoiler gating held on every path but one, presence showed in 0.57 s and a moving marker
in 0.8 s, page numbers went 201 → 279 with the passage on screen, switching formats started on the
page's sentence, a 160 MB upload resumed at 91 MB after the page closed, and a cold offline start
read six pages and synced 12 ms after reconnecting. Three must-fixes:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR79 | must | A second device rolled your place back: a phone left open at page 104 while the laptop read on saved page 104 again at its next tap, and the marker went back for everyone | fixed f16034d, 912cf8a | a place saved elsewhere is your place here: the reader keeps the page as a look with "Continue at …" and "Stay here", a paused player moves there (D70); web `elsewhere.test`; E2E `devices.spec` (no rollback from a page turned here, Continue, Stay here, and no false alarm from this device's own pages), both engines |
| FR80 | must | A faster reader's reply under an earlier note reached slower friends in full, and its author in a toast | fixed cb2de4d, adcef1e | a note or reply also waits for where its writer had read to, judged by the same gate (D69); server `replies.test`, `comments.test`, `unit.test`; web `Thread.test`, `Notifications.test`, `panels.test`; E2E `replies.spec` (a held reply live without its words, opening once read there; a look-back note) |
| FR82 | should | The tip naming who is at a marker ran off the screen for the friend furthest ahead | fixed 31bcc31 | the tip is measured and held inside the bar; a long one wraps |
| FR83 | should | The members' strip said "reading" but not where, except in a hover tip | fixed 31bcc31 | the chapter shows under each reader, and the book once the club has more than one; web `People.test` |
| FR84 | should | A reaction made with no network was lost | fixed 7f1c213 | kept on the device and pinned once back online, each with its client id; web `pending-notes.test`; E2E `offline.spec` "a note written with no network is kept…" |
| FR85 | should | War and Peace's 384 chapters drew a grey barcode on the bar; the footer wrapped while pages were counted | fixed 31bcc31 | ticks closer than 6 px are drawn as one (web `ClubBar.test`); the footer keeps to one line while counting |
| FR86 | should | A friend who had finished showed "Chapter 12 · 99%" | fixed 31bcc31 | "Finished" on bars, tips and lists (web `ClubBar.test` "where a member is, in words") |
| FR87 | should | A listener 17 s into CHAPTER IV's track was "Chapter 3 · 22%" (the recording's announcement comes before the chapter's words) | fixed ce48b63 | a place before a chapter's words at the start of its own track is named by that chapter, in the player, presence and saved places; shared `chapters.test`, server `labels.test` |
| FR88 | should | Reading along works out of the box only for the demo audiobook | justified | a club audiobook reads along once its owner adds a transcript from the book page, or with the server's recogniser (`TRANSCRIBE_COMMAND`); bundling one was weighed and rejected (D63), and without it notes still never open early |
| FR81 | must | In the PDF, selecting text pinned and quoted the wrong words (a drag over "me! _I'll_ soon" quoted "n, all"): the invisible text layer had none of pdf.js 6.4's rules, so its spans were 16 px and unscaled, 585 px wide over 261 px of print | fixed d8d5ba9 | the reader sets pdf.js's scale and app.css carries its text-layer rules: every line within 0.6 to 3.2 px of its print, fitted and zoomed, in both engines; a drag past a line's end stays on it; E2E `selection.spec` "the PDF selects what is printed" (line geometry; real mouse drags and a double-click quoting the words under the pointer; an overshoot), which fails on the old build |
| FR89 | should | The demo PDF showed Gutenberg's italic marks as underscores | fixed 6bb5e1d | set in italics: the same 91 pages and chapter starts, no underscore left |

## Round 9 (2026-10-24)

### Product fidelity, round 9 (rating 8.5/10)

A fresh reviewer drove the stack on 72641e8 with about 40 scripts, as up to three friends in
WebKit iPhone 15 and desktop Chromium, two of them new through the upstream, and brought books of their
own (Wilde's *The Happy Prince* with its five LibriVox tracks, and War and Peace). No spoiler
reached a slower friend by screen, API, WebSocket or bell; presence showed in 31 ms and a moving
marker in 11 ms; page numbers held across font sizes and reloads; a second device never rolled a
place back; a reaction made offline was pinned later. One must-fix:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR90 | should | An answer from a faster friend was held with nothing said to its writer, and opened later without a word | fixed 9660c65 | its writer is told under it where friends must have read to, and the friend it waited for is told as it opens; server `replies.test`, web `Thread.test`, `queries.test` |
| FR91 | should | The demo PDF ran 97 words together after its italics ("veryremarkable") | fixed c19ce93 | each italic run ends with its space; pdf.js reading all 91 pages finds no word missing from the book |
| FR93 | should | An audiobook's LibriVox tags became "happy_prince_and_other_tales" by "wilde_o"; adding a format showed Title and Author fields that do nothing | fixed ddf7a8f | slug tags read as words ("O. Wilde"); a format added to a book asks no title; web `metadata.test` |
| FR94 | minor | At the next stop, a friend who had finished the book was "here too" | fixed 9f4a3c6 | "Cleo has finished the book" beside the friends at the stop; web `Meeting.test` |
| FR97 | should | Front matter (the edition's title page, the Contents) counts as chapters | justified | they are part of the book as printed and as its own contents list it, and a new reader opens where the book begins, as a paper copy or Apple Books does; the club's labels and next stop are by the story's chapters |
| FR98 | should | Reading along needs a transcript for a club's own audiobook, and a cue arriving a minute late still says "here" | justified | as FR88 (D63): the owner adds one from the book page, or the server's recogniser; without it notes never open early |
| FR99 | minor | Club-bar targets are 26 px against INTENT's 44 px; at 320 px the footer wraps; in landscape a phone shows about six lines | fixed 6fcde66 (INTENT) / justified | the bar's targets are 26 px by design, grouping when they would overlap (D31; WCAG 2.5.8 asks 24), and INTENT says so now; 320 px is the first iPhone SE, below the 375 px the layout checks hold; landscape on a phone is the player's, which keeps Play on the first screen |
| FR95 | should | axe found serious violations once a club looked lived-in: club-bar groups named without their visible "+2" (label-content-name-mismatch), and a members strip of seven that a keyboard could not reach (scrollable-region-focusable); the axe E2E only knew fresh clubs | fixed 4037b32 | a group's name starts with what it shows, members' groups name every face in order; the strip is focusable while it scrolls; E2E `a11y.spec` now checks a club of seven, with groups on the bar, on the library, book page, both readers and the player (10 of 10 failed before) |
| FR92 | must | A peek far ahead through the contents, then one page turn, saved that page as your place (Chapter 1 · 3 % became Chapter 10 · 77 %), moved your marker and counted you at the next stop | fixed 2fe60bf | a look past where you have read becomes reading only after three pages read there, a note, or "Read from here" (D72); web `looks.test`; E2E `visits.spec` (one and two taps keep the place, the third reads there, Read from here, a look behind unchanged, the PDF, an in-book link), all failing on the old build |
| FR96 | should | Tapping a chapter in the player's track list started it and saved that place for everyone | fixed 2fe60bf | the track list is a look, with its Back chip, until Play (D72); E2E `audio.spec` (no saved place before Play) |

## Round 10 (2026-10-24)

### Product fidelity, round 10 (rating 8/10)

A fresh reviewer drove the stack on 852159b with about 36 scripts, as up to four friends in WebKit
iPhone 15 and desktop Chromium, six of them new through the upstream, and uploaded books of their own
(an EPUB 3 of their making, the LibriVox Alice cut into eight and into two parts, a DRM-locked
EPUB). Markers moved on another screen in about 0.6 s, held answers arrived in 66 to 108 ms, page
numbers held across font sizes and reloads, reading and listening offline synced 259 ms after
reconnecting. One must-fix:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR101 | should | "I've already read up to here" said "You read on … on another device" on a single device; its toast counted answers as notes | fixed e979d06 | the place it saves is noted as this device's first (D70); notes and answers counted apart; E2E `devices.spec` "… is this device's own news too" |
| FR102 | should | Opening a friend's note during a peek far ahead (its marker sits where a finger turns the page) ended the look and moved the place | fixed e979d06 | far past where you have read, opening a note keeps the look and the note waits (D72); E2E `visits.spec` "a friend's note opened during a peek far ahead keeps the look" |
| FR103 | should | A DRM-locked EPUB went through the upload's preview and failed only once uploaded | fixed e979d06 | the preview refuses it, saying why, before anything is uploaded; `epub` `edge-cases.test` |
| FR104 | should | Opening a book took two taps (the card, then Continue), where INTENT says one | fixed e979d06 | a book you are reading has "Read on" or "Listen on" on its card, opening where you stopped; E2E `library.spec` "… opens where you stopped in one tap from its card" |
| FR105 | minor | A generated EPUB 3's cover page read "Section page 1 of 1 · 0%" | justified | a cover is a one-page part of the book (its count is right, and the next pages carry on correctly); the reviewer found that book's chapters, fragments and split files counted right |
| FR106 | should | Reading along works out of the box only for the demo audiobook | justified | as FR88 and FR98 (D63) |
| FR100 | must | An audiobook cut into numbered parts ("Part 1"…"Part 8") was matched to chapters I-VIII by its part numbers: its map ended at chapter IX, the trial sat at 63 %, and a reader at chapter IX read a listener's note from the last chapter | fixed 26aabf0 | parts, tracks, discs and volumes are not chapter numbers; a chapter match must reach 0.9 of the book; a refused edition is a straight line that keeps its names, judged with a tenth of the book as its margin, and its owner is told (D73); shared `align.test`, `titles.test`; server `parts.test` (the reviewer's eight and two parts: no early note) |

## Round 11 (2026-10-24)

### Product fidelity, round 11 (rating 8/10)

A fresh reviewer drove the stack on bbad66c with about 40 scripts in WebKit iPhone 15 and desktop
Chromium, five accounts made through the app (by invite, through the upstream, and an outsider), and
files of their own (the LibriVox Alice renamed `01.mp3`…`12.mp3` without tags, the Alice PDF
without bookmarks). Markers moved in 4 to 51 ms, no note ahead reached a slower friend, a new
friend met every note on its page, War and Peace reopened in 0.86 s. Two must-fixes, both from
D73's change the round before:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR108 | should | Answers from a faster friend waited by default, and their writer learned it only after sending | fixed 4c5e183 | the choice is made at Send: "Send" (waits for friends to get as far, explained above it) or "Send, only about this passage"; web `Thread.test` |
| FR109 | should | On an iPhone "Read on" was below the first screen, and a friend's new upload pushed your book further down | fixed 4c5e183, b5fc360 | the books you are reading come first, and a banner at the top opens the one you read last where you stopped; web `LibraryPage.test`; E2E `library.spec` (the banner in view, one tap into the reader) |
| FR110 | should | On a phone the next-stop card's names were cut off, and the footer's cards cover the page arrows until dismissed | justified | on a phone pages turn with a tap on the page (the arrows are the computer's, where the card sits between them, FR74); the card goes with the next page turn |
| FR111 | should | A group of notes from the bar was titled by its first note's chapter | fixed 4c5e183 | "Notes · Chapter 1 to Chapter 3" |
| FR112 | should | An EPUB note sits about two paragraphs off its line in the PDF | justified | a note made in another format is placed through the two editions' maps, which are chapter-accurate (D63); its page is right, and the sheet shows its quote |
| FR113 | minor | Landscape reading on a phone shows seven lines; hiding the controls frees no room | justified | a phone is read upright (INTENT); landscape is the player's |
| FR114 | minor | "+1" over the bar's start on a new book; the upload heading crossed by its box on a phone; "Join as Fay" offered to a member; War and Peace places without the Book number; "by yesterday" for a passed stop; the bell's "replied" against the thread's "answered" | fixed 4c5e183 (stop's day, "replied") / justified | a passed stop is "planned for yesterday"; a held answer says "replied", as the bell does; joining a club you are in only opens it; the rest are cosmetic and left for later |
| FR107 | must | A plain numbered audiobook folder (01.mp3…) and a PDF without bookmarks were lined up only as straight lines with a tenth of the book as margin: notes opened 20 minutes, or a chapter, late | fixed e1807fd | bare numbers number chapters again and front matter may be left out; a bookmark-less PDF is lined up by its chapter headings, read in the worker; a straight line's margin is 6 % of the book over its measured 3.5 % (D74); shared `align.test`, `titles.test` (the reviewer's nine namings); server `chapters-found.test`, `parts.test` |
| SA78 | P3 | Found while fixing FR107: drawing a PDF's first page as its cover still runs on the server's thread, and a crafted first page held it 7.5 s | justified | the upload comes from an invited member of the club, it is one stall per upload of their own PDF, and every other part of reading a PDF (its headings) and an EPUB or an audiobook runs in a worker with limits; moving the cover's drawing there too is noted for later |

## Round 12 (2026-10-25)

### Product fidelity, round 12 (rating 8/10)

A fresh reviewer drove the stack on 78ffa69 with 37 scripts in WebKit iPhone 15 and desktop
Chromium, up to three friends at once and eleven new accounts (by invite, through the upstream, an
outsider). No spoiler in 173 HTTP bodies and 21 WebSocket frames; presence in 380 ms; page numbers
held across font sizes; reading along, the player, uploads (an 82 MB one through two Wi-Fi drops),
offline and the upstream sign-in all worked. One must-fix:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR116 | should | The password reset link for a friend appeared off an iPhone's screen, with no way to send it | fixed 2d0c02d | a dialog with Copy link and Share, as the invite has |
| FR117 | should | The PDF is small on a phone at fit width, and zoomed in, taps and swipes do not turn its pages; a friend's marker sits in the page-turn zone | justified | the PDF is the printed page (on a phone the book page offers the EPUB, which reflows); zoomed in, a drag pans the page, as in any PDF reader, and the footer arrows turn it; a marker tapped opens its note, a tap beside it turns the page |
| FR118 | should | The Home Screen hint promised the installed app keeps your books; on iOS it starts afresh | fixed 2d0c02d | it says you sign in once more there, and books opened there are kept there |
| FR119 | minor | The fifth friend's blue read as the second friend's teal on the bar | fixed 2d0c02d | a fifth friend is orange (v1's eight colours, reordered); shared `constants.test` |
| FR120 | minor | "+N" drawn over the bar's start on a new book; "Join as …" for a member; the upload heading crossed by its box on a phone; "+7" faint on the Day theme | justified | cosmetic, left for later |
| FR121 | minor | A listener paused in a track's spoken introduction, then "Read", opens the EPUB at the end of the chapter before | justified | the reading opens where the timeline puts the place heard, which is just before the chapter's words; one page turn is the chapter's start |
| FR115 | must | Notes between the EPUB and the PDF sat up to eleven lines off and opened a page or two late, and listening from the PDF started 40 s early: the PDF's map had a point per chapter | fixed 6e1ceed | the PDF's text is lined up with the EPUB's line by line, as a forced alignment with no cross-format margin, a PDF note covering its whole line (D75); server `printed.test` (the reviewer's three cases now on their line and opening with their page; every word of 2,055 lines on its own line), shared `textalign.test` |

### Acceptance dry run 7 (2026-10-25, from a fresh clone)

13 of 14 verdicts held on 714a168 (three E2E runs in both projects, 163 to 165 distinct tests each,
all passed; coverage 97.7 % server and 93.5 % shared; Lighthouse and axe as required). Before it,
a full E2E run on the stack found the PDF far-peek test failing in both projects.

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| DR6b | P2 | The PDF far-peek E2E test worked out places from the PDF's chapter map while the server read with the line-by-line one: a PDF is ready before its line-up lands, in the same job (D75) | fixed e560647 | `clubWithAlice` waits for the PDF's alignment `forced`, as `readAlong` waits for a transcript; D75 records the order; full E2E 328 passed |
| DR7 | P2 | One crafted-EPUB timing test missed its limit (3.1 s against 2.4 s) when every package's coverage ran at once: the pace that scales the idle limits was measured once, before the other suites loaded the machine | fixed 2c2daf2 | the pace is measured just before and just after each book is timed; the idle limits are unchanged; all four packages' coverage at once: 1,759 passed |

## Round 13 (2026-10-25)

### Product fidelity, round 13 (rating 7.5/10)

A fresh reviewer drove the stack on 7d1e46e in WebKit iPhone 15 and desktop Chromium: on the demo
club nearly everything held (presence in 0.58 s and markers 6 to 58 ms after a page turn, no
spoiler through the API or WebSocket frames, page numbers stable across fonts and reloads, reading
along, the player, offline, the upstream sign-in). Then it made a club's first evening from the app's own
screens: Gutenberg's illustrated A Christmas Carol (#46) and LibriVox's recording of it (five
tracks of 18 to 63 minutes). Two must-fixes:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR122 | must | Matching the Carol audiobook's tracks to its staves by hand gave the ending away: the last track's 17.7 minutes were squeezed between STAVE FIVE. and its subtitle THE END OF IT., so a friend on the first page of Stave Five read a note made at the end; the listener stayed at 92 % and never finished | fixed 91089af, 72a0881 | the book's chapters are the entries that start chapters (D77): the stave's subtitle is part of the stave, so the last track ends with the story; a match by hand is held to a match's pace and refused naming the track (`implausibleStretch`); server `carol.test` (the Carol EPUB and LibriVox's tracks: matched by number, the last heard over all of Stave Five, the ending note closed on Stave Five's first page and open at the end; a hand match cramming track 4 into Stave Five refused), `ingest.test` (a squeezed and a crammed hand match refused, named); e2e `carol.spec` |
| FR123 | must | The automatic match paired two of the five LibriVox tracks (cut ID3v1 titles, "Stave 2" against "STAVE TWO."), nobody was told, notes across formats opened about 18 pages late, a reader on a note's page was told "You have not read this far yet", and a listener was never cued for a note that opened minutes after its place; with the right match, a tenth of a long stave still delays notes about six pages | fixed 7966520, 407d46c, e107526, 10272e6, d0e0657, 4bc47ce | staves number chapters and the chapters are the staves (D77), and LibriVox's tags are read whole (D76): all five tracks match by number; an owner is told of tracks placed between matched ones; a closed note on your very page says it was made in another format and opens a little further on, the reader tells when it opens, and the player cues one opening minutes after its place (D78); a chapter started from the track list a moment in is heard from its start (the gate had left its first minute unheard); the deploy kit's image transcribes each new audiobook itself, so a club's own recording is lined up sentence by sentence with no margin within the hour (D79: base.en, Alice in 22 min on 2 vCPUs, 97.2 % of words matched); server `carol.test`, `librivox-tags.test`, `crossformat.test` (a chapter started 7 ms in), `readalong.test`; web `matching.test`, `further.test`, `panels.test`; e2e `carol.spec`, `notes-further.spec`; the deploy drill transcribes in the built image |
| FR124 | should | Every contents entry was a chapter: title-page lines, PREFACE, CONTENTS, illustration captions and heading-subtitle pairs became next stops ("the end of PREFACE", a stop at 48 % for a stave ending at 74 %), labels ("Scrooge's Third Visitor · 67 %", a Gutenberg note on the first page) and chapter page counts restarting mid-stave; the illustrated Pride and Prejudice glues captions to chapter names | fixed 997374e, 91089af, d9b0cce | chapters from the contents (D77): captions, subtitles and a story's parts are no chapters, "STAVE ONE. MARLEY’S GHOST." is one, captions leave chapter names; the page in a chapter counts from chapter entries; a place in the front matter is "Before Stave 1" and the front matter offers no stop; checked on 29 Gutenberg books; shared `contents.test`, `titles.test`, `chapters.test`, `meeting.test` (the Carol's stops), epub `contents-hints.test`, web `pagecount.test`, e2e `carol.spec` |
| FR125 | should | A note written behind where its writer had read was held until friends reached the writer's place, with a hint saying friends see only a marker, no notice on the book page, and no "only about this passage" as replies have | fixed a54713c, 10272e6 | a note may be only about its passage (`aboutHere`), as an answer may; the form tells a writer from further on where they have read to and that friends read the note once they have read that far, with "Post" and "Post, only about this passage"; the book page shows the writer's held notice (D78); server `comments.test`, web `panels.test`, `further.test`, `Discussion.test`, e2e `notes-further.spec` |
| FR126 | minor | LibriVox's "(version 7)" stayed in the title an audio upload filled in | fixed 979b47f | the upload form drops a trailing "(version N)" from the title it fills in, keeping other parentheses ("(Dramatic Reading)"); web `metadata.test` |

## Round 14 (2026-10-25)

### Product fidelity, round 14 (rating 8.5/10, no must-fix)

A fresh reviewer drove the stack on 30dc5ef (35 scripts, WebKit iPhone 15 and desktop Chromium),
with the demo club, a friend by invite, an upstream friend, and a club built from the phone with The
Great Gatsby (EPUB and the 9-track LibriVox recording, transcribed by the server by itself in about
15 minutes, after which a reader's note opened for a listener as the narrator read it), Pride and
Prejudice, Frankenstein and A Christmas Carol. Presence 4 to 8 ms after a page turn, no note text
ever on screen ahead, page numbers stable across fonts and reloads, a throttled 155 MB upload cut
at 48 % went on from 79 MB. What held it below 9 were rough edges with Gutenberg books:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR127 | should | The reader's contents mark the wrong chapter current where several share a file (Gatsby on chapter II marks "V"; P&P at XLV marks "LIV") | fixed fc2cc30 | the current chapter is the last listed starting at or before your page, by place in the book (D81); web `contents.test`; e2e `carol.spec` (the stave you are in marked) |
| FR128 | should | The reader's contents list the book's raw entries (P&P's captions in chapter names, the Carol's subtitles and pictures), unlike the rest of the app | fixed fc2cc30 | the contents list the entries that start chapters, by the names the club uses (D77, D81); web `contents.test`; e2e `carol.spec` (staves by their names, no picture, no subtitle apart) |
| FR129 | should | Chapters named by a numeral alone read badly: "You are at I · 0%", "The end of I", a lone "II" in the reader's header | fixed fc2cc30 | a numeral alone is "Chapter 2" in labels and stops and "Chapter II" in a heading (D81); shared `titles.test`, `chapters.test` |
| FR130 | should | Front matter shows "Section page 3 of 176" (the first file's pages) and its header names the 40-page preface "PRIDE. and PREJUDICE" | fixed fc2cc30 | before the story the header says "Before Chapter 1" and the footer counts no chapter (D81); shared `chapters.test` |
| FR131 | should | With two clubs, `/` is a bare list of club names: opening the app is no longer one tap to your place | fixed d50217a | with several clubs, home opens on "Read on" (or "Listen on") to the book read last, its club named, then each club with its covers and who is reading what (D83); web `HomePage.test`, e2e `polish.spec` |
| FR132 | should | A note ahead of you comes to you with its exact place (its locator and t to 17 digits): looked up in the EPUB, it is the passage it quotes | fixed 8aa6ee8, df0c547 | a note at a place you have not read comes placed only roughly (`approx`, half a per cent, within its chapter); the page you look at is told where on it such notes are, a page at a time (D80); server `comments.test` (rough in the list, exact once read, the places of a page and no more), e2e `spoilers.spec` (a note ahead comes `approx`, its marker still on its line when you go there) |
| FR133 | should | Destructive confirmations are the browser's own dialog, titled with the site's address on an iPhone | fixed 37a9e18, 9671694 | every destructive question asks in the app's own alert dialog, the safe answer focused, Escape and the backdrop answering no (D82); web `confirm.test`, `Modal.test`; e2e `polish.spec` (axe on the dialog), and every spec that answered the browser's dialog answers the app's |
| FR134 | minor | "Join as Ana" for a member opening the invite; the upload dialog's heading crossed by its box on a phone; a PDF place at 8 % opens as 7 % in the EPUB; a notification opens the book page without marking its note | fixed 99f3098, 72370e0, 75c4136, bfb1994 | an invite opened by a member says so and opens the club (D84); the upload dialog's question sits inside its box on a phone; a place carried between two formats' maps keeps its per cent (D81); a notification lands on its note, marked and focused, a reply's on the reply (D85); web `JoinPage.test`, `note-link.test`, shared `format.test`, e2e `polish.spec` |

## Round 15 (2026-10-25)

### Product fidelity, round 15 (rating 8.5/10)

A fresh reviewer drove the stack on 6a5bf9f (67 scripts, WebKit iPhone 15 and desktop Chromium):
presence in 0.65 s, markers 7 to 35 ms after a page turn, no note text through the page, the API or
WebSocket frames (checked with a marker string), pages stable through reloads, fonts and rotation,
the server's own transcription lining up an uploaded audiobook, an 82 MB upload cut at 48 % going
on by itself, offline reading and listening, the upstream sign-in, axe clean on seven lived-in pages. One
must-fix, with novels other than Alice:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR135 | must | In a novel that numbers its chapters afresh in each part (Crime and Punishment, War and Peace), the next stop's choices repeat ("The end of Chapter 1" six times, no part named), a stop set on Part II's first chapter reads as one a friend is past, and places name no part | fixed cc0a597, 7bf2fe0 | where chapters are numbered afresh in each part, each is named with its part in places, stops, the matching dialog and the reader's heading; a year span is not a number, ordinals are (D86); shared `chapters.test`, `titles.test`, `meeting.test`; e2e `parts.spec` (Crime and Punishment: distinct, part-named stops, the stop chosen read as chosen, a friend's place and the heading named with the part) |
| FR136 | should | Front matter shows raw names and a chapter count when the audiobook came first ("THE MILLENNIUM FULCRUM EDITION 3.0"; "1 of 2 in chapter" on page 2), and the contents list the licence "ahead of you" | fixed 7bf2fe0 | the reader takes front matter from its EPUB's own chapter starts, and its contents drop the licence, the title page's scraps and the book's own lists (D86); web `pagecount.test`, `contents.test`; e2e `parts.spec` (Alice added to its audiobook: "Before Chapter 1", no chapter count, no licence or title lines listed) |
| FR137 | should | Toasts give no context and cannot be tapped; an answer opening is told to members who were never in that conversation, without saying which | fixed a477895, eb52d2c, 32a87c6 | a toast can carry "Show" (opening the note's sheet in its reader, or the note on the book page), stays 10 s and while pointed at or focused, sits over the top bar, never over a card; an opened answer is told only in its conversation, naming it (D89); web `Toasts.test`, `Notifications.test`, `answer-open.test`, `note-opener.test`, `queries.test`; e2e `polish15.spec` (a friend's answer reaches you in the reader and Show opens it; an answer opening is told to nobody else; axe on each) |
| FR138 | should | The club bar draws "+3" over your own marker on a new book; the look's buttons cover the bar | fixed 94f12de, fdd96f8, eb52d2c | your own marker is a target of its own at your place, friends there beside it (D90); during a look its buttons sit in the reader's header or footer, never on the bar (D91); web `ClubBar.test` (layoutMembers on random clubs: no overlaps, everyone once, you at your place); e2e `polish15.spec` (straight after an upload; four looks, EPUB and PDF, phone and computer) |
| FR139 | should | Alice's rows of stars wrap on a phone, a page holding only broken separator rows | fixed 8197591, 5b7fd64 | a row of stars is marked with its widest line's width and drawn on one line, closer, no larger than the page; counts kept from another stylesheet are not used (D86); epub `contents-hints.test`, web `layout.test`; e2e `parts.spec` (every row of Alice's first chapter at 200 %, one line, inside the page, WebKit iPhone and Chromium) |
| FR140 | should | The stop card's "Show the note" says not whose; the stop choices give no chapter titles | fixed 3cf727f | the stop card's button names whose notes ("Show Ana’s note"); the choices give each chapter's title ("The end of Chapter 7 · A Mad Tea-Party") (D92); web `stop-titles.test`, `Meeting.test`; e2e `polish15.spec` (the card names whose notes), `meeting.spec`, `carol.spec` |
| FR141 | should | On a phone the audiobook cannot be started from inside the reader: Back, the book page, Listen | fixed 7bf2fe0 | the reader's headphones button saves the place and opens the audiobook there (D86); e2e `parts.spec` (from Chapter III the player opens on its third track) |

## Round 16 (2026-10-25)

### Product fidelity, round 16 (rating 8.5/10)

A fresh reviewer drove the stack on 557bfc1 (about 45 scripts, WebKit iPhone 15 and desktop
Chromium, several friends at once): note text never reached a friend ahead of its place over HTTP
or the WebSocket, presence in 0.9 s, pages 200 → 278 → 200 through a font change with the same
passage on screen, read-along turning the pages, offline from a cold start, the upstream by invite and a
sign-in code into a fresh Home Screen browser. One must-fix, at chapters' first pages:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR142 | must | Switching format on a chapter's first page opens the previous chapter: from the EPUB's first page of Chapter VI the audiobook plays Chapter V's last seconds and the PDF opens on Chapter V's last page (each format's chapter start sits a few millionths of the book apart; 8 of 12 chapters for the PDF, 7 of 12 for the audio) | fixed b3bab02 | a place at a chapter's very start, in the format it was saved in, opens at the other format's own start of that chapter where translating it would land before it, compared in that format's own measure (D93); web `position.test` (heading, a few lines above it, a lined-up PDF's title page, a listener in the preamble, places before and into a chapter left as they were, a place told by format and t); e2e `chapter-switch.spec` (the reviewer's route from Chapter VI's first page, and every chapter from the EPUB to the audiobook and the PDF and from the audiobook to the PDF, both projects) |
| FR143 | should | In the reader on a phone a toast covers the header's buttons (Back, Listen, Contents, Reading settings, Leave a note) for its ten seconds, and "Stay here" | fixed 62b0065, f9c64c9 | a toast in the reader and the player goes where it covers no control: the header's middle with room, the foot during a look on a computer, else just under the header and the club bar over the page's top (D94); web `toast-place.test`; e2e `polish16.spec` (the topmost element at every control's centre with a toast up, phone and computer, EPUB, PDF and player, axe; failing as reported on the build before) |
| FR144 | should | A reply asks "You have read further than this note…" with two Send buttons whenever its writer is a little past the note, though no friend is behind them; the posted reply then names the wrong chapter ("read to Chapter 2" from Chapter 3) | fixed dd5b86e | the question is asked only while a friend is behind, naming them; where an answer waits until is named by the writer's last place read (D95); web `further.test`, `Thread.test`, `panels.test`, server `unit.test` (horizonLabel); e2e `polish16.spec` (the reviewer's numbers) |
| FR145 | should | A paused upload waits up to 30 s after the connection comes back | fixed 76f4457 | an upload waiting on the connection goes on at the browser's online event or when the page comes back on screen, its back-off from zero (D96); web `uploader-connection.test`; e2e `resumable.spec` (16 s offline, asked again within 3 s of reconnecting, nothing re-created; failing on the build before) |
| FR146 | should | A book nobody has started has no Read button on its card: a new member goes cover, book page, Read | fixed c47a313 | a book not started offers Start reading or Start listening on its card (D97); web `BookCard.test`; e2e `library.spec` |
| FR147 | minor | A reaction-only note ahead says "A reaction waits here. You will see it when you get there." beside its emoji; the stop card's line is cut on a phone; Gutenberg's full title ("A Christmas Carol in Prose; Being a Ghost Story of Christmas") is filled in as it is | fixed 48eb6a8, 2ebc4d9, 6dbf616 | a reaction alone says it has no words; the stop card's line is said whole on a phone (D100); the upload form fills in the club's title (D98); web `Discussion.test`, `Meeting.test`, `metadata.test`; e2e `polish16.spec` |
| FR148 | minor | A note saved offline shows "Posting…" for about 3 s in WebKit before saying it is kept on the device | fixed 22350bb | a note with no network is kept at once, one quick try more after a failed request, no timeout (D99); web `api.test`; e2e `offline.spec` (kept within 1.5 s offline, within 2 s of an aborted request, a 3 s slow request still posts) |

## Round 17 (2026-10-25)

### Product fidelity, round 17 (rating 8/10)

A fresh reviewer drove the stack on ad6ea39 (about 50 scripts, WebKit iPhone 15 and desktop
Chromium, up to three friends at once): presence in 0.58 s and markers 3 to 25 ms after a page
turn, no note text through any HTTP body or WebSocket frame ahead of its place, pages 22/170 →
40/309 → 22/170 with the same passage, offline syncing 0.47 s after reconnecting, the upstream sign-in in about
6 s, and a book of its own (Jekyll and Hyde, EPUB and an 80 MB LibriVox folder) transcribed and
lined up by the server in about 12 minutes. Two must-fixes, with friends' own files:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR149 | must | A scanned PDF (JPEG 2000 pages, as archive.org and Google Books make them) shows blank pages in the reader and gets a white cover: the browser's pdf.js has no wasm, fonts or ICC data; its contents are raw OCR headings ("STORY OF THE DOOR. 7"), 6 of 10 chapters; its author fills in as "Stevenson, Robert Louis, 1850-1894" | fixed d96b75b, 12bdb06 | the browser's pdf.js gets the decoders, fonts, maps and colour profiles from the app, kept offline with a PDF (D102); no blank drawing is a cover (D103); a scan's chapters through its OCR, all ten of the 1886 scan (D104); authors as people say them (D105); web `pdf-resources.test`, `offline.test`, `metadata.test`, shared `blank.test`, server `scan.test`, `static.test`; e2e `polish17.spec` (a JPEG 2000 page drawn, a real cover, drawn offline; failing on the build before) |
| FR150 | must | An EPUB's back matter (Standard Ebooks' Colophon and Uncopyright) is story: "You finished the book" comes on the licence's last page, and they are chapters in the header, contents and places | fixed ee09460, 8274008 | an EPUB's story is what the book marks as story; back matter stays readable, numbered "—", listed apart after it (D109); epub `matter.test`, `crafted.test`, server `ingest.test`, web `contents.test`; e2e `polish17-epub.spec` (reading to the story's last page finishes the book, the colophon after it); the corpus's 36 Gutenberg books unchanged |
| FR151 | should | A tall cover (500×862) is cut to 2:3, losing its title on the shelf, book page, player and lock screen | fixed 1c82ea6 | a cover taller than 2:3 is drawn whole on the app's dark ground (D111); server `unit.test` (covers); e2e `polish17-epub.spec` (cover pixels at every width, the lock screen's artwork) |
| FR152 | should | A track holding several chapters ("Chapter 01 to 03") gives no chapter names in the track list or the player's title, even once read along sentence by sentence | fixed 75847e0, 4347a20 | a track holding several chapters lists the chapters heard in it, and the player names the one heard (D112); web `tracks.test`, server `readalong.test`; e2e `polish17-epub.spec` |
| FR153 | should | The demo puts Cole himself in the PDF: on an iPhone "Read on" opens it at about 10 px text | fixed 0466916 | the demo's owner reads on in the EPUB; Cleo, further on, reads the PDF (D108); server `cli.test`; e2e `polish17.spec` |
| FR154 | should | At 0:00 of a newly transcribed recording, the read-along's sentence is the contents page's last entry | fixed d00c050 | a recording is lined up with the story's reading only, its first words tied to its first sentence (D110); shared `contents.test`, `forced.test`, server `readalong.test`; e2e `polish17-epub.spec` |
| FR155 | should | The PDF reader's footer wraps on a phone while audio plays (fixed for the EPUB, FR52) | fixed ba16906 | the PDF footer keeps to one line on a phone with the player, as the EPUB's (FR52); e2e `polish17.spec` |
| FR156 | should | A long upload from an iPhone keeps no screen wake lock and does not say to keep the screen open (read) | fixed 83ea794 | a screen wake lock while files upload, and the words to keep the screen on for uploads of 20 MB or more (D107); web `wake-lock.test`; e2e `polish17.spec` |
| FR157 | minor | The player's subtitle repeats the raw tag; "+1" over the next-stop flag on a new book's bar; Gutenberg's sentence-case title filled in as it is | fixed e71f1fb, b6ec8e5, and the PDF work's title case | the player names the track only where it says more (D113); nothing on the bar covers the next stop's flag (D113); a sentence-case title is filled in in title case (D106); web `ClubBar.test`, `metadata.test`; e2e `polish17-epub.spec`, `polish17.spec` |
| FR158 | should | Notifications are in the app only: no Web Push (read) | justified | the bell and the live toasts stay; Web Push is the deployment's next step: subscribing and delivering go through the browser makers' push services, which this work could not reach or test end to end, and on an iPhone it needs the app on the Home Screen and the friend's leave (D101) |

## Round 18 (2026-10-25)

### Product fidelity, round 18 (rating 8/10)

A fresh reviewer drove the stack on 25e7a69 (about 50 scripts, WebKit iPhone 15 and desktop
Chromium, eight friends, two clubs): presence 29 ms after a friend's reader was ready, markers 10 to
243 ms after a page turn, no note's words ahead of its place by HTTP, WebSocket or page, pages
200 → 278 → 200 through two font steps, read-along to the sentence, offline syncing 260 ms after
reconnecting, the upstream sign-in in one tap, and a club's own Time Machine (EPUB and 13 LibriVox tracks)
transcribed by the server within a quarter of an hour. Two must-fixes, with a club's own files:

| # | P | Finding | Status | Evidence |
|---|---|---------|--------|----------|
| FR159 | must | On a phone, an illustrated book's pictures run off the page and over the text (Gutenberg #28885: a plate 450 px wide in a 393 px page, split over two pages, under the words): Gutenberg sizes the picture's wrapper (`div.figcenter`, `style="width: 450px"`), which nothing holds to the page | open | |
| FR160 | must | The track list makes up a chapter from LibriVox's closing words ("End of chapter 1" heard as Chapter II's heading 7 s before the track's end): Chapter II listed twice, its first row playing the credits; the same in a club's own Time Machine | fixed f4f89d4, 853547d | a chapter starts in the track that says its text; a track's closing words stay in the chapter it ends; older read-alongs lined up again once (D114); shared `forced.test` (the real Alice transcript, crafted credits), server `readalong.test`; the real Time Machine (phantom gone, XIII in track 10); e2e `polish18-audio.spec` (no chapter listed twice; the credits under Chapter I; failing on the build before) |
| FR161 | should | Lined up with a club's own audiobook, a track of one chapter keeps its file's tag ("06 - Chapter 6") in the title, lock screen and track list though the server knows its chapter ("IX. The Morlocks") | fixed 853547d, f0dd6fc | every track named by the chapter it holds, in the list, title, mini player, lock screen and composer (D115); web `tracks.test`, server `readalong.test`; e2e `polish18-audio.spec` |
| FR162 | should | A book whose contents list no chapters (#28885: only its title, Contents, List of the Plates, The End) has none: "LIST OF THE PLATES" over every page, next stops "The end of Contents"… | open | |
| FR163 | should | Offline, a book never opened on the device says "This book is not available" after 7 to 10 s, and the club page offered "Read on" for it | open | |
| FR164 | should | The upload fills in raw text: "Alice's Adventures in Wonderland / Illustrated by Arthur Rackham. With a Proem by Austin Dobson"; tracks as "01 - Chapter I" until lined up | open | |
| FR165 | minor | "Choose a folder" on an iPhone, which has no folder picker (read); tapping the page hides the controls without giving the text more room (read) | open | |
