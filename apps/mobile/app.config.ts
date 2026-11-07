import { type ExpoConfig } from 'expo/config';
import { type AppBoundDomainsProps } from './plugins/with-app-bound-domains';
import { type ManualSigningProps } from './plugins/with-manual-signing';

/**
 * Book Club for iOS (D130-D139): a native shell around the shared web reader. Most of the app is
 * `apps/web` running in a WebView; what this project owns is what a WebView does badly on iOS —
 * background audio with lock-screen controls, push, camera/mic permissions, and the service
 * worker's offline reading (which needs App-Bound Domains, below).
 *
 * The default server is the production site; `BOOKCLUB_SERVER_URL` points a dev build at a dev
 * stack instead (scripts/run-simulator.sh sets it to the Mac EC2's own `127.0.0.1:47140`, which
 * the Simulator reaches as the host's own loopback).
 */
const DEFAULT_SERVER_URL = 'https://books.badland.ai';
const BUNDLE_ID = 'ai.badland.books';
const serverUrl = process.env.BOOKCLUB_SERVER_URL ?? DEFAULT_SERVER_URL;

/** Apple accepts up to 10 app-bound domains (WKAppBoundDomains); the production host is always one. */
function appBoundDomains(): string[] {
  const hosts = new Set<string>([new URL(DEFAULT_SERVER_URL).hostname]);
  try {
    hosts.add(new URL(serverUrl).hostname);
  } catch {
    // an invalid BOOKCLUB_SERVER_URL just means the dev build only trusts the production host
  }
  return [...hosts];
}

/**
 * `aps-environment` (D134): a build signed for the sandbox (every build but a TestFlight/App
 * Store archive) gets the sandbox APNs environment; `scripts/archive.sh` sets this to
 * "production" for the real thing.
 */
const apsEnvironment = process.env.BOOKCLUB_APS_ENVIRONMENT === 'production' ? 'production' : 'development';

/**
 * Manual signing for the App Store archive (scripts/archive.sh sets both): a named Apple
 * Distribution certificate and App Store profile, never automatic signing (D137 addendum).
 */
const manualSigning: ManualSigningProps | null =
  process.env.BOOKCLUB_SIGNING_TEAM && process.env.BOOKCLUB_SIGNING_PROFILE
    ? {
        team: process.env.BOOKCLUB_SIGNING_TEAM,
        profile: process.env.BOOKCLUB_SIGNING_PROFILE,
        // The widget extension (D189) is a second target with its own App ID and App Store profile.
        ...(process.env.BOOKCLUB_SIGNING_WIDGETS_PROFILE ? { extensions: { [`${BUNDLE_ID}.widgets`]: process.env.BOOKCLUB_SIGNING_WIDGETS_PROFILE } } : {}),
      }
    : null;

/**
 * The App Group the app shares with its widget extension (D189): the page's snapshot for the
 * widgets and the books' covers pass through it. Needs the App Groups capability on both App IDs.
 */
const APP_GROUP = 'group.ai.badland.books';

/**
 * Over-the-air updates (D180): EAS Update serves this app's own JavaScript (the bridge, the
 * audio and auth engines), never the web app, which the server already ships on its own.
 *
 * The EAS project's id (from `eas init`, 2026-11-01) is not a secret (every installed build carries
 * it) and is written here, so that no build or publish can forget it; `EAS_PROJECT_ID` points a
 * build at another project instead (a test one, or a fork's own). Without any id, updates are off:
 * the build runs only the JavaScript it was built with, as before D180. The project's owner is
 * left out unless `EAS_OWNER` names one: EAS reads it from the project itself since SDK 53 (and
 * checks it only when it is set), and the runtime version never includes it (fingerprint.config.js).
 */
const EAS_OWNER: string | undefined = process.env.EAS_OWNER || undefined;
const KNOWN_EAS_PROJECT_ID: string | undefined = '1b9b49f4-73c8-477e-8b2e-2433b98a4faf';
const easProjectId = process.env.EAS_PROJECT_ID || KNOWN_EAS_PROJECT_ID;

/**
 * The update channel a build listens on. `eas build` writes its profile's channel (eas.json) into
 * the binary itself; a build made here with `expo prebuild` + `xcodebuild` (D130) only knows its
 * channel through this request header. A TestFlight archive (`BOOKCLUB_APS_ENVIRONMENT=production`)
 * listens on "production" and every other build on "development", unless
 * `BOOKCLUB_UPDATE_CHANNEL` says otherwise (e.g. "preview").
 */
const UPDATE_CHANNELS = ['development', 'preview', 'production'] as const;
type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
function updateChannel(): UpdateChannel {
  const requested = process.env.BOOKCLUB_UPDATE_CHANNEL;
  if (requested) {
    if (!(UPDATE_CHANNELS as readonly string[]).includes(requested)) {
      throw new Error(`BOOKCLUB_UPDATE_CHANNEL must be one of ${UPDATE_CHANNELS.join(', ')}, not "${requested}"`);
    }
    return requested as UpdateChannel;
  }
  return apsEnvironment === 'production' ? 'production' : 'development';
}

const updates: ExpoConfig['updates'] = easProjectId
  ? {
      enabled: true,
      url: `https://u.expo.dev/${easProjectId}`,
      // Look once per cold start; never hold the launch for the network (0 ms): a new update is
      // downloaded in the background and runs from the next cold start on.
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
      requestHeaders: { 'expo-channel-name': updateChannel() },
    }
  : { enabled: false };

const config: ExpoConfig = {
  name: 'Book Club',
  slug: 'book-club',
  ...(EAS_OWNER ? { owner: EAS_OWNER } : {}),
  scheme: 'bookclub',
  version: '1.0.0',
  orientation: 'default',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  // An update runs only on a build with the same native code (D180): the runtime version is a
  // hash of everything native (dependencies, config plugins, this config), so adding a native
  // module or changing a plugin gives a new runtime that old builds never download updates for.
  runtimeVersion: { policy: 'fingerprint' },
  // Pinned, not detected: the config is part of that hash, and Expo detects "web" whenever react-dom
  // resolves. Under pnpm's bin shims it does (NODE_PATH reaches the workspace store, where apps/web's
  // react-dom is hoisted), under Xcode's build phase it does not, so `runtime-version` and a publish
  // would hash differently from every build. These two are what Xcode detects, so builds keep theirs.
  platforms: ['ios', 'android'],
  updates,
  ios: {
    bundleIdentifier: BUNDLE_ID,
    buildNumber: '5',
    supportsTablet: true,
    // Native "Sign in with Apple" (D178): adds the `com.apple.developer.applesignin` entitlement
    // at prebuild time. The App ID itself must also have the Sign In with Apple capability turned
    // on in the Apple Developer portal, and the provisioning profile regenerated after — neither
    // is something `expo prebuild` can do; see README.md's "TestFlight" section.
    usesAppleSignIn: true,
    entitlements: {
      'com.apple.security.application-groups': [APP_GROUP],
    },
    infoPlist: {
      NSCameraUsageDescription: 'Book Club uses your camera for photo and video notes you leave for your club.',
      // Export compliance: only HTTPS and Apple's own system crypto, which is exempt, so TestFlight
      // builds no longer wait on "Missing Compliance" (1.0.0 (3) did). A widgets extension
      // (D189) needs the same key in its own Info.plist.
      ITSAppUsesNonExemptEncryption: false,
      // The audiobook's Live Activity (D189), when the person turns it on in Settings (D188).
      NSSupportsLiveActivities: true,
      // WKAppBoundDomains itself (withAppBoundDomains sets the array); limitsNavigationsToAppBoundDomains
      // is a WebView prop (src/webview/BookClubWebView.tsx), not an Info.plist key.
    },
  },
  extra: {
    serverUrl,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
  },
  plugins: [
    [
      'expo-audio',
      {
        // The mic permission is shared with voice notes, voice channels and talking to Cal (the
        // same AVAudioSession), so its one description names all three (D132).
        microphonePermission: 'Book Club uses your microphone for voice notes, voice channels, and talking to Cal.',
        enableBackgroundPlayback: true,
        enableBackgroundRecording: false,
      },
    ],
    ['expo-notifications', { mode: apsEnvironment }],
    // "Continue with Google" (D178): `WebBrowser.openAuthSessionAsync` needs no permission or
    // entitlement on iOS, but `npx expo install` still wants this plugin listed (its config
    // plugin is a no-op here; Android's own intent-filter wiring is what it is really for).
    'expo-web-browser',
    [
      'expo-splash-screen',
      {
        image: './assets/splash.png',
        resizeMode: 'contain',
        // The manuscript look's parchment (D137; docs/ARCHITECTURE.md, "Look and feel").
        backgroundColor: '#f4ead2',
      },
    ],
    // A local plugin by path, not by reference: `ExpoConfig['plugins']` types each entry as a
    // module name or `[name, props]`, not a function value (even though the function itself
    // would also work at runtime); the typed, documented way to point at one of this project's
    // own files is its relative path, same as a package name.
    ['./plugins/with-app-bound-domains', { domains: appBoundDomains() } satisfies AppBoundDomainsProps],
    ['./plugins/with-manual-signing', manualSigning],
    // The widget extension in targets/widgets (D189): Home Screen and Lock Screen widgets, and the
    // audiobook's Live Activity.
    '@bacons/apple-targets',
  ],
};

export default config;
