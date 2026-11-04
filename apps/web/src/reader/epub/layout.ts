/** Reader settings, themes and the page geometry derived from the screen. */

import { hashCode } from '@bookclub/shared';

/**
 * Renamed from 'night'/'day' to 'lucerna'/'vellum' (D121): the reading surface now carries the
 * same two names as the app's own light/dark theme, recoloured from the manuscript palette
 * (styles/base.css). 'dusk' and 'sepia' are the sensible variants in between. A theme name stored
 * from before this change no longer matches a key; settings.ts already falls back to the default
 * for that (its `Object.hasOwn(THEMES, ...)` check), so nothing breaks, it just resets once.
 */
export type ThemeName = 'lucerna' | 'dusk' | 'sepia' | 'vellum';
export type FontChoice = 'serif' | 'sans' | 'publisher';

export interface ReaderSettings {
  /** Root font size in percent. */
  readonly fontScale: number;
  readonly theme: ThemeName;
  readonly lineHeight: number;
  readonly font: FontChoice;
}

export const DEFAULT_SETTINGS: ReaderSettings = { fontScale: 100, theme: 'lucerna', lineHeight: 1.6, font: 'serif' };
export const FONT_SCALES = [80, 90, 100, 110, 120, 135, 150, 170, 200] as const;

export interface Theme {
  readonly label: string;
  readonly bg: string;
  readonly text: string;
  readonly muted: string;
  readonly link: string;
  readonly selection: string;
  readonly mark: string;
  readonly dark: boolean;
}

/** All four pass WCAG AA (>=4.5:1) for body text and for the muted caption colour on `bg`. */
export const THEMES: Record<ThemeName, Theme> = {
  lucerna: { label: 'Lucerna', bg: '#1f160e', text: '#f0e2c2', muted: '#b9a37f', link: '#ee9a72', selection: 'rgba(238,154,114,0.3)', mark: '#f2b08e', dark: true },
  dusk: { label: 'Dusk', bg: '#2a1f14', text: '#e6d2ab', muted: '#a68e68', link: '#e3935f', selection: 'rgba(227,147,95,0.3)', mark: '#e3935f', dark: true },
  sepia: { label: 'Sepia', bg: '#e8d8ad', text: '#2f2013', muted: '#6b5438', link: '#7a3118', selection: 'rgba(122,49,24,0.22)', mark: '#9c5a2e', dark: false },
  vellum: { label: 'Vellum', bg: '#f4ead2', text: '#2a1c12', muted: '#634e3a', link: '#93361c', selection: 'rgba(147,54,28,0.2)', mark: '#b8552f', dark: false },
};

/** 'serif' is EB Garamond Variable now (D122, self-hosted, see READER_FONT_FACES below), where it
 * was the OS's own serif; the three choices (and which is the default) are unchanged. */
export const FONTS: Record<FontChoice, { label: string; stack: string | null }> = {
  serif: { label: 'Serif', stack: "'EB Garamond Variable', 'EB Garamond', ui-serif, 'Iowan Old Style', Charter, Georgia, 'Times New Roman', serif" },
  sans: { label: 'Sans', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Arial, sans-serif" },
  publisher: { label: 'Book', stack: null },
};

/**
 * The EB Garamond @font-face rules (D122), Latin and Latin Extended, normal and italic: every
 * section loads in its own iframe (epub/frame.ts), a separate document that does not inherit the
 * app shell's stylesheet, so the face has to be declared again here. Same files, same origin
 * (`/fonts/...`, see styles/fonts.css), so the browser's cache serves this for free after the
 * first section. Latin subsets only, matching the self-hosting decision (D117).
 */
export const READER_FONT_FACES = `
@font-face { font-family: 'EB Garamond Variable'; font-style: normal; font-display: swap; font-weight: 400 800; src: url(/fonts/eb-garamond-latin-ext-wght-normal.woff2) format('woff2-variations'); unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
@font-face { font-family: 'EB Garamond Variable'; font-style: normal; font-display: swap; font-weight: 400 800; src: url(/fonts/eb-garamond-latin-wght-normal.woff2) format('woff2-variations'); unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
@font-face { font-family: 'EB Garamond Variable'; font-style: italic; font-display: swap; font-weight: 400 800; src: url(/fonts/eb-garamond-latin-ext-wght-italic.woff2) format('woff2-variations'); unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
@font-face { font-family: 'EB Garamond Variable'; font-style: italic; font-display: swap; font-weight: 400 800; src: url(/fonts/eb-garamond-latin-wght-italic.woff2) format('woff2-variations'); unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
`;

export interface PageGeometry {
  /** Width of one page (one CSS column) in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Gap between columns: the page's right margin plus the next page's left margin. */
  readonly gap: number;
  /** The left margin; the right one (gap - left) holds friends' note markers. */
  readonly left: number;
}

/** A note marker in the margin is a full touch target (Apple's 44 points). */
export const MARKER_TARGET = 44;

/**
 * Page geometry for a reading area: comfortable margins and a readable maximum line length. The
 * right margin is never narrower than a marker, so on a phone markers sit beside the text rather
 * than over its line ends.
 */
export function pageGeometry(areaWidth: number, areaHeight: number): PageGeometry {
  const margin = Math.round(Math.min(48, Math.max(18, areaWidth * 0.06)));
  const right = Math.max(margin, MARKER_TARGET);
  const width = Math.max(200, Math.min(680, Math.floor(areaWidth - margin - right)));
  return { width, height: Math.max(200, Math.floor(areaHeight)), gap: margin + right, left: margin };
}

/**
 * Everything that changes where text falls on a page: the page, the settings that move text, and
 * the stylesheet itself, so that counts a device kept are never used for a layout they were not
 * measured in. Themes do not.
 */
export function layoutSignature(g: PageGeometry, s: ReaderSettings): string {
  const css = hashCode(readerCss(g, { ...s, theme: DEFAULT_SETTINGS.theme })).toString(36);
  return [`${g.width}x${g.height}g${g.gap}`, `f${s.fontScale}`, `l${s.lineHeight}`, `t${s.font}`, 'v1', `c${css}`].join('|');
}

export function pagesFromWidth(scrollWidth: number, g: PageGeometry): number {
  return Math.max(1, Math.round((scrollWidth + g.gap) / (g.width + g.gap)));
}

/** Page (column) containing an x position in the section's coordinate space. */
export function pageAtX(x: number, g: PageGeometry): number {
  return Math.max(0, Math.floor((x + 0.5) / (g.width + g.gap)));
}

/** The stylesheet injected into every section: one column per page, our typography and theme. */
export function readerCss(g: PageGeometry, s: ReaderSettings): string {
  const theme = THEMES[s.theme];
  const font = FONTS[s.font].stack;
  return `
${READER_FONT_FACES}
html {
  margin: 0 !important; padding: 0 !important;
  width: ${g.width}px !important; height: ${g.height}px !important; min-height: 0 !important; max-height: none !important;
  column-width: ${g.width}px !important; column-gap: ${g.gap}px !important; column-fill: auto !important; column-count: auto !important;
  overflow: visible !important; background: ${theme.bg} !important; color-scheme: ${theme.dark ? 'dark' : 'light'};
  font-size: ${s.fontScale}% !important; -webkit-text-size-adjust: none !important; text-size-adjust: none !important;
  writing-mode: horizontal-tb !important;
  /* Horizontal drags are page turns (pointer events reach the reader instead of a cancelled
     pan); vertical scrolling and pinch stay with the browser; no double-tap zoom delay. */
  touch-action: pan-y pinch-zoom;
  -webkit-tap-highlight-color: transparent;
}
body {
  margin: 0 !important; padding: 0 !important; width: auto !important; max-width: none !important;
  min-height: 0 !important; height: auto !important; overflow: visible !important;
  background: transparent !important; color: ${theme.text} !important;
  ${font ? `font-family: ${font} !important;` : ''}
  line-height: ${s.lineHeight} !important;
  overflow-wrap: break-word; widows: 2; orphans: 2; hyphens: auto; -webkit-hyphens: auto;
}
${theme.dark || s.theme !== 'vellum' ? `body * { color: inherit !important; background-color: transparent !important; border-color: ${theme.muted} !important; }` : ''}
a, a * { color: ${theme.link} !important; }
img, svg, video, picture { max-width: 100% !important; max-height: ${g.height - 8}px !important; height: auto; object-fit: contain; break-inside: avoid; }
svg { width: auto; }
pre, code { white-space: pre-wrap !important; }
table { max-width: 100%; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; }
/* A row of stars between scenes keeps each of its lines whole and inside the page: drawn closer, and
   smaller where its widest line (--bc-row em, measured by the server) would not fit (D86). */
[data-bc-asterism] {
  white-space: nowrap !important; overflow-wrap: normal !important; letter-spacing: -0.15em !important; word-spacing: normal !important;
  font-size: min(1em, ${g.width}px / var(--bc-row, 1)) !important; text-indent: 0 !important; text-align: center !important; break-inside: avoid;
}
::selection { background: ${theme.selection}; }
`;
}
