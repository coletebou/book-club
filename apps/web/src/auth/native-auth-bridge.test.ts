import { afterEach, describe, expect, it, vi } from 'vitest';
import { installNativeAuthBridge, requestAppleSignIn, requestGoogleSignIn } from './native-auth-bridge';

/** As `apps/mobile/src/webview/injected.ts` defines it, for tests that are not inside the app. */
function enterNativeApp(): { posted: unknown[] } {
  const posted: unknown[] = [];
  window.BookClubNative = { postMessage: (json: string) => posted.push(JSON.parse(json)) };
  return { posted };
}

afterEach(() => {
  delete window.BookClubNative;
  delete window.__bookClubAuthReceive;
  vi.restoreAllMocks();
});

describe('the native Apple/Google sign-in bridge (D178)', () => {
  it('answers "not running in the app" without asking native, outside the app', async () => {
    const result = await requestAppleSignIn();
    expect(result).toEqual({ type: 'auth:apple-result', ok: false, reason: 'not running in the app' });
  });

  it('posts an Apple request and resolves with whatever native sends back through __bookClubAuthReceive', async () => {
    installNativeAuthBridge();
    const { posted } = enterNativeApp();
    const pending = requestAppleSignIn();
    expect(posted).toEqual([{ type: 'auth:apple' }]);
    window.__bookClubAuthReceive!(JSON.stringify({ type: 'auth:apple-result', ok: true, identityToken: 'tok', nonce: 'raw-nonce', fullName: 'Ana' }));
    await expect(pending).resolves.toEqual({ type: 'auth:apple-result', ok: true, identityToken: 'tok', nonce: 'raw-nonce', fullName: 'Ana' });
  });

  it('posts a Google request and resolves with whatever native sends back, independently of Apple', async () => {
    installNativeAuthBridge();
    const { posted } = enterNativeApp();
    const pending = requestGoogleSignIn();
    expect(posted).toEqual([{ type: 'auth:google' }]);
    window.__bookClubAuthReceive!(JSON.stringify({ type: 'auth:google-result', ok: true, code: 'c1', verifier: 'v1' }));
    await expect(pending).resolves.toEqual({ type: 'auth:google-result', ok: true, code: 'c1', verifier: 'v1' });
  });

  it('carries a refusal (a dismissed sheet, a failed native sign-in) through unchanged', async () => {
    installNativeAuthBridge();
    enterNativeApp();
    const pending = requestAppleSignIn();
    window.__bookClubAuthReceive!(JSON.stringify({ type: 'auth:apple-result', ok: false, reason: 'canceled' }));
    await expect(pending).resolves.toEqual({ type: 'auth:apple-result', ok: false, reason: 'canceled' });
  });

  it('ignores a message of the other provider and a malformed one, and still resolves on its own answer', async () => {
    installNativeAuthBridge();
    enterNativeApp();
    const pending = requestGoogleSignIn();
    window.__bookClubAuthReceive!('not json');
    window.__bookClubAuthReceive!(JSON.stringify({ type: 'auth:apple-result', ok: true, identityToken: 't', nonce: 'n' }));
    window.__bookClubAuthReceive!(JSON.stringify({ type: 'auth:google-result', ok: true, code: 'c2', verifier: 'v2' }));
    await expect(pending).resolves.toEqual({ type: 'auth:google-result', ok: true, code: 'c2', verifier: 'v2' });
  });
});
