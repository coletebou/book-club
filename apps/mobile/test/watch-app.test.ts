/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WATCH_KEYS, watchInfoPlist } from '../plugins/with-watch-app';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));

/** What @bacons/apple-targets writes for its `watch` type, as of 5.x: an empty dict. */
const EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict/>
</plist>`;

describe('the watch app (D222)', () => {
  it('is a single-target watchOS app that needs its iPhone app, and a second prebuild changes nothing', () => {
    const out = watchInfoPlist(EMPTY);
    expect(out).toContain('<key>WKApplication</key>\n    <true/>');
    expect(out).toContain('<key>WKRunsIndependentlyOfCompanionApp</key>\n    <false/>');
    expect(watchInfoPlist(out)).toBe(out);
    expect(Object.keys(WATCH_KEYS)).toEqual(['WKApplication', 'WKRunsIndependentlyOfCompanionApp']);
    const filled = watchInfoPlist(EMPTY.replace('<dict/>', '<dict>\n    <key>X</key>\n    <string>y</string>\n  </dict>'));
    expect(filled).toContain('<key>X</key>');
    expect(filled.indexOf('WKApplication')).toBeLessThan(filled.indexOf('<key>X</key>'));
    expect(() => watchInfoPlist('<plist version="1.0"><array/></plist>')).toThrow(/root dict/);
  });

  it('is listed before @bacons/apple-targets, so its Info.plist change runs after that plugin wrote the file', async () => {
    const before = process.env.BOOKCLUB_WATCH;
    process.env.BOOKCLUB_WATCH = '1';
    try {
      vi.resetModules();
      const plugins = ((await import('../app.config')).default.plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));
      expect(plugins.indexOf('./plugins/with-watch-app')).toBeGreaterThanOrEqual(0);
      expect(plugins.indexOf('./plugins/with-watch-app')).toBeLessThan(plugins.indexOf('@bacons/apple-targets'));
    } finally {
      if (before === undefined) delete process.env.BOOKCLUB_WATCH;
      else process.env.BOOKCLUB_WATCH = before;
    }
  });

  it('is in a store build only once the repository says so (its App ID has a profile), and locally with BOOKCLUB_WATCH=1', async () => {
    const { STORE_TARGETS, nativeTargets } = await import('../app.config');
    // On in the repository since build 6.
    expect(STORE_TARGETS.watch).toBe(true);
    expect(nativeTargets({})).toContain('watch');
    const off = { messages: false, watch: false };
    expect(nativeTargets({}, off)).toEqual(['widgets']);
    expect(nativeTargets({ BOOKCLUB_WATCH: '1' }, off)).toEqual(['widgets', 'watch']);
    expect(nativeTargets({}, { messages: false, watch: true })).toEqual(['widgets', 'watch']);
  });

  it('is sent the Live Activity’s record, which the watch decodes (the shared vectors, scripts/test-watch-swift.sh)', async () => {
    const { recordOf } = await import('../src/widgets/NativeExtras');
    const vectors = JSON.parse(readFileSync(path.join(__dirname, 'swift', 'watch-vectors.json'), 'utf8')) as { now: number; np: Parameters<typeof recordOf>[0]; record: unknown };
    expect(recordOf(vectors.np, vectors.now)).toEqual(vectors.record);
  });
});
