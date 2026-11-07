import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package's own promise, checked: it can be lifted out of this repository as it stands. No
 * runtime dependencies at all, no import of any app (`@bookclub/...`) or framework (React), and
 * no runtime-specific API (Node's `node:` modules, `process`, `Buffer`, the DOM's `document` or
 * `window`) anywhere outside its tests, so it runs the same in Node, Bun, a browser, a Worker or
 * React Native.
 */
const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'test' ? [] : sources(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

const FORBIDDEN: readonly [RegExp, string][] = [
  [/from\s+['"]@bookclub\//u, 'an app package'],
  [/from\s+['"]react/u, 'React'],
  [/from\s+['"]node:/u, "a Node built-in (use the Web platform's own API)"],
  [/\bprocess\./u, "Node's process"],
  [/\bBuffer\b/u, "Node's Buffer"],
  [/\b(?:document|window)\./u, 'the DOM'],
  [/from\s+['"](?![./])/u, 'a package (only relative imports)'],
];

describe('chat-core stays extractable', () => {
  it('has no dependencies of any kind', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('imports nothing app-, framework- or runtime-specific outside its tests', () => {
    const files = sources(path.join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '');
      for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) problems.push(`${path.relative(ROOT, file)} uses ${what}`);
    }
    expect(problems).toEqual([]);
  });
});
