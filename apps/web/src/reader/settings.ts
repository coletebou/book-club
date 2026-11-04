import { DEFAULT_SETTINGS, FONTS, FONT_SCALES, type ReaderSettings, THEMES } from './epub/layout';

const KEY = 'bookclub:reader-settings';

/** Reader settings live on the device (they depend on the screen and the reader's eyes). */
export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    return {
      fontScale: FONT_SCALES.includes(parsed.fontScale as (typeof FONT_SCALES)[number]) ? parsed.fontScale! : DEFAULT_SETTINGS.fontScale,
      theme: typeof parsed.theme === 'string' && Object.hasOwn(THEMES, parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
      lineHeight: [1.4, 1.6, 1.8].includes(parsed.lineHeight ?? 0) ? parsed.lineHeight! : DEFAULT_SETTINGS.lineHeight,
      font: typeof parsed.font === 'string' && Object.hasOwn(FONTS, parsed.font) ? parsed.font : DEFAULT_SETTINGS.font,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: ReaderSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage full or disabled: settings last for this visit
  }
}
