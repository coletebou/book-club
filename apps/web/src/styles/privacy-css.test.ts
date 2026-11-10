import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * public/privacy.css (D227) repeats a few of base.css's design tokens, since the page the server
 * writes at /privacy cannot link the app's bundled stylesheet. This keeps the copies equal, so a
 * palette change in base.css cannot leave the policy in last year's colours.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const base = readFileSync(path.join(here, 'base.css'), 'utf8');
const privacy = readFileSync(path.join(here, '../../public/privacy.css'), 'utf8');

/** The custom properties set directly in the first rule whose selector is exactly `selector`. */
function tokens(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const found = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) found.set(m[1]!, m[2]!.trim());
  return found;
}

describe('privacy.css keeps base.css’s tokens (D227)', () => {
  for (const [label, selector] of [
    ['vellum', ':root'],
    ['lucerna', ":root[data-theme='lucerna']"],
  ] as const) {
    it(`every ${label} token it repeats has base.css’s value`, () => {
      const copied = tokens(privacy, selector);
      const source = tokens(base, selector);
      expect(copied.size).toBeGreaterThan(5);
      for (const [name, value] of copied) {
        if (name.startsWith('--font-')) continue;
        // In lucerna, base.css aliases --gold-strong to --sanguine-2: compare with what that resolves to.
        const expected = source.get(name) === 'var(--sanguine-2)' ? source.get('--sanguine-2') : source.get(name);
        expect([name, value]).toEqual([name, expected]);
      }
    });
  }

  it('gives a dark system with no script the same lucerna values', () => {
    const chosen = tokens(privacy, ":root[data-theme='lucerna']");
    const media = privacy.slice(privacy.indexOf('@media (prefers-color-scheme: dark)'));
    expect(tokens(media, ':root:not([data-theme])')).toEqual(chosen);
  });

  it('uses the same font stacks as base.css', () => {
    const copied = tokens(privacy, ':root');
    const source = tokens(base, ':root');
    expect(copied.get('--font-text')).toBe(source.get('--font-text'));
    expect(copied.get('--font-display')).toBe(source.get('--font-display'));
  });
});
