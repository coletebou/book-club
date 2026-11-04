/**
 * Whether a picture is blank: of one shade, near enough (a PDF page drawn white because its
 * pictures could not be decoded, a flyleaf, a flat colour). Such a drawing is no cover (D103).
 */

/** How far from the picture's commonest shade a pixel is to be ink: a fifth of the way from white to black. */
export const INK_DISTANCE = 48;
/** The share of a picture's pixels that may be ink and the picture still be blank: one in two thousand. */
export const BLANK_INK_SHARE = 0.0005;
/** Pixels looked at, at most: every so many of a large picture's. */
const SAMPLES = 400_000;

/**
 * Whether these pixels (RGBA, RGB or grey, `channels` bytes each, row after row) are a blank
 * picture: hardly any (BLANK_INK_SHARE) differ in lightness from the commonest shade by more than
 * INK_DISTANCE. A page of text, a title page with one line on it, a cover with its title are not;
 * a scan's paper, its grain and all, is. Transparent pixels count as the white a page is drawn on.
 */
export function looksBlank(pixels: ArrayLike<number>, channels = 4): boolean {
  const count = Math.floor(pixels.length / channels);
  if (count === 0) return true;
  const step = Math.max(1, Math.floor(count / SAMPLES));
  const shades = new Uint32Array(256);
  let seen = 0;
  for (let i = 0; i < count; i += step) {
    const at = i * channels;
    let shade = channels >= 3 ? Math.round(0.299 * pixels[at]! + 0.587 * pixels[at + 1]! + 0.114 * pixels[at + 2]!) : pixels[at]!;
    // A transparent pixel shows the white page under it.
    if (channels === 4 || channels === 2) {
      const alpha = pixels[at + channels - 1]! / 255;
      shade = Math.round(shade * alpha + 255 * (1 - alpha));
    }
    shades[Math.max(0, Math.min(255, shade))]!++;
    seen++;
  }
  let common = 0;
  for (let s = 1; s < 256; s++) if (shades[s]! > shades[common]!) common = s;
  let ink = 0;
  for (let s = 0; s < 256; s++) if (Math.abs(s - common) > INK_DISTANCE) ink += shades[s]!;
  return ink <= BLANK_INK_SHARE * seen;
}
