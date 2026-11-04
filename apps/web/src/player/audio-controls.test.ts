import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { AUDIO_CONTROLS_STORAGE_KEY, audioControlsChoice, audioControlsHidden, chooseAudioControlsDefault, chooseBookAudioControls, sendUnsentAudioControls } from './audio-controls';

const offline = () => new TypeError('Failed to fetch');
const stored = () => JSON.parse(localStorage.getItem(AUDIO_CONTROLS_STORAGE_KEY)!) as { ana: { books: Record<string, unknown> } };

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, 'setAudioControls').mockImplementation(async (body) => body);
  vi.spyOn(api, 'setBookAudioControls').mockImplementation(async (_bookId, body) => body);
});
afterEach(() => vi.restoreAllMocks());

describe('the audiobook’s controls in the book (D197)', () => {
  it('are shown until hidden: by your default, or by the book’s own choice over it', async () => {
    expect(audioControlsHidden('ana', 'book')).toBe(false);
    expect(audioControlsHidden('ana', 'book', { default: { hidden: true, at: 5 } })).toBe(true);
    // The server's "shown, at 0" is nobody's choice.
    expect(audioControlsChoice('ana', 'book', { default: { hidden: false, at: 0 } })).toEqual({ hidden: false, book: null, byDefault: false });
    expect(audioControlsChoice('ana', 'book', { default: { hidden: true, at: 5 }, book: { hidden: false, at: 6 } })).toEqual({ hidden: false, book: false, byDefault: true });
    // A book's "as my default" leaves it to the default.
    expect(audioControlsChoice('ana', 'book', { default: { hidden: true, at: 5 }, book: { hidden: null, at: 6 } })).toEqual({ hidden: true, book: null, byDefault: true });
  });

  it('the newest choice wins, between this device and the server', async () => {
    await chooseBookAudioControls('ana', 'book', true, 100);
    expect(audioControlsHidden('ana', 'book', { book: { hidden: false, at: 50 } })).toBe(true);
    expect(audioControlsHidden('ana', 'book', { book: { hidden: false, at: 200 } })).toBe(false);
    await chooseAudioControlsDefault('ana', true, 300);
    expect(audioControlsChoice('ana', 'other', { default: { hidden: false, at: 250 } }).hidden).toBe(true);
    expect(audioControlsChoice('ana', 'other', { default: { hidden: false, at: 350 } }).hidden).toBe(false);
  });

  it('is per person on a shared device, and nothing for nobody signed in', async () => {
    await chooseAudioControlsDefault('ana', true, 100);
    expect(audioControlsHidden('ana', 'book')).toBe(true);
    expect(audioControlsHidden('ben', 'book')).toBe(false);
    expect(audioControlsHidden(undefined, 'book')).toBe(false);
    expect(await chooseAudioControlsDefault(undefined, true)).toBeNull();
    expect(api.setAudioControls).toHaveBeenCalledTimes(1);
  });

  it('a choice made offline is kept here and sent once the connection is back', async () => {
    vi.mocked(api.setBookAudioControls).mockRejectedValueOnce(offline());
    vi.mocked(api.setAudioControls).mockRejectedValueOnce(offline());
    await chooseBookAudioControls('ana', 'book', true, 100);
    await chooseAudioControlsDefault('ana', true, 110);
    expect(audioControlsHidden('ana', 'book')).toBe(true);
    expect(stored().ana.books.book).toEqual({ hidden: true, at: 100, unsent: true });
    await sendUnsentAudioControls('ana');
    expect(api.setBookAudioControls).toHaveBeenLastCalledWith('book', { hidden: true, at: 100 });
    expect(api.setAudioControls).toHaveBeenLastCalledWith({ hidden: true, at: 110 });
    expect(stored().ana.books.book).toEqual({ hidden: true, at: 100 });
    // Nothing left to send.
    vi.mocked(api.setBookAudioControls).mockClear();
    await sendUnsentAudioControls('ana');
    expect(api.setBookAudioControls).not.toHaveBeenCalled();
  });

  it('keeps the server’s newer answer, and stops resending what the server refuses for good', async () => {
    vi.mocked(api.setAudioControls).mockResolvedValueOnce({ hidden: false, at: 999 });
    await chooseAudioControlsDefault('ana', true, 100);
    expect(audioControlsChoice('ana', 'book').byDefault).toBe(false);
    vi.mocked(api.setBookAudioControls).mockRejectedValueOnce(new ApiError(404, 'gone', 'not_found'));
    await chooseBookAudioControls('ana', 'gone', true, 100);
    vi.mocked(api.setBookAudioControls).mockClear();
    await sendUnsentAudioControls('ana');
    expect(api.setBookAudioControls).not.toHaveBeenCalled();
  });
});
