# Book Club for iOS

An Expo app (SDK 58, React Native 0.88) that is almost entirely `apps/web` running in a
`react-native-webview`: the reader, the social layer, uploads, chat — everything the web app
already does — loads from the same server, inside a `<WebView>`. This project owns only what a
WebView does badly on iOS (D130-D139, `docs/DECISIONS.md`):

1. **Audiobook playback** that keeps going in the background, with lock-screen / Control Center
   controls, interruption handling, AirPlay and a speed control — `expo-audio`, bridged to the web
   app's existing player so none of its logic (places, looks, D70 catch-up, the sleep timer,
   read-along) had to change. With the phone locked iOS puts the WebView to sleep while native plays
   on, so the page hands native its track queue and the sleep timer's end, and native goes on to the
   next track, pauses for the timer and saves the place by itself until the page wakes (D181, D182).
   Its audio session does not mix with other apps', which is what makes it the Now Playing app.
2. **The WebView itself done right**: shared cookies (so signing in once covers both the page and
   native playback), App-Bound Domains (so the service worker's offline reading works), external
   links opening in Safari, camera/mic access for voice notes, voice channels and talking to Cal,
   and an audio session that allows a voice channel to run while a book keeps playing.
3. **Push notifications**: a raw APNs device token (not Expo's push service, which would be one
   more hop to Apple; D134), registered with the server, which sends over its own APNs connection.
4. **Native "Sign in with Apple" and "Continue with Google"** (D178), replacing the in-app need
   for the upstream sign-in round trip (D116, D177) that a WKWebView bound to App-Bound Domains
   (above) cannot complete: Apple's identity token comes back in-process, with no browser at all;
   Google is a browser session this app opens and closes around Google's own pages, handing a
   one-time code back to the page.

## How the bridge works

- **Audio** (D130-D132): `apps/web/src/player/native-bridge.ts` defines `NativeAudioElement`, an
  object shaped like an `HTMLAudioElement` (`src`, `currentTime`, `duration`, `paused`,
  `playbackRate`, `play()`/`pause()`, its events), which `AudioProvider.tsx` uses instead of a real
  `<audio>` element when `window.BookClubNative` exists. Every command (`load`, `play`, `pause`,
  `seek`, `setRate`, `metadata`, …) is `postMessage`d to native as JSON; native
  (`src/audio/NativeAudioEngine.ts`) turns it into a call on a real `expo-audio` `AudioPlayer`, and
  turns that player's status updates back into the DOM events `AudioProvider` already listens for,
  via `injectJavaScript` calling `window.__bookClubReceive`. The same file also stands a
  `NativeMediaSession` in for `navigator.mediaSession` (absent in WKWebView), so
  `AudioProvider`'s existing lock-screen effects run unchanged and simply end up telling native
  what to show. The web-side bridge is unit-tested in
  `apps/web/src/player/native-bridge.test.ts`; `apps/mobile`'s half has no native build available
  to unit-test against (no Jest/Detox here; D139), and is instead verified in the simulator
  (below).
- **Speed** (D195): any 0.05 step from 0.5× to 3×. The engine keeps the speed the page chose and
  gives it to each new track's player as it is made, with pitch correction at `high` (spectral).
  expo-audio's iOS `setPlaybackRate` caps every rate at 2.0; `patches/expo-audio@58.0.10.patch`
  (pnpm `patchedDependencies`, applied on install) raises it to 3.0, and `src/webview/injected.ts`
  tells the page so (`window.BookClubNative.maxRate`). A build without the patch says nothing, and
  the page treats it as a 2× player. Bumping expo-audio means re-making the patch for the new
  version (`pnpm patch expo-audio@<version>`), or dropping it if upstream lifts the cap.
- **Auth for native playback** (D133, D219): AVPlayer turned out to send no session cookie (D219),
  so a streamed track carries a media ticket instead: `src/audio/mediaTicket.ts` asks the server for
  one per edition and the engine hands it to the player as a request header. The rest of this
  paragraph is the original design, still true for the app's own requests: nothing bespoke. `sharedCookiesEnabled` on the `<WebView>`
  mirrors cookies between WKWebView's own store and `NSHTTPCookieStorage.sharedHTTPCookieStorage`
  in both directions (confirmed by reading react-native-webview's iOS implementation, not assumed)
  — the session cookie set by signing in inside the page lands there too, and `AVURLAsset`
  (`expo-audio`) and this app's own `fetch` calls both consult that same store by default on iOS.
  A track's URL is handed to native exactly as the page already has it; no signed URL, no manual
  `Cookie` header.
- **Offline reading** (D135): WKWebView's service worker support is unreliable without
  App-Bound Domains. `plugins/with-app-bound-domains.ts` sets `WKAppBoundDomains` in Info.plist
  (the production host plus whatever `BOOKCLUB_SERVER_URL` points a dev build at); the `<WebView>`
  sets `limitsNavigationsToAppBoundDomains`. `onShouldStartLoadWithRequest` sends anything outside
  the app's own host to Safari instead of letting a navigation there fail.
- **Push** (D134): `src/push/registerPush.ts` asks for permission, gets the raw device token
  (`expo-notifications`' `getDevicePushTokenAsync`, not Expo's push service), and `POST`s it to
  `/api/push/register` (migration `014_push_tokens.sql`). The server
  (`apps/server/src/push/apns.ts`) sends over HTTP/2 with a provider JWT signed by the team's
  `.p8` key — unit-tested against a fake APNs (`apps/server/test/apns.test.ts`,
  `apps/server/test/push.test.ts`). A tap opens the right place: the payload's `path` goes to
  `window.__bookClubNavigate` (`src/push/deepLink.ts`), which the web side installs
  (`installNativeNavigationBridge`, called from `apps/web/src/main.tsx`) to move the client-side
  router without a full reload.
- **Native sign-in** (D178): `apps/web/src/auth/native-auth-bridge.ts` asks native for one
  provider (`auth:apple` or `auth:google`) and waits for one answer on its own channel
  (`window.__bookClubAuthReceive`, separate from the audio bridge's `__bookClubReceive`, so the
  two can never cross-talk even though both share the same outbound `postMessage` stream).
  `src/auth/NativeAuthEngine.ts` runs `expo-apple-authentication`'s `signInAsync` in-process for
  Apple (a random nonce, SHA-256 hashed per Apple's own convention, sent raw to the page so the
  server can redo the hash and check it), and for Google opens a browser session around the
  server's own `/api/auth/google/start?app=1&challenge=…` with `expo-web-browser`'s
  `openAuthSessionAsync`, which resolves with the `bookclub://auth?code=…` redirect the server
  sends once Google has signed someone in; the code and this engine's own PKCE verifier go back to
  the page, which redeems them with `POST /api/auth/app-code` *inside the WebView*, so the session
  cookie lands in the shared cookie store (D133) rather than the ephemeral browser session.
  Unit-tested on the web side (`apps/web/src/auth/native-auth-bridge.test.ts`,
  `apps/web/src/pages/SignInPage.providers.test.tsx`); the native glue has no native build
  available to unit-test against here either (D139 again), verified in the simulator.

## Building

Everything here needs Xcode on a Mac. A cloud Mac (an EC2 Mac instance, say) works:
`scripts/setup-mac-ec2.sh` sets up a user-local Node 24 and CocoaPods under `~/bookclub`, nothing
system-wide. On a build Mac shared with other projects, every script here waits for any other
`xcodebuild` to finish first (`scripts/lib.sh`).

```bash
# once, on the build Mac: a user-local Node 24 and CocoaPods under ~/bookclub (nothing system-wide)
apps/mobile/scripts/setup-mac-ec2.sh

# regenerate ios/ from app.config.ts (needed after any change to app.config.ts or plugins/)
BOOKCLUB_SERVER_URL=http://127.0.0.1:47140 apps/mobile/scripts/prebuild.sh

# build, install and launch in the simulator, then screenshot it
apps/mobile/scripts/run-simulator.sh
```

### Dev stack

The simulator is told to use `BOOKCLUB_SERVER_URL`. The simplest dev stack is the server (and the
built web app it serves) running directly on the build Mac itself — Node only, no Docker — at
`127.0.0.1:47140`, which the iOS **Simulator** (not a device) reaches as the Mac's own loopback:

```bash
cd apps/web && npm run build   # or: pnpm --filter @bookclub/web build, from a full checkout
cd apps/server && WEB_DIST=../web/dist PORT=47140 SEED_DEMO=true npm run build && node dist/main.mjs
```

### TestFlight

**The Sign In with Apple capability.** `app.config.ts` sets `ios.usesAppleSignIn: true`, so
`expo prebuild` adds the `com.apple.developer.applesignin` entitlement to the generated Xcode
project — but the **App ID** itself needs the "Sign In with Apple" capability turned on in the Apple
Developer Portal first (Certificates, Identifiers & Profiles → Identifiers → the app's bundle id →
Capabilities), and the **App Store provisioning profile** regenerated after that change — a profile
only lists the capabilities its App ID had when it was made, so an older one will not carry this
entitlement until a fresh one is pulled. Both are manual steps in Apple's own console; neither
`prebuild.sh` nor `archive.sh` can do them. Skipping either one fails the archive's
`-allowProvisioningUpdates` step (or, if that step papers over it, fails Apple's own entitlement
check once installed) with a profile/entitlement mismatch, not a Book Club bug.

```bash
apps/mobile/scripts/setup-mac-ec2.sh   # once: also makes build.keychain, codesigning needs one
export ASC_KEY_ID=...        # the App Store Connect API key, from wherever you keep secrets (never print it)
export ASC_ISSUER_ID=...
export ASC_PRIVATE_KEY_PATH=~/bookclub/private/AuthKey_<id>.p8   # mode 600; delete when done
export DEVELOPMENT_TEAM=...  # the Apple Developer Team ID (below)
export BOOKCLUB_APS_ENVIRONMENT=production   # archive.sh also reads it back from the generated entitlements
# the production server, not prebuild.sh's simulator default (also what over-the-air updates expect)
BOOKCLUB_SERVER_URL=https://books.badland.ai apps/mobile/scripts/prebuild.sh
apps/mobile/scripts/archive.sh
apps/mobile/scripts/upload.sh
```

Both `archive.sh` and `upload.sh` use `-allowProvisioningUpdates` with the App Store Connect API
key for automatic signing — no Apple ID sign-in on the build box. This does **not** submit
anything for App Store review — only a TestFlight build upload.

What a first real archive needs, learned the hard way:

- `xcodebuild archive` needs `DEVELOPMENT_TEAM` set (an Apple Developer Team ID, ten characters,
  from developer.apple.com's membership page — a different thing from `ASC_ISSUER_ID`). `expo
  prebuild` sets none; without it, archiving fails with "Signing... requires a development team"
  before it ever reaches Apple.
- A fresh SSH session on a Mac has no default keychain at all (no GUI session is logged in), so
  codesigning has nowhere to work; `scripts/setup-mac-ec2.sh` creates and unlocks a dedicated
  `build.keychain` for this (its own section, with why).
- On a build Mac that already holds a development certificate for the team (another project's),
  Xcode's automatic signing offers to revoke it and mint a new one. Do not: use manual signing
  instead. With an **Apple Distribution** certificate made from a key of its own and an App Store
  profile for the app, `plugins/with-manual-signing.ts` signs the app target, and only it, when
  `BOOKCLUB_SIGNING_TEAM` and `BOOKCLUB_SIGNING_PROFILE` are set (`prebuild.sh`, then `archive.sh`,
  which then exports with manual signing too); no existing certificate is revoked or reused.
- Two more things the box needs: Apple's WWDR G3 intermediate in the keychain, and the archive run
  in the user's own security session (`archive.sh` does this itself over SSH, with
  `launchctl asuser`): an SSH session alone gets `errSecInternalComponent` from codesign however the
  keychain is set up.
- The app record must exist in App Store Connect (its website) before the first upload, or
  `upload.sh` stops on "Unable to find Apple ID for Bundle ID".

**On a shared build Mac**, the default keychain and the keychain search list are global to the
user: changing them can break another project's release. `setup-mac-ec2.sh` touches neither, and
`archive.sh` adds `build.keychain` to the search list only while it runs and puts the list back on
exit. Keep the signing key and the profile off shared machines (on your own, mode 700); the signed
`.ipa` can be uploaded from anywhere with Xcode's `altool` and the API key (`upload.sh`).

## Over-the-air updates

EAS Update (D180) ships this app's **own** JavaScript to builds already installed, with no new
build and no App Review: the audio and auth engines, the WebView glue, push routing — everything
under `src/`, `App.tsx` and `index.ts`. The web app inside the WebView (the reader, chat, notes,
everything people actually see) is not part of it and never needed it: it already updates the
moment the server deploys.

The EAS project is `app.config.ts`'s `KNOWN_EAS_PROJECT_ID` (`EAS_PROJECT_ID` points a build at
another, such as a fork's own from `eas init`; `EAS_OWNER` names its owner if needed). A build
listens on one channel, set when it is built:

| Channel       | Builds on it                                                    | Publish with                                    |
|---------------|-----------------------------------------------------------------|-------------------------------------------------|
| `production`  | TestFlight / App Store archives (`BOOKCLUB_APS_ENVIRONMENT=production`) | `pnpm --filter @bookclub/mobile update:production` |
| `preview`     | internal archives built with `BOOKCLUB_UPDATE_CHANNEL=preview`  | `pnpm --filter @bookclub/mobile update:preview`  |
| `development` | every other build (simulator, local device builds)              | `pnpm --filter @bookclub/mobile update:development` |

`eas build` sets the channel from its profile (`eas.json`); a build made here with `prebuild.sh` +
`archive.sh` gets it from `app.config.ts` (the `expo-channel-name` request header), and
`prebuild.sh` says which one it got. A build checks once per cold start and never waits for the
network: a new update downloads in the background and runs from the **next** cold start.

### Shipping one

```bash
export EXPO_TOKEN=...   # an Expo access token; or `eas login` once instead (never print it)
pnpm --filter @bookclub/mobile update:production                  # message: the last commit subject
pnpm --filter @bookclub/mobile update:production "fix the audio bridge"     # or your own
```

`scripts/publish-update.sh` checks the channel, sets up the same environment the channel's builds
were made with (preview and production: `BOOKCLUB_APS_ENVIRONMENT=production` and the production
server; it refuses a `BOOKCLUB_SERVER_URL` pointing anywhere else), prints the **runtime version**
it is publishing for, and runs `eas update --channel <c> --environment <c> --platform ios`
(`eas` if installed, otherwise `npx eas-cli@27.2.0`). For a simulator build on `development`,
publish with the `BOOKCLUB_SERVER_URL` its prebuild had (`http://127.0.0.1:47140`).

### OTA update, or a new native build?

An update reaches only builds with the same **runtime version**, a fingerprint of everything
native (`runtimeVersion: { policy: 'fingerprint' }`; what is in it is in `fingerprint.config.js`).
So the rule enforces itself: if a change needs a new build, its updates simply never reach the old
ones (they keep running what they have) rather than crashing them.

- **OTA is enough** for any change to this app's JavaScript or TypeScript (`src/`, `App.tsx`)
  that adds no native module, and for anything in `apps/web` or the server (those need no update
  at all, only a deploy).
- **A new build is needed** for: adding, removing or upgrading a package with native code (any
  `expo-*`, `react-native-*`, an Expo SDK bump), any change to `app.config.ts` that reaches
  Info.plist or entitlements (permissions, `scheme`, bundle id, the APNs environment, the
  app-bound domains), a config plugin (`plugins/`) or its props, the icon or splash. Bumping
  `ios.buildNumber` or `version` alone does not change the runtime version.

To check before relying on an update: `pnpm --filter @bookclub/mobile runtime-version` prints what
a build made now would have (prefix `BOOKCLUB_APS_ENVIRONMENT=production` for an archive's;
`--debug` lists every source hashed). A build's own is inside its `.app`, in
`EXUpdates.bundle/fingerprint` (unzip the `.ipa`: `Payload/*.app/EXUpdates.bundle/fingerprint`),
computed by Xcode during the archive with the archive's environment. That is why `archive.sh`
takes the APNs environment from the entitlements prebuild generated (and refuses anything but
`production`), and passes `BOOKCLUB_UPDATE_CHANNEL` and `EAS_PROJECT_ID` through with the rest. If an update does not
arrive, the two differ: rebuild, or publish from the environment that build was made in.

`test/app-config.test.ts` (in the gate: `pnpm --filter @bookclub/mobile test`,
`scripts/test-ci.sh`) runs the real expo-updates resolver to pin what the runtime version follows
(the APNs environment, the app-bound domains) and what it must not (the project id, the channel,
signing), so that a build and a publish made on different machines agree.

## App identity

Display name "Book Club", bundle id `ai.badland.books` (the published app's own: the reverse of
its production site, books.badland.ai). The icon and splash (`assets/icon.svg` →
`assets/icon.png`, `assets/splash.png`) are an open codex with a sanguine ribbon bookmark in the
manuscript look (parchment `#f4ead2`, ink `#2a1c12`, sanguine `#93361c`) — a vector shape rather
than lettering, so nothing depends on a font being installed wherever it is rasterised (D137).

**Shipping your own app from a fork.** The bundle id, the App Group and the production server are
this app's own. A fork that ships its own changes `BUNDLE_ID`, `APP_GROUP` and
`DEFAULT_SERVER_URL` in `app.config.ts`, the App Group in
`modules/book-club-native/ios/NowPlayingController.swift` and `targets/widgets/Snapshot.swift` (and
the notification name beside it in `targets/widgets/_shared/TogglePlaybackIntent.swift`),
`PRODUCTION_SERVER_URL` in `scripts/publish-update.sh`, and `KNOWN_EAS_PROJECT_ID` (or sets
`EAS_PROJECT_ID`). Each of these is native, so the result is a new app with a runtime version of
its own, never an update to this one.

## What is not built

- **"Sign in with Apple" on the web sign-in page** (D178): the design calls for it only once a
  Services ID is configured for a browser-based Apple flow, and none is yet. The server-side piece (token verification, account linking) is
  shared with the native path and fully built and tested; only the Services ID, its own
  authorization-endpoint redirect, and a `form_post` callback route remain, whenever a Services ID
  exists to configure them against.
- **Offline audiobook playback from downloaded files** (D138): implemented for "the book you are
  listening to now" — `NativeAudioEngine` downloads a track to `expo-file-system` the first time
  it plays and plays from that local copy on every load after, with no change to how the web app
  decides what to play. The copy is named with the extension its own bytes say (AVFoundation
  cannot open a local file without one), and a copy that fails to play is dropped and the track
  goes on from the network (D219). What is *not* built is the web app's explicit "save for offline" button
  (`apps/web/src/lib/offline.ts`'s `saveEditionOffline`) reaching native at all — saving an
  audiobook offline there still only fills the browser's Cache Storage, which this app's own
  playback does not read from. Finishing this needs one more bridge message (the web side telling
  native which edition's tracks to fetch ahead of time, not just the one playing) and a storage
  cap/eviction policy once a club has more than one long audiobook's worth of local files.
- No Jest/Detox/XCUITest project here (D139): verification is the scripted simulator run plus a
  manual screenshot pass, not an automated UI test suite, which would need its own setup on the
  build Mac. The web-side bridge is unit-tested; the native glue is not, beyond typecheck.

## Widgets and the Live Activity (D188, D189)

`targets/widgets` is a WidgetKit extension made at prebuild by `@bacons/apple-targets`: "Your book"
and "Next club stop" widgets for the Home Screen and the Lock Screen, and the audiobook's Live
Activity (Lock Screen and Dynamic Island, with Play/Pause), which the person turns on in Settings.
`modules/book-club-native` is a local Expo module the app uses to hand the widgets their data
(through the App Group `group.ai.badland.books`) and to drive the Live Activity. Swift in both is
typechecked without a build:

```bash
cd apps/mobile/targets/widgets && xcrun --sdk iphoneos swiftc -typecheck -target arm64-apple-ios17.0 -parse-as-library *.swift _shared/*.swift
cd ../../modules/book-club-native && xcrun --sdk iphoneos swiftc -typecheck -target arm64-apple-ios17.0 ios/NowPlayingAttributes.swift ios/NowPlayingController.swift
```

Before the first build with them, these must exist in the Apple Developer portal (Certificates,
Identifiers & Profiles; manual, nothing here can do them):

1. **The App Group**: Identifiers → App Groups → "+": `group.` and the app's bundle id.
2. **The app's App ID**: App Groups turned on, with that group selected.
3. **An App ID for the extension**: the app's bundle id plus `.widgets` (explicit), App Groups on,
   the same group.
4. **Profiles**: the app's App Store profile regenerated after step 2, and one for the extension;
   both installed on the build Mac.
5. **The build**: `BOOKCLUB_SIGNING_TEAM=… BOOKCLUB_SIGNING_PROFILE="…"
   BOOKCLUB_SIGNING_WIDGETS_PROFILE="…" apps/mobile/scripts/prebuild.sh`, then
   `apps/mobile/scripts/archive.sh` with the same variables (it adds the extension's profile to the
   export options).

On the first run: the widgets appear in the gallery and show "Open Book Club…" before sign-in and
the current book after the app opens once; with Settings → Live Activity on, playing the audiobook
shows it on the Lock Screen and in the Dynamic Island, where Play/Pause works with the phone locked;
a widget tap opens the book page; signing out empties the widgets.

## Book Club in iMessage (D220)

`targets/messages` is a Messages app extension: from the app drawer in a conversation, invite
someone to a club, share how far you are in your current book, put the club's open vote on the next
book in the thread, or ask who is coming to a meet-up. A vote or meet-up is a live bubble: each
person's own phone draws it from what the server tells *them*, and answering sends the same bubble
again, so it updates in place. Someone without the app gets a link to `/m#…`, which the web app
opens (the invite, the book, the vote) behind the usual sign-in.

- **What a message holds.** Ids, the book's title and the sender's own place: never a passage, a
  comment, a cover or anyone else's progress, because everyone in the thread sees the same bubble and
  not all of them are in the club. The format is `packages/shared/src/messages/imessage.ts` and its
  Swift twin `targets/messages/_shared/BookClubMessage.swift`, held to one set of golden vectors:
  `scripts/test-messages-swift.sh` runs the Swift half on any Mac (no simulator); CI runs the rest.
- **How it is signed in.** The app copies its session cookie into a keychain item in the App Group's
  access group (`SharedSession.swift`, the same file in `modules/book-club-native/ios`), each time the
  page sends the widgets their snapshot and each time the app comes to the front; signed out, it is
  deleted. Before the app has been opened signed in, the extension says to open it.
- **Votes and meet-ups** appear only where the server has the next-book picker and meet-ups; on one
  without them, the drawer offers the invite and your place.
- **The target.** `@bacons/apple-targets` makes it from its `imessage` type, which is a sticker
  pack; `plugins/with-messages-extension.ts` makes it an app extension (the
  `app-extension.messages` product type, `MessagesViewController`). That plugin is listed before
  `@bacons/apple-targets` in app.config.ts, on purpose (see its comment). Its icon is the
  4:3 "iMessage App Icon" set in `targets/messages/Assets.xcassets`.

**It is in a store build only once `STORE_TARGETS.messages` in app.config.ts is `true`**: until
then the build has the widgets alone, exactly as before, so an App Store archive signs before the
extension's profile exists. It is a setting in the repository, not an environment variable, because
the runtime version (D180) is computed from the config on several machines and they must all see
the same targets. A local simulator build can add it with `BOOKCLUB_MESSAGES=1` (never an archive):
`BOOKCLUB_MESSAGES=1 BOOKCLUB_SERVER_URL=http://127.0.0.1:47140 scripts/prebuild.sh`, then open
Messages in the simulator, a conversation, "+", Book Club.

Before the first signed build with it, in the Apple Developer portal (manual):

1. **An App ID for the extension**: the app's bundle id plus `.messages` (explicit), App Groups
   on, with `group.ai.badland.books` selected (the same group as the app and the widgets). The App
   ID exists, with App Groups on; the group itself can be chosen only in the portal.
2. **A profile** for it (App Store), installed on the build Mac.
3. **Turn it on**: `STORE_TARGETS.messages = true` in app.config.ts, in a PR (a new native build).
4. **The build**: `BOOKCLUB_SIGNING_MESSAGES_PROFILE="…"` beside the widgets' profile, for
   `prebuild.sh` and `archive.sh`.
