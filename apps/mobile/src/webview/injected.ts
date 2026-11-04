/**
 * Run before any page script (`injectedJavaScriptBeforeContentLoaded`): defines
 * `window.BookClubNative`, the handle `apps/web/src/player/native-bridge.ts` looks for to know
 * it is running inside this app rather than a browser, and through which it sends native-audio,
 * media-session and (D178) native Apple/Google sign-in commands alike — one outbound channel for
 * everything native, which `BookClubWebView.tsx`'s `onMessage` forwards to whichever engine
 * (`NativeAudioEngine`, `NativeAuthEngine`) owns a given message's `type`.
 *
 * Kept in sync by hand with the `NativeAudioCommand` union in `apps/web/src/player/native-bridge.ts`
 * (D130) and the `NativeAuthCommand` union in `apps/web/src/auth/native-auth-bridge.ts` (D178):
 * the two projects build separately, and this is deliberately too small to drift — a
 * pass-through to `ReactNativeWebView.postMessage`, nothing of its own to get wrong. `maxRate`
 * tells the page how fast this build's player goes (`maxPlayableRate`, native-bridge.ts, D195).
 */
export const INJECTED_BOOTSTRAP = `
(function () {
  if (window.BookClubNative) return true;
  window.BookClubNative = {
    postMessage: function (json) {
      window.ReactNativeWebView.postMessage(json);
    },
    // The fastest speed this build's player plays (D195: expo-audio patched past its own 2x).
    maxRate: 3,
  };
  true;
})();
`;
