import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

/** The config groups D178 added: each provider is off until fully configured, never half. */

const BASE = { NODE_ENV: 'test', DATA_DIR: '.data-config-test', SCRYPT_LOG_N: '12' } as const;

describe('Apple and Google sign-in config (D178)', () => {
  it('leaves both providers off when none of their settings are present', () => {
    const config = loadConfig({ ...BASE });
    expect(config.apple).toBeNull();
    expect(config.google).toBeNull();
  });

  it('turns Apple on from a comma-separated allow-list, trimmed', () => {
    const config = loadConfig({ ...BASE, APPLE_AUDIENCES: ' com.example.bookclub , com.example.bookclub.web ' });
    expect(config.apple).toEqual({ audiences: ['com.example.bookclub', 'com.example.bookclub.web'] });
  });

  it('refuses an APPLE_AUDIENCES that lists nothing usable', () => {
    expect(() => loadConfig({ ...BASE, APPLE_AUDIENCES: ' , , ' })).toThrow();
  });

  it('treats an empty APPLE_AUDIENCES the same as unset', () => {
    expect(loadConfig({ ...BASE, APPLE_AUDIENCES: '' }).apple).toBeNull();
  });

  it('turns Google on only with all three settings, and refuses any two of three', () => {
    const full = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'https://books.example/api/auth/google/callback' };
    expect(loadConfig({ ...BASE, ...full }).google).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: full.GOOGLE_REDIRECT_URI,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
    });
    expect(() => loadConfig({ ...BASE, GOOGLE_CLIENT_ID: full.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: full.GOOGLE_CLIENT_SECRET })).toThrow();
    expect(() => loadConfig({ ...BASE, GOOGLE_CLIENT_ID: full.GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI: full.GOOGLE_REDIRECT_URI })).toThrow();
    expect(() => loadConfig({ ...BASE, GOOGLE_CLIENT_SECRET: full.GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI: full.GOOGLE_REDIRECT_URI })).toThrow();
  });

  it('lets the demo stack point Google at a local stand-in (tools/fake-google), overriding the real endpoints', () => {
    const config = loadConfig({
      ...BASE,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'https://books.example/api/auth/google/callback',
      GOOGLE_AUTH_URL: 'http://127.0.0.1:47102/o/oauth2/v2/auth',
      GOOGLE_TOKEN_URL: 'http://google:8082/token',
      GOOGLE_JWKS_URL: 'http://google:8082/jwks',
      GOOGLE_ISSUERS: 'http://google:8082',
    });
    expect(config.google).toMatchObject({ authUrl: 'http://127.0.0.1:47102/o/oauth2/v2/auth', tokenUrl: 'http://google:8082/token', jwksUrl: 'http://google:8082/jwks', issuers: ['http://google:8082'] });
  });

  it('refuses a GOOGLE_REDIRECT_URI that is not an http(s) address', () => {
    expect(() => loadConfig({ ...BASE, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'bookclub://auth' })).toThrow();
  });
});
