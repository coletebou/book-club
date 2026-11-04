import { type ImageSize } from './normalize';

/**
 * Intrinsic dimensions of JPEG, PNG, GIF, WebP and SVG images from their headers, without
 * decoding. Used to write `width`/`height` on `<img>` so that pagination never waits for, or
 * shifts after, an image load.
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature then IHDR width/height (big endian).
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes.length >= 24) {
    return positive(view.getUint32(16), view.getUint32(20));
  }
  // GIF: "GIF8" then little-endian width/height.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return positive(view.getUint16(6, true), view.getUint16(8, true));
  }
  // JPEG: walk segments to the first start-of-frame marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = view.getUint16(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return positive(view.getUint16(i + 7), view.getUint16(i + 5));
      i += 2 + length;
    }
    return null;
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X chunk.
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8 ') return positive(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    if (chunk === 'VP8L') {
      const b = view.getUint32(21, true);
      return positive((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') {
      const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return positive(w, h);
    }
    return null;
  }
  // SVG: width/height attributes, else the viewBox. The tag is found by searching, not by a pattern
  // tried again from every `<svg` (a head full of them cost its length squared), and each run of
  // spaces in the size pattern can be matched one way only.
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const start = head.search(/<svg\b/i);
  const end = start === -1 ? -1 : head.indexOf('>', start);
  if (end !== -1) {
    const tag = head.slice(start, end + 1);
    const num = (name: string) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px\\s*)?["']`, 'i').exec(tag);
      return m ? Number.parseFloat(m[1]!) : null;
    };
    const w = num('width');
    const h = num('height');
    if (w && h) return positive(Math.round(w), Math.round(h));
    const vb = /\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
    if (vb) return positive(Math.round(Number.parseFloat(vb[1]!)), Math.round(Number.parseFloat(vb[2]!)));
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function positive(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}
