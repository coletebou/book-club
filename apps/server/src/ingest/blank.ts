import { looksBlank } from '@bookclub/shared';
import sharp from 'sharp';

/**
 * Whether a cover picture (a JPEG normaliseCover made) is blank: of one shade, near enough
 * (looksBlank). A browser that could not draw a PDF's first page sends one; it is no cover (D103).
 * Looked at no larger than a phone's cover: a title's strokes still stand out at that size.
 */
export async function pictureLooksBlank(jpeg: Uint8Array): Promise<boolean> {
  const { data, info } = await sharp(jpeg, { limitInputPixels: 80_000_000 })
    .resize({ width: 640, height: 960, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return looksBlank(data, info.channels);
}
