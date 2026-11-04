import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { SERVER_URL } from '../config';

/**
 * The native half of the sign-in bridge (D178). The web half,
 * `apps/web/src/auth/native-auth-bridge.ts`, asks for one provider and waits for one answer;
 * this is where that answer actually comes from.
 *
 * Apple is entirely in-process: `expo-apple-authentication` gets a signed identity token with no
 * network request of this app's own. The nonce follows Apple's own documented convention (and
 * every other client's, Firebase's among them) — a random raw value, SHA-256 hashed (hex) before
 * it is handed to `signInAsync`'s `nonce`, with the *raw* value sent on to the web page (and from
 * there, `POST /api/auth/apple`), which redoes the hash to check it (`apps/server/src/auth/apple.ts`).
 *
 * Google is a browser session this app opens and closes around Google's own pages
 * (`WebBrowser.openAuthSessionAsync`, `ASWebAuthenticationSession` under the hood): this engine
 * makes its own PKCE pair first (never sent to Google — that is the server's own, separate PKCE
 * conversation with Google, `apps/server/src/auth/google.ts`), passes the challenge to
 * `GET /api/auth/google/start?app=1&challenge=…`, and gets back a `bookclub://auth?code=…`
 * redirect once the server has a signed-in Google identity to hand over. The code and this
 * engine's own verifier go to the web page, which redeems them with `POST /api/auth/app-code`
 * from inside the WebView — the whole reason for the handoff, rather than signing in directly
 * from this ephemeral browser session, is that only a cookie set from inside the WebView lands in
 * the shared cookie store native playback also reads (D133).
 */

export type SendToWeb = (json: string) => void;

/** `+/` → `-_`, no padding: RFC 4648 §5. */
function toBase64Url(standardBase64: string): string {
  return standardBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `byteLength` random bytes, base64url: this engine's own PKCE verifiers and Apple nonce. */
async function randomBase64Url(byteLength: number): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(byteLength);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  // `btoa` is part of the JS runtime (Hermes, and jsdom in this project's own tests), not a
  // React Native API: no polyfill package to add for it.
  return toBase64Url(btoa(binary));
}

/** S256 (RFC 7636): base64url(SHA-256(verifier)), matching the server's own `challengeOf`. */
async function challengeOf(verifier: string): Promise<string> {
  return toBase64Url(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));
}

/** Apple's native API expects the SHA-256 of the raw nonce, hex — not the raw value itself. */
async function hashNonce(raw: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw, { encoding: Crypto.CryptoEncoding.HEX });
}

export class NativeAuthEngine {
  constructor(private readonly send: SendToWeb) {}

  /** A command from the web bridge (`NativeAuthCommand` in native-auth-bridge.ts), as JSON. */
  handle(json: string): void {
    let cmd: { type: string };
    try {
      cmd = JSON.parse(json);
    } catch {
      return;
    }
    switch (cmd.type) {
      case 'auth:apple':
        void this.signInWithApple();
        return;
      case 'auth:google':
        void this.continueWithGoogle();
        return;
      default:
        // Not ours: the audio engine (or a future sibling) owns it, same as its own default case.
        return;
    }
  }

  private async signInWithApple(): Promise<void> {
    try {
      const rawNonce = await randomBase64Url(32);
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
        nonce: await hashNonce(rawNonce),
      });
      if (!credential.identityToken) {
        this.send(JSON.stringify({ type: 'auth:apple-result', ok: false, reason: 'Apple did not return an identity token' }));
        return;
      }
      // Apple hands back a name only on the very first authorization with this app, ever; later
      // ones carry none, and the server already has one on file by then.
      const fullName = [credential.fullName?.givenName, credential.fullName?.familyName].filter((part): part is string => !!part).join(' ').trim();
      this.send(
        JSON.stringify({
          type: 'auth:apple-result',
          ok: true,
          identityToken: credential.identityToken,
          nonce: rawNonce,
          ...(fullName ? { fullName } : {}),
        }),
      );
    } catch (err) {
      // expo-apple-authentication's own error codes: ERR_REQUEST_CANCELED is the person dismissing
      // the sheet, not a failure worth showing as one (native-auth-bridge.ts's CANCELED marker).
      const reason = (err as { code?: string } | null)?.code === 'ERR_REQUEST_CANCELED' ? 'canceled' : 'Sign in with Apple failed';
      this.send(JSON.stringify({ type: 'auth:apple-result', ok: false, reason }));
    }
  }

  private async continueWithGoogle(): Promise<void> {
    try {
      const verifier = await randomBase64Url(32);
      const start = new URL('/api/auth/google/start', SERVER_URL);
      start.searchParams.set('app', '1');
      start.searchParams.set('challenge', await challengeOf(verifier));
      const result = await WebBrowser.openAuthSessionAsync(start.href, 'bookclub://auth');
      if (result.type !== 'success' || !result.url) {
        this.send(JSON.stringify({ type: 'auth:google-result', ok: false, reason: result.type === 'cancel' || result.type === 'dismiss' ? 'canceled' : 'Continue with Google failed' }));
        return;
      }
      const code = new URL(result.url).searchParams.get('code');
      if (!code) {
        this.send(JSON.stringify({ type: 'auth:google-result', ok: false, reason: 'Google did not hand back a code' }));
        return;
      }
      this.send(JSON.stringify({ type: 'auth:google-result', ok: true, code, verifier }));
    } catch {
      this.send(JSON.stringify({ type: 'auth:google-result', ok: false, reason: 'Continue with Google failed' }));
    }
  }
}
