/**
 * The bridge to the iOS app's native "Sign in with Apple" and "Continue with Google" (D178):
 * parallel in shape to `player/native-bridge.ts`'s audio bridge (the same
 * `window.BookClubNative.postMessage` outbound channel everything native shares), but its own
 * inbound channel — `window.__bookClubAuthReceive`, not that file's `__bookClubReceive` — so the
 * two can never cross-talk. `apps/mobile/src/webview/BookClubWebView.tsx`'s single `onMessage`
 * forwards every message from the page to both native engines; each one's own `default: return`
 * (`NativeAudioEngine.handle`, and this feature's sibling `NativeAuthEngine.handle`) quietly
 * ignores whatever is not its own, the same way `NativeAudioEngine` already ignores anything that
 * is not an audio command.
 *
 * Apple is fully native end to end: `expo-apple-authentication` gets an identity token
 * in-process, with no browser involved, so the result comes straight back. Google is a browser
 * session native opens and closes around Google's own pages
 * (`WebBrowser.openAuthSessionAsync`); the result that comes back is the one-time app-code
 * handoff's `code` and the PKCE `verifier` native generated before opening that session
 * (`auth/google.ts`'s own comment walks the whole round trip) — this page redeems it with
 * `POST /api/auth/app-code` (`lib/api.ts`'s `redeemAppCode`) so the session cookie that sets lands
 * in the WebView's own cookie store, not the ephemeral browser session's.
 */
import { isNativeApp } from '../player/native-bridge';

export type NativeAuthCommand = { readonly type: 'auth:apple' } | { readonly type: 'auth:google' };

export type NativeAuthResult =
  | { readonly type: 'auth:apple-result'; readonly ok: true; readonly identityToken: string; readonly nonce: string; readonly fullName?: string }
  | { readonly type: 'auth:apple-result'; readonly ok: false; readonly reason: string }
  | { readonly type: 'auth:google-result'; readonly ok: true; readonly code: string; readonly verifier: string }
  | { readonly type: 'auth:google-result'; readonly ok: false; readonly reason: string };

declare global {
  interface Window {
    __bookClubAuthReceive?: (json: string) => void;
  }
}

function post(command: NativeAuthCommand): void {
  window.BookClubNative?.postMessage(JSON.stringify(command));
}

let listener: ((result: NativeAuthResult) => void) | null = null;

/** Call once, early (`main.tsx`, beside `installNativeNavigationBridge`): before any page could need it. */
export function installNativeAuthBridge(): void {
  window.__bookClubAuthReceive = (json: string) => {
    let msg: NativeAuthResult;
    try {
      msg = JSON.parse(json) as NativeAuthResult;
    } catch {
      return;
    }
    listener?.(msg);
  };
}

/** Ask native to run one provider's sign-in, and wait for its one answer (never both at once). */
function ask<T extends NativeAuthResult['type']>(command: NativeAuthCommand, type: T): Promise<Extract<NativeAuthResult, { type: T }>> {
  if (!isNativeApp()) return Promise.resolve({ type, ok: false, reason: 'not running in the app' } as Extract<NativeAuthResult, { type: T }>);
  return new Promise((resolve) => {
    listener = (result) => {
      if (result.type !== type) return;
      listener = null;
      resolve(result as Extract<NativeAuthResult, { type: T }>);
    };
    post(command);
  });
}

export const requestAppleSignIn = () => ask({ type: 'auth:apple' }, 'auth:apple-result');
export const requestGoogleSignIn = () => ask({ type: 'auth:google' }, 'auth:google-result');
