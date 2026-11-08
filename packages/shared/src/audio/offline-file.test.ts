import { describe, expect, it } from 'vitest';
import {
  OFFLINE_AUDIO_EXTENSIONS, SNIFF_BYTES, bytesFromBase64, findOfflineCopy, offlineBaseName, offlineFileName,
  reportableErrorCode, reportableErrorDomain, sniffAudioExtension,
} from './offline-file';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const text = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

// The first 12 bytes of real files made with afconvert/ffmpeg on macOS, each of which AVFoundation
// opened under the extension expected here (and failed to open, -11828, with none).
const REAL = {
  m4b: '0000001c667479704d344120', // ftyp M4A, an audiobook's MP4 container
  mp3WithId3: '494433040000000000225453',
  mp3Frame: 'fff340c40000000000000000', // MPEG-2 layer III frame header
  adtsAac: 'fff95c6001600000d04007ff',
  wav: '52494646b27c010057415645',
  aiff: '464f524d00017cb241494643',
  caf: '636166660001000064657363',
  flac: '664c61430000002208000800',
  ogg: '4f6767530002000000000000',
};

describe('sniffAudioExtension (D219: an offline copy iOS can open)', () => {
  it('names each container AVFoundation plays by the extension that makes it open the file', () => {
    expect(sniffAudioExtension(hex(REAL.m4b))).toBe('m4a');
    expect(sniffAudioExtension(hex(REAL.mp3WithId3))).toBe('mp3');
    expect(sniffAudioExtension(hex(REAL.mp3Frame))).toBe('mp3');
    expect(sniffAudioExtension(hex(REAL.adtsAac))).toBe('aac');
    expect(sniffAudioExtension(hex(REAL.wav))).toBe('wav');
    expect(sniffAudioExtension(hex(REAL.aiff))).toBe('aiff');
    expect(sniffAudioExtension(hex(REAL.caf))).toBe('caf');
    expect(sniffAudioExtension(hex(REAL.flac))).toBe('flac');
  });

  it('keeps no copy of what is not audio iOS plays: an error page, JSON, Ogg, too few bytes', () => {
    expect(sniffAudioExtension(text('<!doctype html><html>'))).toBeNull();
    expect(sniffAudioExtension(text('{"error":"Sign in"}'))).toBeNull();
    expect(sniffAudioExtension(hex(REAL.ogg))).toBeNull();
    expect(sniffAudioExtension(hex('fff3'))).toBeNull();
    expect(sniffAudioExtension(new Uint8Array())).toBeNull();
  });

  it('needs no more than SNIFF_BYTES', () => {
    for (const h of Object.values(REAL)) expect(hex(h).subarray(0, SNIFF_BYTES).length).toBeLessThanOrEqual(SNIFF_BYTES);
  });
});

describe('bytesFromBase64', () => {
  it('decodes what expo-file-system reads as base64, padding and all', () => {
    expect([...bytesFromBase64('SUQzBAA=')]).toEqual([0x49, 0x44, 0x33, 0x04, 0x00]);
    expect([...bytesFromBase64(Buffer.from(hex(REAL.m4b)).toString('base64'))]).toEqual([...hex(REAL.m4b)]);
    expect([...bytesFromBase64('')]).toEqual([]);
  });
});

describe('offline copy naming (D138, D219)', () => {
  const url = 'https://books.example/media/editions/ed1/tracks/39';
  const base = offlineBaseName(url);

  it('keeps D138’s name, so a copy kept by an earlier build is found, and adds the extension', () => {
    expect(base).toBe('https___books_example_media_editions_ed1_tracks_39');
    expect(offlineFileName(base, 'mp3')).toBe(`${base}.mp3`);
    expect(offlineBaseName(`https://x/${'a'.repeat(400)}`)).toHaveLength(180);
  });

  it('finds the typed copy, and says when an untyped one from before is there', () => {
    expect(findOfflineCopy([`${base}.m4a`], base)).toEqual({ typed: `${base}.m4a`, legacy: false });
    expect(findOfflineCopy([base], base)).toEqual({ typed: null, legacy: true });
    expect(findOfflineCopy([base, `${base}.mp3`], base)).toEqual({ typed: `${base}.mp3`, legacy: true });
  });

  it('never takes a download still being written, another track, or an unknown extension for the copy', () => {
    expect(findOfflineCopy([`${base}.part`, `${base}0.mp3`, `${base}.ogg`, `${base}.mp3.part`], base)).toEqual({ typed: null, legacy: false });
    // track 3 is not track 39, and track 39 is not track 3
    expect(findOfflineCopy([`${offlineBaseName(url.replace(/39$/, '3'))}.mp3`], base).typed).toBeNull();
    expect(findOfflineCopy([`${base}.mp3`], offlineBaseName(url.replace(/39$/, '3'))).typed).toBeNull();
  });

  it('every extension it can choose is one it can find again', () => {
    for (const ext of OFFLINE_AUDIO_EXTENSIONS) expect(findOfflineCopy([offlineFileName(base, ext)], base).typed).toBe(`${base}.${ext}`);
  });
});

describe('reportable native errors (D219: content-free)', () => {
  it('a known domain as itself, any other as other, never free text', () => {
    expect(reportableErrorDomain('AVFoundationErrorDomain')).toBe('AVFoundationErrorDomain');
    expect(reportableErrorDomain('/private/var/mobile/secret')).toBe('other');
    expect(reportableErrorDomain(undefined)).toBeUndefined();
    expect(reportableErrorDomain('')).toBeUndefined();
  });

  it('an int32 code only', () => {
    expect(reportableErrorCode(-11828)).toBe(-11828);
    expect(reportableErrorCode(1.5)).toBeUndefined();
    expect(reportableErrorCode(2 ** 40)).toBeUndefined();
    expect(reportableErrorCode('-11828')).toBeUndefined();
  });
});
