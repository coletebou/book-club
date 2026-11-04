import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { SPEED_STORAGE_KEYS, chooseBookRate, chooseDefaultRate, currentDefaultRate, openingRate, rememberedBookRate, rememberedDefault, sendUnsentSpeeds } from './speed-memory';

const offline = () => new TypeError('Failed to fetch');
const settings = (defaultRate: number, at: number) => ({ defaultRate, at });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, 'setBookPlayback').mockImplementation(async (_bookId, body) => body);
  vi.spyOn(api, 'setListening').mockImplementation(async (body) => body);
});
afterEach(() => vi.restoreAllMocks());

describe('the speed a book opens at (D195)', () => {
  it("is the book's own last speed, else your default, else 1.0×", () => {
    expect(openingRate('ana', 'book', {}).rate).toBe(1);
    expect(openingRate('ana', 'book', { settings: settings(1, 0) }).rate).toBe(1);
    expect(openingRate('ana', 'book', { settings: settings(1.25, 10) }).rate).toBe(1.25);
    expect(openingRate('ana', 'book', { playback: { rate: 1.35, at: 5 }, settings: settings(1.25, 10) }).rate).toBe(1.35);
  });

  it("says whether the speed is the book's own or only the default", async () => {
    expect(openingRate('ana', 'book', { settings: settings(1.25, 10) })).toEqual({ rate: 1.25, own: false });
    expect(openingRate('ana', 'book', { playback: { rate: 1.5, at: 1 } })).toEqual({ rate: 1.5, own: true });
    await chooseBookRate('ana', 'other', 1.1, 5);
    expect(openingRate('ana', 'other', {})).toEqual({ rate: 1.1, own: true });
  });

  it('the newest choice wins, between this device and the server', async () => {
    await chooseBookRate('ana', 'book', 1.1, 100);
    expect(openingRate('ana', 'book', { playback: { rate: 1.5, at: 50 } }).rate).toBe(1.1);
    expect(openingRate('ana', 'book', { playback: { rate: 1.5, at: 200 } }).rate).toBe(1.5);
    // What the server said is kept here, for opening the book offline next time.
    expect(rememberedBookRate('ana', 'book')).toEqual({ rate: 1.5, at: 200 });
    expect(openingRate('ana', 'book', {}).rate).toBe(1.5);
  });

  it('is per person on a shared device', async () => {
    await chooseBookRate('ana', 'book', 1.75, 100);
    await chooseDefaultRate('ana', 1.25, 100);
    expect(openingRate('ben', 'book', {}).rate).toBe(1);
    expect(openingRate('ana', 'book', {}).rate).toBe(1.75);
    expect(openingRate('ana', 'other', {}).rate).toBe(1.25);
  });

  it("the device-wide speed from before (D195) becomes this book's own, once, and is sent", () => {
    localStorage.setItem(SPEED_STORAGE_KEYS.legacy, '1.5');
    expect(openingRate('ana', 'book', {}).rate).toBe(1.5);
    expect(api.setBookPlayback).toHaveBeenCalledWith('book', { rate: 1.5, at: expect.any(Number) as number });
    expect(localStorage.getItem(SPEED_STORAGE_KEYS.legacy)).toBeNull();
    expect(openingRate('ana', 'other', {}).rate).toBe(1);
  });

  it('the old speed is dropped when the book has its own, or when it is just the default', () => {
    localStorage.setItem(SPEED_STORAGE_KEYS.legacy, '1');
    expect(openingRate('ana', 'book', {}).rate).toBe(1);
    expect(api.setBookPlayback).not.toHaveBeenCalled();
    expect(localStorage.getItem(SPEED_STORAGE_KEYS.legacy)).toBeNull();
    localStorage.setItem(SPEED_STORAGE_KEYS.legacy, '2');
    expect(openingRate('ana', 'book', { playback: { rate: 1.1, at: 9 } }).rate).toBe(1.1);
    expect(localStorage.getItem(SPEED_STORAGE_KEYS.legacy)).toBe('2'); // Kept for a book with none of its own.
  });

  it('ignores what was stored corrupt rather than playing it', () => {
    localStorage.setItem(SPEED_STORAGE_KEYS.current, JSON.stringify({ ana: { default: { rate: 9, at: 5 }, books: { book: { rate: 'fast', at: 5 } } } }));
    expect(openingRate('ana', 'book', {}).rate).toBe(1);
    localStorage.setItem(SPEED_STORAGE_KEYS.current, '{not json');
    expect(openingRate('ana', 'book', { playback: { rate: 1.2, at: 1 } }).rate).toBe(1.2);
  });

  it('without a signed-in person, what the server says still applies', () => {
    expect(openingRate(undefined, 'book', { playback: { rate: 1.6, at: 1 } }).rate).toBe(1.6);
    expect(currentDefaultRate(undefined, settings(1.3, 1))).toBe(1.3);
  });
});

describe('choosing a speed offline (D195)', () => {
  it('a book speed chosen offline is kept here, then sent once the connection is back', async () => {
    vi.mocked(api.setBookPlayback).mockRejectedValueOnce(offline());
    await chooseBookRate('ana', 'book', 1.35, 100);
    expect(rememberedBookRate('ana', 'book')).toEqual({ rate: 1.35, at: 100, unsent: true });
    expect(openingRate('ana', 'book', { playback: { rate: 1, at: 50 } }).rate).toBe(1.35);
    await sendUnsentSpeeds('ana');
    expect(api.setBookPlayback).toHaveBeenLastCalledWith('book', { rate: 1.35, at: 100 });
    expect(rememberedBookRate('ana', 'book')).toEqual({ rate: 1.35, at: 100 });
    // Nothing left to send.
    vi.mocked(api.setBookPlayback).mockClear();
    await sendUnsentSpeeds('ana');
    expect(api.setBookPlayback).not.toHaveBeenCalled();
  });

  it("the server's newer answer replaces an older choice sent late", async () => {
    vi.mocked(api.setBookPlayback).mockResolvedValueOnce({ rate: 2, at: 500 });
    await chooseBookRate('ana', 'book', 1.35, 100);
    expect(rememberedBookRate('ana', 'book')).toEqual({ rate: 2, at: 500 });
  });

  it('a refusal that would not change on retry (the book is gone) stops the retries', async () => {
    vi.mocked(api.setBookPlayback).mockRejectedValueOnce(new ApiError(404, 'not_found', 'Book not found.'));
    await chooseBookRate('ana', 'book', 1.35, 100);
    expect(rememberedBookRate('ana', 'book')).toEqual({ rate: 1.35, at: 100 });
    vi.mocked(api.setBookPlayback).mockClear();
    await sendUnsentSpeeds('ana');
    expect(api.setBookPlayback).not.toHaveBeenCalled();
  });

  it('a server error or rate limit keeps it for later', async () => {
    vi.mocked(api.setBookPlayback).mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Try again.'));
    await chooseBookRate('ana', 'book', 1.35, 100);
    expect(rememberedBookRate('ana', 'book')?.unsent).toBe(true);
    vi.mocked(api.setBookPlayback).mockRejectedValueOnce(new ApiError(429, 'too_many', 'Slow down.'));
    await sendUnsentSpeeds('ana');
    expect(rememberedBookRate('ana', 'book')?.unsent).toBe(true);
  });

  it('a default chosen offline is the default here at once, and is sent later', async () => {
    vi.mocked(api.setListening).mockRejectedValueOnce(offline());
    expect(await chooseDefaultRate('ana', 1.25, 100)).toBeNull();
    expect(currentDefaultRate('ana', settings(1, 0))).toBe(1.25);
    // A newer default from another device, seen on the server, wins over it.
    expect(currentDefaultRate('ana', settings(1.5, 200))).toBe(1.5);
    await sendUnsentSpeeds('ana');
    expect(api.setListening).toHaveBeenLastCalledWith({ defaultRate: 1.25, at: 100 });
    expect(rememberedDefault('ana')).toEqual({ rate: 1.25, at: 100 });
  });

  it('snaps what is chosen to a 0.05 step', async () => {
    await chooseBookRate('ana', 'book', 1.3700001, 100);
    expect(api.setBookPlayback).toHaveBeenCalledWith('book', { rate: 1.35, at: 100 });
  });

  it('does nothing for nobody', async () => {
    await chooseBookRate(undefined, 'book', 1.5);
    expect(await chooseDefaultRate(undefined, 1.5)).toBeNull();
    await sendUnsentSpeeds(null);
    expect(api.setBookPlayback).not.toHaveBeenCalled();
    expect(api.setListening).not.toHaveBeenCalled();
  });
});
