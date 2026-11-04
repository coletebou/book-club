import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import http2, { type ClientHttp2Session } from 'node:http2';

/**
 * Apple Push Notification service, HTTP/2, token (JWT) auth (D134). No Expo account exists, so
 * this talks to Apple directly with the team's own `.p8` key, never Expo's push service.
 */

export interface ApnsConfig {
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  /** The `.p8` key's PEM contents. */
  readonly privateKey: string;
  readonly production: boolean;
  /** Test-only: a plaintext h2c authority (`http://127.0.0.1:port`) instead of Apple's. */
  readonly authority?: string;
}

export interface ApnsPush {
  readonly title: string;
  readonly body: string;
  /** A relative path opened when the notification is tapped, e.g. `/books/<id>#note-<id>`. */
  readonly path: string;
  /** Apple replaces an earlier delivery with the same id instead of stacking a duplicate. */
  readonly collapseId: string;
}

/** What came of one delivery: sent, the token is dead and should be forgotten, or neither. */
export type ApnsOutcome = 'sent' | 'unregistered' | 'failed';

export interface ApnsClient {
  send(deviceToken: string, push: ApnsPush): Promise<ApnsOutcome>;
  close(): void;
}

const PRODUCTION_AUTHORITY = 'https://api.push.apple.com';
const SANDBOX_AUTHORITY = 'https://api.sandbox.push.apple.com';
// Apple's provider tokens are good for up to an hour; refreshed well inside that, and rate-limited
// on their side to about once every 20 minutes, so this is not regenerated per push.
const TOKEN_LIFETIME_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** The provider token: an ES256 JWT over `{iss: team id, iat}`, signed with the `.p8` key. */
function signProviderToken(config: ApnsConfig): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }));
  const key = createPrivateKey(config.privateKey);
  // JWT ES256 wants the raw (r, s) signature ("ieee-p1363"), not the DER node:crypto signs by default.
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${base64url(signature)}`;
}

/** A client bound to one key: one HTTP/2 connection to Apple, reopened if it drops. */
export function createApnsClient(config: ApnsConfig): ApnsClient {
  const authority = config.authority ?? (config.production ? PRODUCTION_AUTHORITY : SANDBOX_AUTHORITY);
  let session: ClientHttp2Session | null = null;
  let cachedToken: { jwt: string; signedAt: number } | null = null;

  function connection(): ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    const s = http2.connect(authority);
    s.on('error', () => undefined); // a dead session is just reconnected on the next send
    session = s;
    return s;
  }

  function providerToken(): string {
    if (!cachedToken || Date.now() - cachedToken.signedAt > TOKEN_LIFETIME_MS) {
      cachedToken = { jwt: signProviderToken(config), signedAt: Date.now() };
    }
    return cachedToken.jwt;
  }

  return {
    send(deviceToken, push) {
      return new Promise<ApnsOutcome>((resolve) => {
        let settled = false;
        const done = (outcome: ApnsOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        const payload = JSON.stringify({
          aps: { alert: { title: push.title, body: push.body }, 'mutable-content': 1, sound: 'default' },
          path: push.path,
        });
        let req: ReturnType<ClientHttp2Session['request']>;
        try {
          req = connection().request({
            ':method': 'POST',
            ':path': `/3/device/${deviceToken}`,
            authorization: `bearer ${providerToken()}`,
            'apns-topic': config.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-collapse-id': push.collapseId.slice(0, 64),
            'content-type': 'application/json',
          });
        } catch {
          done('failed');
          return;
        }
        const timer = setTimeout(() => {
          req.destroy();
          done('failed');
        }, REQUEST_TIMEOUT_MS);
        let status = 0;
        let body = '';
        req.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          body += chunk;
        });
        req.on('end', () => {
          if (status === 200) return done('sent');
          // Unregistered (the app was deleted, or this token is stale): APNs says 410.
          if (status === 410) return done('unregistered');
          if (status === 400) {
            // BadDeviceToken: malformed or belongs to a different environment/app; also dead.
            try {
              if ((JSON.parse(body) as { reason?: string }).reason === 'BadDeviceToken') return done('unregistered');
            } catch {
              // not JSON: fall through to "failed"
            }
          }
          done('failed');
        });
        req.on('error', () => done('failed'));
        req.end(payload);
      });
    },
    close() {
      session?.close();
      session = null;
    },
  };
}
