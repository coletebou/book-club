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
 * the two projects build separately. `maxRate` tells the page how fast this build's player goes
 * (`maxPlayableRate`, native-bridge.ts, D195). The same bridge also enforces CarPlay capture
 * state before the page starts (D248).
 */
export function nativeBootstrap(carConnected: boolean): string {
  return `
(function () {
  if (window.BookClubNative) return true;
  const native = window.BookClubNative = {
    postMessage: function (json) {
      window.ReactNativeWebView.postMessage(json);
    },
    // The fastest speed this build's player plays (D195: expo-audio patched past its own 2x).
    maxRate: 3,
    carPlayConnected: ${carConnected},
  };

  // WebKit can reuse a previous media grant without asking the WebView for permission again.
  const media = window.navigator?.mediaDevices;
  if (media?.getUserMedia) {
    const getUserMedia = media.getUserMedia.bind(media);
    const active = new Set();
    let generation = 0;
    const denied = () => new DOMException('Capture is unavailable while CarPlay is connected', 'NotAllowedError');
    window.addEventListener('bookclub:carplay-connection', () => {
      if (!native.carPlayConnected) return;
      generation++;
      for (const track of active) track.stop();
      active.clear();
    });
    media.getUserMedia = async (constraints) => {
      if (native.carPlayConnected) throw denied();
      const started = generation;
      const stream = await getUserMedia(constraints);
      const tracks = stream.getTracks();
      if (started !== generation || native.carPlayConnected) {
        for (const track of tracks) track.stop();
        throw denied();
      }
      for (const track of active) if (track.readyState === 'ended') active.delete(track);
      for (const track of tracks) active.add(track);
      return stream;
    };
  }
  return true;
})();
`;
}

/** A page ready to receive commands sees the new state before capture listeners run. */
export function carPlayConnectionScript(connected: boolean): string {
  return `
(function () {
  var native = window.BookClubNative;
  if (!native || native.carPlayConnected === ${connected}) return true;
  native.carPlayConnected = ${connected};
  window.dispatchEvent(new Event('bookclub:carplay-connection'));
  return true;
})();
`;
}
