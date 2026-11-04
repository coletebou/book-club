import { afterEach, describe, expect, it } from 'vitest';
import { ALLOW_AUDIO_ONLY_KEY, allowAudioOnly, readAlongFromListen, setAllowAudioOnly } from './allow-audio-only';

afterEach(() => {
  localStorage.removeItem(ALLOW_AUDIO_ONLY_KEY);
});

describe('allow audio-only view (D198)', () => {
  it('is off by default', () => {
    expect(allowAudioOnly()).toBe(false);
  });

  it('remembers the choice on this device', () => {
    setAllowAudioOnly(true);
    expect(allowAudioOnly()).toBe(true);
    setAllowAudioOnly(false);
    expect(allowAudioOnly()).toBe(false);
  });

  it('redirects /listen to the reader keeping at and comment', () => {
    expect(readAlongFromListen('book_1', 'ed_audio', new URLSearchParams())).toBe('/books/book_1/read?along=ed_audio');
    expect(readAlongFromListen('book_1', 'ed_audio', new URLSearchParams('at=0.4&comment=c1&edition=ed_audio'))).toBe(
      '/books/book_1/read?along=ed_audio&at=0.4&comment=c1',
    );
  });
});
