import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BuiltApp, buildApp, redactUrl } from '../src/app';
import { loadConfig } from '../src/config';
import { Client, PASSWORD } from './helpers';

describe('the request log keeps no invite code, reset token or upstream code', () => {
  it.each([
    ['/join/Abc-123_x', '/join/[redacted]'],
    ['/JOIN/Abc-123_x/', '/JOIN/[redacted]/'],
    ['/reset/tok-EN_1?from=chat', '/reset/[redacted]?from=chat'],
    ['/api/invites/Abc-123_x', '/api/invites/[redacted]'],
    ['/api/invites/Abc-123_x/accept', '/api/invites/[redacted]/accept'],
    ['/signin?next=%2Fjoin%2FAbc-123_x', '/signin?next=%2Fjoin%2F[redacted]'],
    ['/signin?upstream=refused&next=%2fjoin%2fAbc-123_x&x=1', '/signin?upstream=refused&next=%2fjoin%2f[redacted]&x=1'],
    ['/api/auth/upstream?next=/join/Abc-123_x', '/api/auth/upstream?next=/join/[redacted]'],
    ['/api/auth/upstream?returned=1&next=%252Freset%252Ftok-EN_1', '/api/auth/upstream?returned=1&next=%252Freset%252F[redacted]'],
    ['/api/auth/upstream/callback?state=St4te_x&code=C0de-y', '/api/auth/upstream/callback?state=[redacted]&code=[redacted]'],
    ['/api/auth/upstream/callback?code=C0de-y&error=failed&state=St4te_x', '/api/auth/upstream/callback?code=[redacted]&error=failed&state=[redacted]'],
  ])('%s is logged as %s', (url, logged) => {
    expect(redactUrl(url)).toBe(logged);
  });

  it.each(['/api/clubs/c1/invite/rotate', '/api/auth/reset', '/api/clubs/c1/members/u1/reset-link', '/join', '/api/editions/e1/readalong?track=3', '/media/books/b1/cover?w=320&v=9', '/api/auth/upstream/callback?error=failed', '/api/books?code=x'])(
    '%s, which has none, is logged as it is',
    (url) => {
      expect(redactUrl(url)).toBe(url);
    },
  );

  describe('a real server', () => {
    const lines: string[] = [];
    let dir: string;
    let built: BuiltApp;
    let baseUrl: string;

    beforeAll(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'bookclub-logs-'));
      // The web app's pages are served too: /join/:code and /reset/:token are two of them.
      const web = path.join(dir, 'web');
      mkdirSync(web);
      writeFileSync(path.join(web, 'index.html'), '<!doctype html><html lang="en"><head><title>Book Club</title></head><body></body></html>');
      built = await buildApp({
        config: loadConfig({ NODE_ENV: 'test', DATA_DIR: path.join(dir, 'data'), WEB_DIST: web, SCRYPT_LOG_N: '12' }),
        // The production logger, at its level, written here instead of to standard output.
        logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
        background: false,
      });
      baseUrl = await built.app.listen({ host: '127.0.0.1', port: 0 });
    });

    afterAll(async () => {
      built.app.server.closeAllConnections();
      await built.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('logs every request with its address, but none of the secrets in them', async () => {
      const owner = new Client(baseUrl);
      expect((await owner.post('/api/setup', { displayName: 'Cole', email: 'cole@example.com', password: PASSWORD, clubName: 'Readers' })).statusCode).toBe(201);
      const clubId = (await owner.json<{ id: string }[]>(owner.get('/api/clubs'), 200))[0]!.id;
      const code = (await owner.json<ClubDetail>(owner.get(`/api/clubs/${clubId}`), 200)).invite!.code;
      const ana = new Client(baseUrl);
      expect((await ana.post('/api/auth/signup', { inviteCode: code, displayName: 'Ana', email: 'ana@example.com', password: PASSWORD })).statusCode).toBe(201);
      const anaId = (await ana.json<{ user: { id: string } }>(ana.get('/api/me'), 200)).user.id;
      const link = await owner.json<{ url: string }>(owner.post(`/api/clubs/${clubId}/members/${anaId}/reset-link`), 200);
      const token = link.url.split('/reset/')[1]!;

      // Every way an invite code or a reset token reaches the server in an address.
      const next = encodeURIComponent(`/join/${code}`);
      const grant = { state: 'state-from-the-upstream-4', code: 'one-time-code-from-the-upstream-7' };
      const visits = [`/join/${code}`, `/reset/${token}`, `/api/invites/${code}`, `/signin?next=${next}`, `/api/auth/upstream?next=${next}`, `/api/auth/upstream?returned=1&next=${next}`, `/api/auth/upstream/callback?state=${grant.state}&code=${grant.code}`];
      for (const url of visits) expect((await new Client(baseUrl).get(url)).statusCode).toBeLessThan(500);
      expect((await ana.post(`/api/invites/${code}/accept`)).statusCode).toBe(200);
      expect((await new Client(baseUrl).post('/api/auth/reset', { token, newPassword: 'a-brand-new-password' })).statusCode).toBe(200);

      const log = lines.join('');
      expect(log).not.toContain(code);
      expect(log).not.toContain(token);
      expect(log).not.toContain(grant.state);
      expect(log).not.toContain(grant.code);
      // The requests are in the log all the same, each with its address less the secret.
      const urls = lines.map((line) => JSON.parse(line) as { msg: string; req?: { url: string } }).flatMap((entry) => (entry.msg === 'incoming request' && entry.req ? [entry.req.url] : []));
      expect(urls).toEqual(
        expect.arrayContaining([
          '/join/[redacted]',
          '/reset/[redacted]',
          '/api/invites/[redacted]',
          '/api/invites/[redacted]/accept',
          '/signin?next=%2Fjoin%2F[redacted]',
          '/api/auth/upstream?next=%2Fjoin%2F[redacted]',
          '/api/auth/upstream?returned=1&next=%2Fjoin%2F[redacted]',
          '/api/auth/upstream/callback?state=[redacted]&code=[redacted]',
          '/api/auth/reset',
          `/api/clubs/${clubId}/members/${anaId}/reset-link`,
        ]),
      );
    });
  });
});
