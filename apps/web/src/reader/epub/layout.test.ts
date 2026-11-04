import { describe, expect, it } from 'vitest';
import { hashCode } from '@bookclub/shared';
import { DEFAULT_SETTINGS, FONTS, FONT_SCALES, MARKER_TARGET, type PageGeometry, type ReaderSettings, THEMES, layoutSignature, pageAtX, pageGeometry, pagesFromWidth, readerCss } from './layout';

describe('pageGeometry', () => {
  it('gives a phone comfortable margins, a right one wide enough for a note marker, and the rest of the width', () => {
    // 6 % of 390 px is 23.4 px on the left; on the right, a 44 px marker's touch target.
    expect(pageGeometry(390, 844)).toEqual({ width: 323, height: 844, gap: 67, left: 23 });
  });

  it('caps the margin and the line length on a wide screen', () => {
    expect(pageGeometry(1440, 900)).toEqual({ width: 680, height: 900, gap: 96, left: 48 });
    expect(pageGeometry(768, 1024)).toEqual({ width: 676, height: 1024, gap: 92, left: 46 });
  });

  it('never makes a page smaller than 200 px either way', () => {
    expect(pageGeometry(150, 120)).toEqual({ width: 200, height: 200, gap: 62, left: 18 });
  });

  it('works in whole pixels', () => {
    const g = pageGeometry(391.5, 700.8);
    expect(Number.isInteger(g.width) && Number.isInteger(g.height) && Number.isInteger(g.gap)).toBe(true);
    expect(g.height).toBe(700);
  });

  it('keeps margins between 18 and 48 px, room for a marker on the right, and lines at most 680 px for every screen width', () => {
    for (let w = 100; w <= 3000; w += 7) {
      const g = pageGeometry(w, 800);
      const right = g.gap - g.left;
      expect(g.left).toBeGreaterThanOrEqual(18);
      expect(g.left).toBeLessThanOrEqual(48);
      expect(right).toBeGreaterThanOrEqual(MARKER_TARGET);
      expect(right).toBeLessThanOrEqual(48);
      expect(g.width).toBeLessThanOrEqual(680);
      expect(g.width).toBeGreaterThanOrEqual(200);
      // The page and its margins fit the screen whenever the screen can hold the smallest page.
      if (w >= 200 + 18 + MARKER_TARGET) expect(g.width + g.gap).toBeLessThanOrEqual(w + 1);
    }
  });
});

describe('layoutSignature', () => {
  const g = pageGeometry(390, 844);
  const s = DEFAULT_SETTINGS;

  it('is the same for the same layout', () => {
    expect(layoutSignature(g, s)).toBe(layoutSignature({ ...g }, { ...s }));
  });

  it.each([
    ['page width', { ...g, width: g.width + 1 }, s],
    ['page height', { ...g, height: g.height - 1 }, s],
    ['column gap', { ...g, gap: g.gap + 2 }, s],
    ['font size', g, { ...s, fontScale: 120 }],
    ['line height', g, { ...s, lineHeight: 1.8 }],
    ['font', g, { ...s, font: 'sans' as const }],
  ])('changes with the %s (it moves text between pages)', (_what, geometry: PageGeometry, settings: ReaderSettings) => {
    expect(layoutSignature(geometry, settings)).not.toBe(layoutSignature(g, s));
  });

  it('changes with the stylesheet, so counts kept from before a change to it are not used', () => {
    expect(layoutSignature(g, s)).toContain(`|c${hashCode(readerCss(g, s)).toString(36)}`);
  });

  it('does not change with the theme (colours never move text)', () => {
    const signatures = new Set(Object.keys(THEMES).map((theme) => layoutSignature(g, { ...s, theme: theme as ReaderSettings['theme'] })));
    expect(signatures.size).toBe(1);
  });

  it('tells every combination of the offered settings apart', () => {
    const seen = new Set<string>();
    for (const fontScale of FONT_SCALES)
      for (const lineHeight of [1.4, 1.6, 1.8])
        for (const font of Object.keys(FONTS) as ReaderSettings['font'][]) seen.add(layoutSignature(g, { ...s, fontScale, lineHeight, font }));
    expect(seen.size).toBe(FONT_SCALES.length * 3 * Object.keys(FONTS).length);
  });
});

describe('pagesFromWidth and pageAtX', () => {
  const g: PageGeometry = { width: 344, height: 800, gap: 46, left: 23 };
  const step = g.width + g.gap;
  /** scrollWidth of a section laid out in n columns. */
  const widthOf = (n: number) => n * g.width + (n - 1) * g.gap;

  it('counts the columns of a laid-out section', () => {
    for (let n = 1; n <= 60; n++) expect(pagesFromWidth(widthOf(n), g)).toBe(n);
  });

  it('tolerates a few pixels of rounding in the measured width', () => {
    for (const n of [1, 2, 17]) {
      expect(pagesFromWidth(widthOf(n) - 3, g)).toBe(n);
      expect(pagesFromWidth(widthOf(n) + 3, g)).toBe(n);
    }
  });

  it('gives an empty section one page', () => {
    expect(pagesFromWidth(0, g)).toBe(1);
  });

  it('finds the page of an x position, including the gap after a page', () => {
    for (const p of [0, 1, 5, 40]) {
      expect(pageAtX(p * step, g)).toBe(p);
      expect(pageAtX(p * step + g.width - 1, g)).toBe(p);
      expect(pageAtX(p * step + g.width + g.gap - 1, g)).toBe(p);
    }
  });

  it('puts a box starting half a pixel before a page on that page (sub-pixel layout)', () => {
    expect(pageAtX(step - 0.5, g)).toBe(1);
    expect(pageAtX(step - 0.6, g)).toBe(0);
  });

  it('never gives a page before the first', () => {
    expect(pageAtX(-200, g)).toBe(0);
  });
});

describe('readerCss', () => {
  const g: PageGeometry = { width: 344, height: 800, gap: 46, left: 23 };

  it('lays the section out in columns exactly one page wide', () => {
    const css = readerCss(g, DEFAULT_SETTINGS);
    expect(css).toMatch(/width: 344px !important; height: 800px !important/);
    expect(css).toContain('column-width: 344px !important; column-gap: 46px !important');
  });

  it('leaves horizontal drags to the reader (page turns) and vertical pans and pinch-zoom to the browser', () => {
    expect(readerCss(g, DEFAULT_SETTINGS)).toMatch(/touch-action:\s*pan-y pinch-zoom/);
  });

  it('applies the font size, line height and font', () => {
    const css = readerCss(g, { ...DEFAULT_SETTINGS, fontScale: 135, lineHeight: 1.8, font: 'sans' });
    expect(css).toContain('font-size: 135% !important');
    expect(css).toContain('line-height: 1.8 !important');
    expect(css).toContain(`font-family: ${FONTS.sans.stack!} !important`);
  });

  it("keeps the book's own fonts when the reader chooses the publisher's (D122: the EB Garamond @font-face rules are always declared for the EPUB's other sections that may ask for it by name, but nothing here forces it on the body)", () => {
    const css = readerCss(g, { ...DEFAULT_SETTINGS, font: 'publisher' });
    const body = css.slice(css.indexOf('body {'), css.indexOf('body {') + css.slice(css.indexOf('body {')).indexOf('}'));
    expect(body).not.toContain('font-family');
  });

  it('paints the theme, forcing its colours on the text except in the vellum theme', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      const css = readerCss(g, { ...DEFAULT_SETTINGS, theme: name as ReaderSettings['theme'] });
      expect(css).toContain(`background: ${theme.bg} !important`);
      expect(css).toContain(`color: ${theme.text} !important`);
      expect(css).toContain(`color-scheme: ${theme.dark ? 'dark' : 'light'}`);
      expect(css.includes('body * { color: inherit !important;')).toBe(name !== 'vellum');
    }
  });

  it('keeps images inside a page', () => {
    expect(readerCss(g, DEFAULT_SETTINGS)).toContain('max-height: 792px !important');
  });

  it('keeps a row of stars between scenes on its lines and inside the page, at any size (D86)', () => {
    const css = readerCss(g, { ...DEFAULT_SETTINGS, fontScale: 200 });
    expect(css).toContain('white-space: nowrap !important');
    // Its widest line is --bc-row em: no larger than the page holds.
    expect(css).toContain('font-size: min(1em, 344px / var(--bc-row, 1)) !important');
  });
});
