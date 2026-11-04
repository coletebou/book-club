import { randomBytes } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanXmlText } from '@bookclub/epub';
import { MAX_COVER_BYTES } from '@bookclub/shared';
import sharp from 'sharp';
import { looksLikeImage } from './audio';


/** Write a thumbnail so that a reader of the cache sees the whole file or none of it. */
async function writeAtomically(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export const COVER_WIDTHS = [160, 320, 640] as const;
export type CoverWidth = (typeof COVER_WIDTHS)[number];

/**
 * How thumbnails are drawn. Browsers keep a cover's URL for good, so a new way of drawing them
 * (2: squarer covers whole instead of cropped; 3: taller ones whole too) needs a new URL, ETag and
 * cached file.
 */
export const COVER_DRAWING = 3;

/** The ground a cover narrower than its frame is drawn on: the app's own covers' (generatedCoverSvg). */
const COVER_GROUND = { r: 0x14, g: 0x13, b: 0x11 };

/** The most of a cover's height that filling the 2:3 frame may cut: past it, the cover is shown whole. */
const MAX_CUT = 0.01;

/**
 * The sizes of a cover's square artwork (D190): what a lock screen, Control Center, a watch or a
 * car shows, each a square tile. Several, so each picks the one nearest its own tile, never a 2:3
 * cover cut to a strip or pillar-boxed by the system.
 */
export const SQUARE_SIZES = [96, 192, 256, 384, 512] as const;
export type SquareSize = (typeof SQUARE_SIZES)[number];

export function pickSquareSize(requested: unknown): SquareSize {
  const n = Number(requested);
  if (!Number.isFinite(n)) return 512;
  return SQUARE_SIZES.find((w) => w >= n) ?? 512;
}

export function pickCoverWidth(requested: unknown): CoverWidth {
  const n = Number(requested);
  if (!Number.isFinite(n)) return 320;
  return COVER_WIDTHS.find((w) => w >= n) ?? 640;
}

/**
 * A WebP thumbnail of a cover blob at a fixed width, 2:3 like a book, cached in the derived
 * directory. A cover of about that shape fills it; a squarer one (almost every audiobook's art)
 * is shown whole, on a blurred and darkened copy of itself, rather than cut to a strip; a taller
 * one (Gutenberg's Jekyll and Hyde, 500×862, its title along its top) whole too, on the app's dark
 * ground beside it, rather than cut at the top and bottom (FR151). Every place a cover is shown, and
 * the lock screen's artwork, draws this thumbnail.
 */
export async function coverThumbnail(source: string, derivedDir: string, blobId: string, width: CoverWidth): Promise<string> {
  const out = path.join(derivedDir, 'covers', `${blobId}-${width}-v${COVER_DRAWING}.webp`);
  try {
    await stat(out);
    return out;
  } catch {
    // not cached yet
  }
  await mkdir(path.dirname(out), { recursive: true });
  const height = Math.round(width * 1.5);
  const image = () => sharp(source, { limitInputPixels: 80_000_000 }).rotate();
  const meta = await image().metadata();
  // EXIF orientations 5 to 8 turn the picture a quarter: its width is the stored height.
  const [w, h] = (meta.orientation ?? 1) >= 5 ? [meta.height ?? 0, meta.width ?? 0] : [meta.width ?? 0, meta.height ?? 0];
  const squarer = w > 0 && h > 0 && w / h > 0.8;
  // Filling the frame would cut this much of a taller cover's height away.
  const taller = w > 0 && h > 0 && 1 - (1.5 * w) / h > MAX_CUT;
  let data: Buffer;
  if (squarer) {
    const backdrop = await image().resize({ width, height, fit: 'cover' }).blur(18).modulate({ brightness: 0.45 }).toBuffer();
    const whole = await image().resize({ width, height, fit: 'inside' }).toBuffer();
    data = await sharp(backdrop).composite([{ input: whole, gravity: 'center' }]).webp({ quality: 78 }).toBuffer();
  } else if (taller) {
    const whole = await image().resize({ width, height, fit: 'inside' }).toBuffer();
    data = await sharp({ create: { width, height, channels: 3, background: COVER_GROUND } }).composite([{ input: whole, gravity: 'center' }]).webp({ quality: 78 }).toBuffer();
  } else {
    data = await image().resize({ width, height, fit: 'cover', position: 'attention' }).webp({ quality: 78 }).toBuffer();
  }
  await writeAtomically(out, data);
  return out;
}

/**
 * A cover as square artwork (D190), drawn from its 2:3 thumbnail (`thumbnail`, real or generated, so
 * every book has one): the whole cover, centred on a blurred and darkened copy of itself, as a
 * squarer cover is drawn into the 2:3 frame. Cached beside the thumbnail it was drawn from, under the
 * same key.
 */
export async function squareCover(thumbnail: string, derivedDir: string, key: string, size: SquareSize): Promise<string> {
  const out = path.join(derivedDir, 'covers', `${key}-sq${size}-v${COVER_DRAWING}.webp`);
  try {
    await stat(out);
    return out;
  } catch {
    // not drawn yet
  }
  await mkdir(path.dirname(out), { recursive: true });
  const image = () => sharp(thumbnail, { limitInputPixels: 80_000_000 });
  const backdrop = await image().resize({ width: size, height: size, fit: 'cover' }).blur(Math.max(4, size / 24)).modulate({ brightness: 0.45 }).toBuffer();
  const whole = await image().resize({ width: size, height: size, fit: 'inside' }).toBuffer();
  const data = await sharp(backdrop).composite([{ input: whole, gravity: 'center' }]).webp({ quality: 80 }).toBuffer();
  await writeAtomically(out, data);
  return out;
}

/** The decoders a cover may reach: sharp would also read SVG, TIFF, HEIF and more, given the bytes. */
const COVER_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'gif', 'webp']);

/**
 * Normalise an uploaded or embedded cover into a JPEG we control (strips metadata, bounds size).
 * Whatever its source (an uploaded file, an audio tag, an EPUB), only a JPEG, PNG, GIF or WebP
 * picture of at most MAX_COVER_BYTES is decoded; anything else is refused unread.
 */
export async function normaliseCover(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.byteLength > MAX_COVER_BYTES) throw new Error(`a cover of ${bytes.byteLength} bytes is larger than ${MAX_COVER_BYTES}`);
  if (!looksLikeImage(bytes)) throw new Error('a cover must be a JPEG, PNG, GIF or WebP picture');
  const image = sharp(bytes, { limitInputPixels: 80_000_000 });
  // The bytes chose the decoder: make sure it is the one they claimed.
  const { format } = await image.metadata();
  if (!COVER_FORMATS.has(format)) throw new Error(`a cover cannot be ${format}`);
  const data = await image
    .rotate()
    .resize({ width: 1200, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
  return new Uint8Array(data);
}

/** Text for the SVG: characters XML forbids (a title may hold any) dropped, the rest escaped. */
function escapeXml(s: string): string {
  return cleanXmlText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Split a title into at most four lines of roughly `width` characters. */
export function wrapTitle(title: string, width = 16): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 4) {
    const kept = lines.slice(0, 4);
    kept[3] = `${kept[3]!.slice(0, width - 1)}…`;
    return kept;
  }
  return lines;
}

/**
 * A typographic cover for books without one: dark ground, gold rule and title, in the app's
 * palette. Deterministic for the same title and author.
 */
export function generatedCoverSvg(title: string, author: string): string {
  const lines = wrapTitle(title || 'Untitled');
  const size = lines.length > 3 ? 34 : 40;
  const startY = 300 - ((lines.length - 1) * size * 1.15) / 2;
  const tspans = lines
    .map((l, i) => `<tspan x="200" y="${(startY + i * size * 1.15).toFixed(1)}">${escapeXml(l)}</tspan>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" width="400" height="600" role="img" aria-label="${escapeXml(title)}">
<rect width="400" height="600" fill="#141311"/>
<rect x="22" y="22" width="356" height="556" fill="none" stroke="#c9a84c" stroke-width="2"/>
<rect x="30" y="30" width="340" height="540" fill="none" stroke="#c9a84c" stroke-opacity="0.35" stroke-width="1"/>
<text font-family="Georgia, 'Times New Roman', serif" font-size="${size}" font-weight="700" fill="#e3c77a" text-anchor="middle">${tspans}</text>
<line x1="150" y1="${(startY + lines.length * size * 1.15 + 6).toFixed(1)}" x2="250" y2="${(startY + lines.length * size * 1.15 + 6).toFixed(1)}" stroke="#c9a84c" stroke-width="1.5"/>
<text x="200" y="${(startY + lines.length * size * 1.15 + 44).toFixed(1)}" font-family="Georgia, 'Times New Roman', serif" font-size="20" font-style="italic" fill="#efe9dc" text-anchor="middle">${escapeXml(author.slice(0, 40))}</text>
</svg>`;
}

/** The generated cover rendered to WebP at a given width (cached by content). */
export async function generatedCoverWebp(title: string, author: string, derivedDir: string, key: string, width: CoverWidth): Promise<string> {
  const out = path.join(derivedDir, 'covers', `gen-${key}-${width}.webp`);
  try {
    await stat(out);
    return out;
  } catch {
    // render below
  }
  await mkdir(path.dirname(out), { recursive: true });
  const data = await sharp(Buffer.from(generatedCoverSvg(title, author)), { density: 72 * (width / 400) * 2 })
    .resize({ width, height: Math.round(width * 1.5), fit: 'cover' })
    .webp({ quality: 80 })
    .toBuffer();
  await writeAtomically(out, data);
  return out;
}
