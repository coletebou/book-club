import { describe, expect, it } from 'vitest';
import { BLANK_INK_SHARE, INK_DISTANCE, looksBlank } from './blank';

type Colour = readonly [number, number, number, number?];

/** A width × height RGBA picture of one colour, with `ink` drawn on it. */
function picture(width: number, height: number, [r, g, b, a = 255]: Colour, ink: (x: number, y: number) => Colour | null = () => null): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [pr = r, pg = g, pb = b, pa = a] = ink(x, y) ?? [r, g, b, a];
      data.set([pr, pg, pb, pa], (y * width + x) * 4);
    }
  }
  return data;
}

describe('looksBlank', () => {
  it('a page drawn white, or of one flat colour, is blank', () => {
    expect(looksBlank(picture(64, 96, [255, 255, 255]))).toBe(true);
    expect(looksBlank(picture(64, 96, [43, 76, 126]))).toBe(true);
    // Nothing drawn at all: the white page under it.
    expect(looksBlank(picture(64, 96, [0, 0, 0, 0]))).toBe(true);
    expect(looksBlank(new Uint8ClampedArray(0))).toBe(true);
  });

  it('a scan’s paper, its grain and all, is blank; so is a page with a speck or a page number on it', () => {
    let seed = 7;
    const grain = () => ((seed = (seed * 16807) % 2147483647) % (2 * 20)) - 20;
    expect(looksBlank(picture(200, 300, [236, 228, 210], () => [236 + grain(), 228 + grain(), 210 + grain()]))).toBe(true);
    // 0.04 % of the page dark: a folio, a speck of dust.
    expect(looksBlank(picture(200, 300, [255, 255, 255], (x, y) => (x < 4 && y < 6 ? [20, 20, 20] : null)))).toBe(true);
  });

  it('a page with a line of text on it, a cover with its title, is not', () => {
    // One short line of dark type across a white page: about 0.4 % of it.
    expect(looksBlank(picture(200, 300, [255, 255, 255], (x, y) => (y >= 140 && y < 148 && x >= 60 && x < 140 && x % 3 === 0 ? [30, 30, 30] : null)))).toBe(false);
    // The scan's cover: white letters on blue.
    expect(looksBlank(picture(200, 300, [10, 80, 190], (x, y) => (y >= 40 && y < 70 && x >= 30 && x < 170 && (x + y) % 4 === 0 ? [250, 250, 250] : null)))).toBe(false);
  });

  it('counts ink as a shade more than INK_DISTANCE from the commonest one, on more than BLANK_INK_SHARE of the pixels', () => {
    const n = 100_000;
    const dots = (count: number, shade: number) => {
      const grey = new Uint8Array(n).fill(200);
      for (let i = 0; i < count; i++) grey[i * 97] = shade;
      return grey;
    };
    const allowed = Math.floor(BLANK_INK_SHARE * n);
    expect(looksBlank(dots(allowed, 0), 1)).toBe(true);
    expect(looksBlank(dots(allowed + 1, 0), 1)).toBe(false);
    // Only so far from the page's shade: no ink, however many.
    expect(looksBlank(dots(5000, 200 - INK_DISTANCE), 1)).toBe(true);
    expect(looksBlank(dots(5000, 200 - INK_DISTANCE - 1), 1)).toBe(false);
    // Three channels to a pixel.
    expect(looksBlank(new Uint8Array(3 * 1000).fill(128), 3)).toBe(true);
  });
});
