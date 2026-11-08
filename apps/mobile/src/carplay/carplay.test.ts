/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type WidgetBook, type WidgetSnapshot } from '@bookclub/shared';
import { describe, expect, it, vi } from 'vitest';
import { type KeptPlace } from '../audio/BackgroundProgress';
import { CarPlayDriver, type ServerPlace, startingPlace } from './CarPlayDriver';
import { KEPT_QUEUES_MAX, KeptQueues, parseKeptQueues, withQueue } from './keptQueues';
import { type KeptQueue, carPlayModel, parseCarCommand } from './model';

const book = (bookId: string, title: string, extra: Partial<WidgetBook> = {}): WidgetBook => ({
  bookId, clubId: 'club01', clubName: 'Tuesday Club', title, author: 'Ursula', coverUrl: `https://books.test/covers/${bookId}`, t: 0.25, percent: 25,
  label: 'Chapter 4 · 25%', format: 'audio', finished: false, at: 1_000, stop: null, ...extra,
});
const snapshot = (current: WidgetBook | null, ...others: WidgetBook[]): WidgetSnapshot => ({ generatedAt: 1, current, others });
const queue = (bookId: string, at: number, tracks = ['Chapter 1', 'Chapter 2', 'Chapter 3']): KeptQueue => ({
  bookId, editionId: `e-${bookId}`, userId: 'u1', title: `Queue title ${bookId}`, author: 'Ursula', artworkUrl: null, at,
  tracks: tracks.map((title, i) => ({ url: `https://books.test/media/editions/e-${bookId}/tracks/${i}`, title })),
});
const kept = (bookId: string, track: number, ms: number, at: number): KeptPlace => ({ bookId, editionId: `e-${bookId}`, userId: 'u1', locator: { kind: 'audio', track, ms }, at, spans: [] });

describe('what CarPlay lists (D221)', () => {
  it('lists only the books of the person signed in now, and plays only those opened on this phone', () => {
    const m = carPlayModel({ snapshot: snapshot(book('b1', 'Earthsea'), book('b2', 'Dune')), queues: [queue('b1', 5), queue('gone', 9)], nowPlaying: null });
    expect(m.books.map((b) => [b.id, b.playable])).toEqual([['book:b1', true], ['book:b2', false]]);
    expect(m.books[1]!.detail).toBe('Open its audiobook on your iPhone first');
    // A queue kept for a book no longer in the snapshot (another person's, or a club left) is never shown.
    expect(JSON.stringify(m)).not.toContain('gone');
    expect(m.continue).toEqual(expect.objectContaining({ id: 'continue', title: 'Earthsea', detail: 'Chapter 4 · 25%', coverBookId: 'b1' }));
  });

  it('lists nothing at all signed out (no snapshot), whatever is kept', () => {
    expect(carPlayModel({ snapshot: null, queues: [queue('b1', 5)], nowPlaying: { bookId: 'b1', track: 0, playing: true } })).toEqual({ continue: null, books: [], chapters: null, nav: null });
  });

  it('continues the book playing, else the one heard last; its chapters are the track titles the page gave', () => {
    const snap = snapshot(book('b1', 'Earthsea'), book('b2', 'Dune'));
    const queues = [queue('b1', 5), queue('b2', 9, ['Part 1', 'Part 2'])];
    expect(carPlayModel({ snapshot: snap, queues, nowPlaying: null }).continue?.coverBookId).toBe('b2');
    const m = carPlayModel({ snapshot: snap, queues, nowPlaying: { bookId: 'b1', track: 1, playing: true } });
    expect(m.continue).toEqual(expect.objectContaining({ coverBookId: 'b1', detail: 'Chapter 2', playing: true }));
    expect(m.chapters?.rows.map((r) => [r.id, r.title, r.playing])).toEqual([['chapter:b1:0', 'Chapter 1', false], ['chapter:b1:1', 'Chapter 2', true], ['chapter:b1:2', 'Chapter 3', false]]);
    expect(m.books.find((b) => b.id === 'book:b1')?.playing).toBe(true);
    expect(carPlayModel({ snapshot: snap, queues, nowPlaying: null, chaptersOf: 'b1' }).chapters?.bookId).toBe('b1');
  });

  it('reads a row id back as its command, and nothing else', () => {
    expect(parseCarCommand('continue')).toEqual({ kind: 'continue' });
    expect(parseCarCommand('book:b-1_x')).toEqual({ kind: 'book', bookId: 'b-1_x' });
    expect(parseCarCommand('chapter:b1:12')).toEqual({ kind: 'chapter', bookId: 'b1', track: 12 });
    for (const bad of ['book:', 'book:a/b', 'chapter:b1:-1', 'chapter:b1:x', 'nope', 42, null]) expect(parseCarCommand(bad)).toBeNull();
  });

  it('is what the native side decodes (the shared vectors, scripts/test-carplay-swift.sh)', () => {
    const vectors = JSON.parse(readFileSync(path.join(__dirname, 'carplay-vectors.json'), 'utf8')) as { model: unknown };
    const m = carPlayModel({
      snapshot: snapshot(book('b1', 'Earthsea'), book('b2', 'Dune')),
      queues: [queue('b1', 5, ['Chapter 1', 'Chapter 2'])],
      nowPlaying: { bookId: 'b1', track: 1, playing: true },
      nav: { seq: 3, to: 'nowPlaying' },
    });
    expect(m).toEqual(vectors.model);
  });
});

describe('the audiobooks kept on the device for the car (D221)', () => {
  it('keeps one queue a book, newest first, at most a few', () => {
    let list: KeptQueue[] = [];
    for (let i = 0; i < KEPT_QUEUES_MAX + 2; i++) list = withQueue(list, queue(`b${i}`, i));
    list = withQueue(list, queue('b3', 100));
    expect(list).toHaveLength(KEPT_QUEUES_MAX);
    expect(list.map((q) => q.bookId).slice(0, 2)).toEqual(['b3', 'b7']);
  });

  it('keeps one person’s only: another’s queue leaves the last person’s behind', () => {
    const mine = withQueue(withQueue([], queue('b1', 1)), queue('b2', 2));
    const theirs = withQueue(mine, { ...queue('b3', 3), userId: 'u2' });
    expect(theirs.map((q) => [q.bookId, q.userId])).toEqual([['b3', 'u2']]);
  });

  it('drops what it cannot read', () => {
    expect(parseKeptQueues('not json')).toEqual([]);
    expect(parseKeptQueues(JSON.stringify([queue('b1', 1), { bookId: 'b2' }, { ...queue('b3', 1), tracks: [] }]))).toEqual([queue('b1', 1)]);
  });

  it('writes each change through, but not the same queue again; and forgets everything signing out', async () => {
    const file = { read: vi.fn(() => Promise.resolve(JSON.stringify([queue('b0', 1)]))), write: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) };
    const changed = vi.fn();
    const q = new KeptQueues(file, changed);
    await q.ready;
    expect(q.all().map((x) => x.bookId)).toEqual(['b0']);
    q.keep(queue('b1', 5));
    q.keep(queue('b1', 6));
    await new Promise((r) => setTimeout(r, 0)); // the file's writes go one after another
    expect(file.write).toHaveBeenCalledTimes(1);
    q.keep(queue('b0', 7)); // an earlier book again: the newest now
    expect(q.all()[0]!.bookId).toBe('b0');
    q.clear();
    expect(q.all()).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(file.remove).toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('keeps nothing of the file when signed out before it was read, and never writes after removing', async () => {
    let release: (json: string) => void = () => {};
    const order: string[] = [];
    const file = { read: () => new Promise<string>((r) => (release = r)), write: vi.fn(async () => void order.push('write')), remove: vi.fn(async () => void order.push('remove')) };
    const q = new KeptQueues(file);
    q.keep(queue('b9', 1));
    q.clear();
    release(JSON.stringify([queue('b0', 1)]));
    await q.ready;
    await new Promise((r) => setTimeout(r, 0));
    expect(q.all()).toEqual([]);
    expect(order).toEqual(['write', 'remove']);
  });
});

describe('where a book starts in the car (D221)', () => {
  const q = queue('b1', 5);
  it('takes the newer of the place kept here and the server’s, in this audiobook only', () => {
    const server = (track: number, ms: number, at: number, editionId = 'e-b1'): ServerPlace => ({ editionId, locator: { kind: 'audio', track, ms }, at });
    expect(startingPlace(q, kept('b1', 1, 500, 10), server(2, 900, 20))).toEqual({ kind: 'audio', track: 2, ms: 900 });
    expect(startingPlace(q, kept('b1', 1, 500, 30), server(2, 900, 20))).toEqual({ kind: 'audio', track: 1, ms: 500 });
    expect(startingPlace(q, kept('other', 1, 500, 30), server(2, 900, 20, 'e-other'))).toBe('unknown');
    expect(startingPlace(q, null, server(9, 0, 20))).toBe('unknown'); // not a track this queue has
    // A place kept on this phone by someone else (signed out since), or by nobody known, is not theirs.
    expect(startingPlace(q, { ...kept('b1', 1, 500, 30), userId: 'someone-else' }, null)).toEqual({ kind: 'audio', track: 0, ms: 0 });
    expect(startingPlace(q, { ...kept('b1', 1, 500, 30), userId: null }, server(2, 900, 20))).toEqual({ kind: 'audio', track: 2, ms: 900 });
  });
  it('starts a book never begun at its beginning, and guesses nothing else', () => {
    expect(startingPlace(q, null, null)).toEqual({ kind: 'audio', track: 0, ms: 0 });
    expect(startingPlace(q, null, undefined)).toBe('unknown'); // offline
    expect(startingPlace(q, null, { editionId: null, locator: { kind: 'epub' }, at: 5 })).toBe('unknown'); // reading the ebook
  });
});

describe('a tap in the car (D221)', () => {
  /** `server` absent: never started (null); present as undefined: the server could not be asked. */
  function setup(opts: { server?: ServerPlace | null; kept?: KeptPlace | null } = {}) {
    const server = 'server' in opts ? opts.server : null;
    const keptPlace = opts.kept ?? null;
    const models: Record<string, unknown>[] = [];
    const native = { setCarPlayModel: vi.fn((json: string) => models.push(JSON.parse(json) as Record<string, unknown>)), widgetSnapshot: () => JSON.stringify(snapshot(book('book01', 'Earthsea'), book('book02', 'Dune'))) };
    const engine = { playFromCar: vi.fn(), carDisconnected: vi.fn(), keptPlace: vi.fn(() => Promise.resolve(keptPlace)) };
    const queues = new KeptQueues({ read: () => Promise.resolve(JSON.stringify([queue('book01', 5)])), write: () => Promise.resolve(), remove: () => Promise.resolve() });
    const driver = new CarPlayDriver({ native, engine, queues, serverPlace: vi.fn(() => Promise.resolve(server)) });
    const nav = () => models.at(-1)?.nav as { to: string; message?: string } | null;
    return { driver, engine, nav, native, queues };
  }

  it('continues the book from its place, in the car, going on into its next tracks, then shows Now Playing', async () => {
    const { driver, engine, nav } = setup({ server: { editionId: 'e-book01', locator: { kind: 'audio', track: 2, ms: 1234 }, at: 50 } });
    await driver.command('continue');
    expect(engine.playFromCar).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'book01', editionId: 'e-book01', userId: 'u1', advance: true }), expect.objectContaining({ title: 'Chapter 3', albumTitle: 'Queue title book01', artist: 'Ursula' }), 2, 1234);
    expect(nav()?.to).toBe('nowPlaying');
  });

  it('shows the chapters of a book whose place in this audiobook is not known, rather than guess', async () => {
    const { driver, engine, nav } = setup({ server: undefined });
    await driver.command('book:book01');
    expect(engine.playFromCar).not.toHaveBeenCalled();
    expect(nav()?.to).toBe('chapters');
  });

  it('plays a chapter from its beginning, or from the place when it is the chapter you are in', async () => {
    const { driver, engine } = setup({ kept: kept('book01', 1, 777, 10) });
    await driver.command('chapter:book01:0');
    expect(engine.playFromCar).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 0, 0);
    await driver.command('chapter:book01:1');
    expect(engine.playFromCar).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 1, 777);
    await driver.command('chapter:book01:9');
    expect(engine.playFromCar).toHaveBeenCalledTimes(2);
  });

  it('plays nothing it does not list: a book not opened on this phone, or not this person’s', async () => {
    const { driver, engine, nav } = setup();
    await driver.command('book:book02');
    expect(nav()).toEqual(expect.objectContaining({ to: 'message', message: 'Open its audiobook on your iPhone first' }));
    await driver.command('book:someone-else');
    await driver.command('chapter:someone-else:0');
    expect(engine.playFromCar).not.toHaveBeenCalled();
  });

  it('gives the page the player back when the car goes away', async () => {
    const { driver, engine } = setup();
    await driver.command('disconnected');
    expect(engine.carDisconnected).toHaveBeenCalled();
    expect(engine.playFromCar).not.toHaveBeenCalled();
  });

  it('sends the model only when it changed', async () => {
    const { driver, native, queues } = setup();
    await queues.ready;
    driver.refresh();
    driver.refresh();
    driver.setNowPlaying({ bookId: 'book01', track: 0, playing: true });
    driver.setNowPlaying({ bookId: 'book01', track: 0, playing: true });
    expect(native.setCarPlayModel).toHaveBeenCalledTimes(2);
  });
});
