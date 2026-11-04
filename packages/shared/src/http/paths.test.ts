import { describe, expect, it } from 'vitest';
import { appPath, isAppPath } from './paths';

describe('isAppPath (where a sign-in may lead)', () => {
  it.each(['/', '/books/book_alice', '/books/book_alice/read?edition=ed_1&at=0.4#note', '/join/abcdefgh', '/a:b@c'])('a path of this app: %s', (path) => {
    expect(isAppPath(path)).toBe(true);
    // Resolved anywhere, it stays there.
    expect(new URL(path, 'https://club.example/x/y').origin).toBe('https://club.example');
  });

  it.each([
    ['nothing', null],
    ['undefined', undefined],
    ['an empty value', ''],
    ['another site', 'https://evil.example/'],
    ['another site without a scheme', '//evil.example/'],
    ['a backslash after the slash', '/\\evil.example/'],
    ['a tab after the slash', '/\t/evil.example'],
    ['a newline after the slash', '/\n/evil.example'],
    ['a backslash later', '/books/\\x'],
    ['a script', 'javascript:alert(1)'],
    ['a relative path', 'books/book_alice'],
    ['something very long', `/${'a'.repeat(2000)}`],
  ])('not %s', (_what, path) => {
    expect(isAppPath(path)).toBe(false);
  });
});

describe('appPath (where a next value leads, as the browser will read it)', () => {
  it.each([
    ['/', '/'],
    ['/books/book_alice?at=0.4#note', '/books/book_alice?at=0.4#note'],
    ['/books/a/../b', '/books/b'],
    ['/books/☃?q=é', '/books/%E2%98%83?q=%C3%A9'],
  ])('%s → %s', (next, expected) => {
    expect(appPath(next)).toBe(expected);
  });

  it.each(['/..//evil.example/', '/.//evil.example', '/%2e%2e//evil.example', '/%2E%2E//evil.example', '/a/../..//evil.example', '/./%2e/..//evil.example', '//evil.example', 'https://evil.example', null])(
    'never another site: %j',
    (next) => {
      expect(appPath(next)).toBeNull();
    },
  );
});
