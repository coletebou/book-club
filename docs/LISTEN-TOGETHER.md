# Listen Together: playback and diagnostics

## What is shared (and what is not)

The server keeps an **ephemeral playback clock**, not a streamed mix: edition, track, position,
play/pause, rate and the time that position was recorded. Commands are authenticated HTTP requests.
Every party has an incarnation UUID and monotonic state revision (including membership/settings
changes), separate from the projection timestamp; stale HTTP responses cannot undo newer hub state.
Every party HTTP response (GET, start, join, control) is fenced by what the cache and the hub had
said when its request was sent. Undisturbed, it applies. If a hub event (or another response)
changed the party while it was in flight, it applies only as a newer revision of the same
incarnation; a party that has since ended (explicit null) or been replaced by another incarnation
stays ended or replaced, so a slow start or join response cannot bring it back.
State is broadcast over the existing club WebSocket hub (500 ms safety broadcasts). Each listener
plays their own authenticated copy of the audiobook. LiveKit carries microphones only, not book audio.

The app-wide `AudioProvider` follows that clock and owns an active-party club subscription even
when navigating away from the listen page. It applies changed state immediately, plus a 1 s
reconciliation tick. Main and mini-player play/pause,
track selection, skips, scrub and speed controls, and **browser Media Session handlers**, send shared
intent when participating in the loaded edition's party. Host-only permissions are respected: a
refused/failed party command does not secretly become a local command. Transport requests time out
after 10 s. While a command is in flight, the latest trailing intent of each kind (play/pause,
seek, speed, settings) is coalesced, so a Pause after a delayed Play or an uncertain timeout is
still sent, and a scrub queued beside it is kept, with the final scrub position winning. Play/pause
toggles flip the latest *intended* state (the outstanding command), not the last acknowledged one:
Play then Pause sends Play, Pause; Play, Pause, Play cancels the queued Pause and sends Play once.
Main/mini/footer button icons, accessible names and main `data-playing` describe that same
shared intent, not local audibility: a playing party still shows Pause during a private hold.
Queued intent changes render immediately and a failed command falls back to acknowledged state.
`useAudioState().playing` remains the actual local engine state for listening/progress reporting.
Requests are isolated to the participation lifetime.
The top party toggle remains explicitly bound to its book and shared party, including when another
edition/player is loaded. Automatic track advancement is conditional on the previous shared track,
so staggered end events from two listeners cannot rewind the new track. Automatic advance/final pause also require the
expected playback clock revision; they cannot undo a newer same-track seek or play. The sync driver uses
explicitly local methods, so its seeks/play/pause/rate
corrections never send another party command.

Local interruptions are holds, not commands. Recording or playing a voice note, and Cal speaking
(until his reply audio has finished), hold this device's audiobook paused: no shared Pause is
sent, and the sync driver neither restarts it nor chases the clock while held (it still follows a
shared Pause, and logs the hold once as `suspended`). When the last hold ends, the player resyncs
at once: it seeks to the party's current position and plays if the party is playing. Alone, a
voice note resumes only what it paused, and Cal still never auto-resumes (D169). A delayed native
Play (or hardware Play) during a hold is paused locally, never translated into a shared Pause;
local play/autoplay is guarded too. Leaving a party during a hold does not turn its release into
an unsolicited solo Play. Cal socket/server failures clear the speaking hold and discard incomplete
reply audio; a normal socket close keeps a completed reply held until playback ends or errors.

Drift is measured from the live player's clock, not its last React render. Above 0.75 s the player
seeks; smaller drift over 0.05 s nudges speed ±5%. Paused players use the canonical speed. Correction
is held while loading, buffering/seeking, and for 1.5 s after an issued seek (a new shared clock
change can supersede that cooldown). Temporary corrections never overwrite the preferred speed;
a user's own speed command does as soon as it succeeds, even if a newer state from someone else
wins the cache. Leaving restores their preference.

Auto-pause is independent of transport: by default, a participating microphone speaking for 700 ms
pauses everyone; 4 s of quiet resumes and rewinds 2 s. Speaker leakage can count as speech: earbuds
are still recommended. Server logs distinguish a manual command from an interruption/auto-resume.

## Downloaded vs streamed

- **Browser/PWA:** the audio element requests the media URL. The service worker may satisfy it from
  an offline edition cache. `browser-cache-available` means the current track was found in the cache
  while a service worker controlled the page; it is availability evidence, not proof of which
  response the audio element consumed. `browser-network` means no cache entry was found in that
  check; unavailable cache/service-worker evidence is honestly `browser-unknown`.
- **iOS native app:** AVPlayer never reads the WebView's Cache Storage. The web “Save offline” button
  therefore does not populate AVPlayer's native cache. Native plays a local file if that track has
  already downloaded into the app's audio directory; otherwise it streams that track and downloads
  it in the background for later loads. It does not pre-download the next track or the whole book.
  New native diagnostics report the actual `native-local` vs `native-network` selection, download
  outcomes, seek completion timings and buffering transitions. No offline manager is added here.

**Native instrumentation requires a new iOS build.** Existing native builds still get the web-side
transport/sync diagnostics after the web deployment, but report `native-unknown` for source unless
updated. No TestFlight build or release is part of this change. Expo's native lock-screen/headphone
controls act directly on AVPlayer, not the browser Media Session shim; they are observed/reconciled
and logged, **not claimed to issue shared party commands**. Device/background playback and those
hardware controls still need a real-device test.

## Reading the evidence

At the normal server `info` level:

- `party.client-diagnostics`: server-derived club/book/user ids, a random per-participation
  `sessionId`, and a batch of client records. Look for `sync` decisions (`seek`, `nudge`, `hold`,
  `track`, `rate`, `steady`, and `suspended` for a local voice note/Cal hold), drift, expected/local position, party/local rate and play state,
  forced play/pause, state/status age, buffering, readiness, visibility, media transitions,
  control round-trip timing and native source/download/seek events.
- `party.start`, `party.join`, `party.leave`, `party.control`, `party.control-denied`,
  `party.speaking`, `party.auto-pause`, `party.auto-resume`: server clock and transition evidence.
  Speaking is transition-deduplicated; server transition diagnostics are also capped at 120/minute
  per user (automatic events per party). The frequent safety broadcast is not another log line.

For example, inspect the application container's logs and filter for `party.`. Correlate server
clock/commands with client `sessionId` and relative `elapsedMs`. Device wall-clock skew is not
estimated; the logged state age/drift can help identify it but does not establish the root cause.
Do not treat every seek as proof of network buffering; compare it with source and media events.

### Bounds, access, privacy and retention

`POST /api/books/:bookId/party/diagnostics` uses existing session, same-origin and expected-user
protections. It requires book/club access **and current party membership**. A provided party incarnation must match the active party. The body is at most
16 KiB, has at most 20 events, and passes a strict shared schema: closed enums, finite bounded
measurements, UUID participation id; unknown fields are rejected. The per-user limit is 20 batches
per minute across books and session ids, with `429` / `Retry-After: 60`.

Clients keep at most 80 records **in memory**, flush at most 20 every 5 s, permit only one request
in flight, and abort diagnostic requests after 10 s. Failed batches are dropped, not persisted or
retried: other failures back off 30 s, rate limiting 60 s, revoked access stops diagnostics. Leaving,
changing edition/account or unmounting disposes the buffer. Very short sessions, a page close and
extended offline use can lose the last records; diagnostics must never delay audio or replay one
person's records in another session. Steady sync is sampled every 5 s; media `timeupdate` is not
logged on every update.

No credentials, cookies, raw URLs, local paths, error strings, names, titles, microphone audio or
other user content are accepted/sent by this channel. Authenticated user/book/club ids and playback
positions **are** diagnostic metadata, so treat these server logs as private operational data.
There is no new database or export endpoint. Retention/access follow the existing server log
rotation and operator access policy; this change does not add persistent diagnostic storage.

## Verification commands

```sh
NODE_ENV=test pnpm --filter @bookclub/web exec vitest run src/player/AudioProvider.test.tsx src/player/party-transport.test.ts src/player/native-bridge.test.ts src/live/party-diagnostics.test.ts src/live/PartyBar.test.tsx src/cal/useCalVoice.test.ts
NODE_ENV=test pnpm --filter @bookclub/server exec vitest run test/party.test.ts test/party-diagnostics.test.ts test/party-manager.test.ts
NODE_ENV=test pnpm --filter @bookclub/mobile exec vitest run src/audio/NativeAudioEngine.test.ts
pnpm --filter @bookclub/shared test
pnpm --filter @bookclub/web --filter @bookclub/server --filter @bookclub/shared --filter @bookclub/mobile run typecheck
pnpm --filter @bookclub/mobile run lint
```

The mobile tests mock Expo modules (file/network source selection, bounded diagnostic vocabulary,
seeks, simultaneous playing/buffering transitions, load/unload races), not AVPlayer on a device.
They can be run with the command above without changing mobile package scripts. CI/workflow and
package/lockfile changes are intentionally outside this patch.
