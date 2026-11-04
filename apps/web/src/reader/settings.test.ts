import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, FONTS, FONT_SCALES, type ReaderSettings, THEMES } from './epub/layout';
import { loadSettings, saveSettings } from './settings';

const KEY = 'bookclub:reader-settings';
const store = (value: unknown) => localStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value));

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('reader settings', () => {
  it('are the defaults on a device that never saved any', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    // 'night' renamed to 'lucerna' (D121): the reading theme now carries the same name as the
    // app's own dark theme.
    expect(DEFAULT_SETTINGS).toEqual({ fontScale: 100, theme: 'lucerna', lineHeight: 1.6, font: 'serif' });
  });

  it('come back exactly as saved', () => {
    const mine: ReaderSettings = { fontScale: 135, theme: 'sepia', lineHeight: 1.8, font: 'sans' };
    saveSettings(mine);
    expect(loadSettings()).toEqual(mine);
  });

  it('round-trip every combination the settings panel offers', () => {
    for (const fontScale of FONT_SCALES)
      for (const theme of Object.keys(THEMES) as ReaderSettings['theme'][])
        for (const lineHeight of [1.4, 1.6, 1.8])
          for (const font of Object.keys(FONTS) as ReaderSettings['font'][]) {
            const s = { fontScale, theme, lineHeight, font };
            saveSettings(s);
            expect(loadSettings()).toEqual(s);
          }
  });

  it.each([
    ['a font size the panel does not offer', { fontScale: 95 }, { fontScale: 100 }],
    ['a font size stored as text', { fontScale: '120' }, { fontScale: 100 }],
    ['a theme that no longer exists', { theme: 'dark' }, { theme: 'lucerna' }],
    ['a theme of the wrong type', { theme: 3 }, { theme: 'lucerna' }],
    ['a line height the panel does not offer', { lineHeight: 2 }, { lineHeight: 1.6 }],
    ['no line height', { lineHeight: null }, { lineHeight: 1.6 }],
    ['an unknown font', { font: 'comic-sans' }, { font: 'serif' }],
  ])('replace %s with its default and keep the rest', (_what, bad, fixed) => {
    const good: ReaderSettings = { fontScale: 150, theme: 'vellum', lineHeight: 1.4, font: 'publisher' };
    store({ ...good, ...bad });
    expect(loadSettings()).toEqual({ ...good, ...fixed });
  });

  it.each(['{not json', 'null', '42', '"night"', '[100, "night"]', '{}'])('are the defaults when what is stored is not settings (%s)', (raw) => {
    store(raw);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('are the defaults, and saving never fails, when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Access denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings({ ...DEFAULT_SETTINGS, fontScale: 120 })).not.toThrow();
  });

  // BUG (reader/settings.ts, loadSettings): themes and fonts are validated with `value in THEMES`
  // and `value in FONTS`, and `in` also finds what every object inherits. A stored theme or font
  // of "toString", "constructor" or "__proto__" passes as valid and comes back as the setting;
  // readerCss then reads THEMES["toString"] (a function) and writes `background: undefined`.
  // Low severity: only a damaged or tampered value gets there. Object.hasOwn would close it.
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])('treat an inherited property name (%s) as an unknown theme or font', (name) => {
    store({ ...DEFAULT_SETTINGS, theme: name, font: name });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
