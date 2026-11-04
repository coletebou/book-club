import { describe, expect, it } from 'vitest';
import { safeNext } from './SignInPage';

/** Where a browser goes for a `next` value, from the sign-in page. */
const resolve = (next: string) => new URL(next, 'https://club.example/signin?next=x');

describe('safeNext (where sign-in leads)', () => {
  it.each(['/', '/books/book_alice', '/books/book_alice/read?edition=ed_1&at=0.4#note', '/clubs/club_123/settings', '/join/abcdefgh'])('follows a path of this app: %s', (next) => {
    expect(safeNext(next)).toBe(next);
    expect(resolve(safeNext(next)).origin).toBe('https://club.example');
  });

  it.each([
    ['nothing', null],
    ['an empty value', ''],
    ['another site', 'https://evil.example/phish'],
    ['another site without a scheme', '//evil.example/phish'],
    ['a script', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path', 'books/book_alice'],
  ])('goes home instead of following %s', (_what, next) => {
    expect(safeNext(next)).toBe('/');
  });

  // BUG (pages/SignInPage.tsx, safeNext): it only rejects values that start with "//", but URL
  // parsing turns more into a scheme-relative URL: a backslash after the slash ("/\evil.example")
  // counts as a slash, and tabs and newlines are removed before parsing ("/\t/evil.example").
  // Both pass as "same-app paths" and resolve to https://evil.example/. SignInPage navigates to
  // the value with { replace: true }; react-router's replace calls history.replaceState, which
  // refuses another origin (a SecurityError, so the redirect after sign-in breaks rather than
  // leaving the site), while its push falls back to window.location.assign on a pushState error
  // (react-router dist/development/lib/router/history.js, read, not run in a browser). Checking
  // the resolved origin (new URL(next, location.origin).origin === location.origin) would hold.
  it.each(['/\\evil.example/phish', '/\t/evil.example/phish', '/\n/evil.example', '/..//evil.example/phish', '/%2e%2e//evil.example', '/a/../..//evil.example'])('never leads to another site: %j', (next) => {
    expect(resolve(safeNext(next)).origin).toBe('https://club.example');
  });
});
