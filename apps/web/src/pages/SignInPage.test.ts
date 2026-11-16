import { describe, expect, it } from 'vitest';
import { safeNext } from './SignInPage';

// Where a clean `next` is followed after sign-in: SignInCode.test and SignInPage.providers.test land
// on /clubs/club_1 from next=/clubs/club_1. Which paths count as this app's: shared paths.test.
describe('safeNext (where sign-in leads)', () => {
  it.each([
    ['nothing', null],
    ['an empty value', ''],
    ['another site', 'https://evil.example/phish'],
    ['another site without a scheme', '//evil.example/phish'],
    ['a script', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path', 'books/book_alice'],
    // Another site the URL parser would reach, at each stage of the check (shared's appPath): a
    // backslash read as a slash, and dot segments that resolve to "//". Every such form is
    // shared's paths.test; these prove the page goes home rather than passing the value on.
    ['another site behind a backslash', '/\\evil.example/phish'],
    ['another site behind dot segments', '/..//evil.example/phish'],
  ])('goes home instead of following %s', (_what, next) => {
    expect(safeNext(next)).toBe('/');
  });
});
