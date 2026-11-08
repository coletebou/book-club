/**
 * Naming the iOS app's offline copy of an audiobook track (D138, D219), pure so it is tested here
 * rather than only in the simulator.
 *
 * AVFoundation picks a local file's format from its file name: `AVURLAsset` on a file with no
 * extension fails with AVFoundationErrorDomain -11828 ("cannot open", the format is not
 * recognised), whatever the bytes are. Track URLs have no extension
 * (`/media/editions/<id>/tracks/<n>`), and before D219 the copy was named after the URL alone, so
 * a track heard once never played again in the app. A copy is now named after the URL plus the
 * extension its own first bytes say it is, and a copy whose bytes are not audio iOS plays is not
 * kept at all.
 */

/** The containers AVFoundation plays from a local file, by the extension that tells it which. */
export const OFFLINE_AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'aiff', 'flac', 'caf'] as const;
export type OfflineAudioExtension = (typeof OFFLINE_AUDIO_EXTENSIONS)[number];

/** How many leading bytes `sniffAudioExtension` needs. */
export const SNIFF_BYTES = 12;

/** The suffix of a download still being written: never a playable copy. */
export const PARTIAL_SUFFIX = '.part';

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

/**
 * The extension a file's first bytes (`SNIFF_BYTES` of them) say it is, or null for anything that
 * is not audio iOS plays: an HTML or JSON error body, Ogg (which AVFoundation does not open), or
 * too few bytes to tell.
 */
export function sniffAudioExtension(bytes: Uint8Array): OfflineAudioExtension | null {
  if (bytes.length < 4) return null;
  // ISO base media (MP4, M4A, M4B): a box size, then `ftyp`.
  if (bytes.length >= 8 && ascii(bytes, 4, 8) === 'ftyp') return 'm4a';
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (ascii(bytes, 0, 4) === 'caff') return 'caf';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'wav';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'FORM' && (ascii(bytes, 8, 12) === 'AIFF' || ascii(bytes, 8, 12) === 'AIFC')) return 'aiff';
  // A raw frame: 11 sync bits. The two layer bits then tell MPEG audio (layer I-III, non-zero) from
  // AAC's ADTS header (layer 00, 12 sync bits).
  const b0 = bytes[0]!;
  const b1 = bytes[1]!;
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) {
    const layer = (b1 >> 1) & 0x3;
    if (layer !== 0) return 'mp3';
    if ((b1 & 0xf0) === 0xf0) return 'aac';
  }
  return null;
}

/**
 * How many bytes an ID3v2 tag at the start of a file takes (its 10-byte header, its syncsafe size,
 * and a footer if it says it has one), or null when the file does not start with one. Whatever
 * follows it is the audio: an MPEG frame, or AAC's ADTS (D219, an `.aac` audiobook tagged with ID3).
 */
export function id3TagLength(bytes: Uint8Array): number | null {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return null;
  const size = bytes.subarray(6, 10);
  if (size.some((b) => b & 0x80)) return null; // not syncsafe: not a tag
  const footer = bytes[5]! & 0x10 ? 10 : 0;
  return 10 + ((size[0]! << 21) | (size[1]! << 14) | (size[2]! << 7) | size[3]!) + footer;
}

/** What the first frame after an ID3 tag is: AAC (ADTS) or MPEG audio; MP3 when it cannot tell. */
export function sniffAfterId3(frame: Uint8Array): 'mp3' | 'aac' {
  const ext = frame.length >= 2 ? sniffAudioExtension(Uint8Array.from([...frame.subarray(0, 4), 0, 0, 0, 0, 0, 0, 0, 0])) : null;
  return ext === 'aac' ? 'aac' : 'mp3';
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 (what `expo-file-system` reads a file's bytes as) to bytes; invalid characters are skipped. */
export function bytesFromBase64(b64: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of b64) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * The name, without extension, of a track's offline copy: deterministic from its URL (each
 * edition's tracks have distinct paths, so this never collides). The same name D138 used, so a
 * copy kept by an earlier build is found and given its extension rather than downloaded again.
 */
export function offlineBaseName(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, '_').slice(-180);
}

/** The file name of a typed offline copy. */
export function offlineFileName(base: string, ext: OfflineAudioExtension): string {
  return `${base}.${ext}`;
}

/**
 * What a directory listing holds for one track: its playable copy (`<base>.<ext>`), and whether an
 * untyped copy from before D219 (`<base>`, which iOS cannot open) is there to be fixed up.
 */
export function findOfflineCopy(entries: readonly string[], base: string): { readonly typed: string | null; readonly legacy: boolean } {
  let typed: string | null = null;
  let legacy = false;
  for (const name of entries) {
    if (name === base) legacy = true;
    else if (!typed && name.startsWith(`${base}.`) && (OFFLINE_AUDIO_EXTENSIONS as readonly string[]).includes(name.slice(base.length + 1))) typed = name;
  }
  return { typed, legacy };
}

/** The domains a native playback error can be reported with (D219): a closed list, never free text. */
export const NATIVE_ERROR_DOMAINS = ['AVFoundationErrorDomain', 'NSURLErrorDomain', 'NSOSStatusErrorDomain', 'CoreMediaErrorDomain', 'NSPOSIXErrorDomain', 'NSCocoaErrorDomain', 'other'] as const;
export type NativeErrorDomain = (typeof NATIVE_ERROR_DOMAINS)[number];

/** A native error's domain as reportable: one of the known ones, or `other`; nothing for none. */
export function reportableErrorDomain(domain: unknown): NativeErrorDomain | undefined {
  if (typeof domain !== 'string' || !domain) return undefined;
  return (NATIVE_ERROR_DOMAINS as readonly string[]).includes(domain) ? (domain as NativeErrorDomain) : 'other';
}

/** A native error's code as reportable: an int32, or nothing. */
export function reportableErrorCode(code: unknown): number | undefined {
  return typeof code === 'number' && Number.isInteger(code) && code >= -2147483648 && code <= 2147483647 ? code : undefined;
}
