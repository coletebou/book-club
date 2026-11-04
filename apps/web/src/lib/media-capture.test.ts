import { describe, expect, it } from 'vitest';
import { LIMITS } from '@bookclub/shared';
import { checkPhotoFile, pickVoiceMimeType, suggestedFilename } from './media-capture';

describe('media-capture (D140, D149)', () => {
  it('accepts a photo within the size cap, refuses one over it', () => {
    const small = new File([new Uint8Array(1024)], 'a.jpg', { type: 'image/jpeg' });
    expect(checkPhotoFile(small)).toEqual({ ok: true, message: null });
    const big = new File([new Uint8Array(LIMITS.photoNoteBytes + 1)], 'b.jpg', { type: 'image/jpeg' });
    const result = checkPhotoFile(big);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/larger than/);
  });

  it('picks the first mime type the browser supports, in order: mp4 (Safari) before webm (Chrome)', () => {
    const supportsOnly = (...types: string[]) => ({ isTypeSupported: (t: string) => types.includes(t) });
    expect(pickVoiceMimeType(supportsOnly('audio/mp4'))).toBe('audio/mp4');
    expect(pickVoiceMimeType(supportsOnly('audio/webm;codecs=opus', 'audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickVoiceMimeType(supportsOnly('audio/mp4', 'audio/webm'))).toBe('audio/mp4');
    expect(pickVoiceMimeType(supportsOnly())).toBeUndefined();
  });

  it('never throws when isTypeSupported itself throws on an unknown string', () => {
    expect(pickVoiceMimeType({ isTypeSupported: () => { throw new Error('nope'); } })).toBeUndefined();
  });

  it('suggests a filename with the right extension for each mime family', () => {
    expect(suggestedFilename('voice', 'audio/mp4')).toMatch(/\.m4a$/);
    expect(suggestedFilename('voice', 'audio/webm;codecs=opus')).toMatch(/\.webm$/);
    expect(suggestedFilename('video', 'video/mp4')).toMatch(/\.mp4$/);
    expect(suggestedFilename('voice', undefined)).toMatch(/\.m4a$/);
  });
});
