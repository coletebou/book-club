import { type BookPlayback, type ChosenRate, type ListeningSettings, isRateStep, newerRate, normalizeRate, resolveRate } from '@bookclub/shared';
import { ApiError, api } from '../lib/api';

/**
 * Listening speed on this device (D195). The server keeps each person's default and the last speed
 * they used for each book, so a speed follows them from the browser to the iOS app; this keeps a
 * copy of both here, so that the player opens at the right speed with no connection too, and a
 * speed chosen offline is sent once the connection is back. Whichever choice is newest wins (the
 * `at` of each, on the chooser's clock), here and on the server alike, as with reading progress.
 *
 * Kept per person (a shared iPad), in local storage under `bookclub:` (wiped at sign-out with the
 * rest, lib/offline.ts).
 */

const KEY = 'bookclub:speeds';
/** Before D195: one speed for every book, on this device only. */
const LEGACY_KEY = 'bookclub:playback-rate';

interface Remembered extends ChosenRate {
  /** Chosen here and not yet on the server. */
  readonly unsent?: true;
}

interface PersonSpeeds {
  default?: Remembered;
  books: Record<string, Remembered>;
}

type Store = Record<string, PersonSpeeds>;

const isRemembered = (r: unknown): r is Remembered =>
  !!r && typeof r === 'object' && isRateStep((r as Remembered).rate) && Number.isFinite((r as Remembered).at);

function read(): Store {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private mode or a full quota: the server still has it.
  }
}

function person(store: Store, userId: string): PersonSpeeds {
  const p = store[userId];
  if (!p || typeof p !== 'object' || !p.books || typeof p.books !== 'object') return (store[userId] = { books: {} });
  return p;
}

function update(userId: string, change: (p: PersonSpeeds) => void): void {
  const store = read();
  change(person(store, userId));
  write(store);
}

/** What this device remembers of a person's speed for a book (null: nothing, or nothing valid). */
export function rememberedBookRate(userId: string, bookId: string): Remembered | null {
  const r = read()[userId]?.books?.[bookId];
  return isRemembered(r) ? r : null;
}

/** What this device remembers of a person's default speed. */
export function rememberedDefault(userId: string): Remembered | null {
  const r = read()[userId]?.default;
  return isRemembered(r) ? r : null;
}

/** The server's default, or null while it has none (it answers 1.0× at 0 then: nobody chose it). */
const serverDefault = (s: ListeningSettings | null | undefined): ChosenRate | null => (s && s.at > 0 ? { rate: s.defaultRate, at: s.at } : null);

/** A person's default speed now: the newest of this device's and the server's, else 1.0×. */
export function currentDefaultRate(userId: string | undefined, server?: ListeningSettings | null): number {
  if (!userId) return resolveRate(null, serverDefault(server)?.rate);
  return resolveRate(null, newerRate(rememberedDefault(userId), serverDefault(server))?.rate);
}

/**
 * The speed a book opens at (D195): the last speed you used for it, else your default, else 1.0×,
 * each the newest of what this device and the server know. What the server knows is kept here
 * too, for opening it offline next time. The device-wide speed from before D195 becomes the first
 * book's own (once): someone half-way through a book at 1.5× is not put back to 1.0× by an update.
 */
export function openingRate(userId: string | undefined, bookId: string, server: { playback?: BookPlayback | null; settings?: ListeningSettings | null }): OpeningRate {
  if (!userId) return { rate: resolveRate(server.playback?.rate, serverDefault(server.settings)?.rate), own: !!server.playback };
  const local = rememberedBookRate(userId, bookId);
  let book = newerRate<ChosenRate>(local, server.playback ?? null);
  const def = newerRate<ChosenRate>(rememberedDefault(userId), serverDefault(server.settings));
  if (book && book !== local && !local?.unsent) update(userId, (p) => void (p.books[bookId] = { rate: book!.rate, at: book!.at }));
  if (!book) {
    const legacy = takeLegacyRate();
    if (legacy !== null && legacy !== resolveRate(null, def?.rate)) {
      book = { rate: legacy, at: Date.now() };
      void chooseBookRate(userId, bookId, legacy, book.at);
    }
  }
  return { rate: resolveRate(book?.rate, def?.rate), own: !!book };
}

/** The speed a book opens at, and whether it is the book's own (else your default, or 1.0×). */
export interface OpeningRate {
  readonly rate: number;
  readonly own: boolean;
}

function takeLegacyRate(): number | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw === null) return null;
    localStorage.removeItem(LEGACY_KEY);
    const rate = Number(raw);
    return Number.isFinite(rate) && rate > 0 ? normalizeRate(rate) : null;
  } catch {
    return null;
  }
}

/** A refusal that sending again would not change (the book is gone, the speed not one of ours). */
const definitive = (err: unknown): boolean => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;

/** You chose this speed for this book: kept here at once, and sent (again later if offline). */
export async function chooseBookRate(userId: string | undefined, bookId: string, rate: number, at = Date.now()): Promise<void> {
  if (!userId) return;
  const chosen: Remembered = { rate: normalizeRate(rate), at, unsent: true };
  update(userId, (p) => void (p.books[bookId] = chosen));
  await sendBook(userId, bookId, chosen);
}

/** You made this speed your default: kept here at once, and sent (again later if offline). */
export async function chooseDefaultRate(userId: string | undefined, rate: number, at = Date.now()): Promise<ListeningSettings | null> {
  if (!userId) return null;
  const chosen: Remembered = { rate: normalizeRate(rate), at, unsent: true };
  update(userId, (p) => void (p.default = chosen));
  return sendDefault(userId, chosen);
}

async function sendBook(userId: string, bookId: string, chosen: Remembered): Promise<void> {
  try {
    const saved = await api.setBookPlayback(bookId, { rate: chosen.rate, at: chosen.at });
    // The server's answer may be newer still (chosen on another device meanwhile): keep that.
    update(userId, (p) => {
      if (p.books[bookId]?.at === chosen.at) p.books[bookId] = { rate: saved.rate, at: saved.at };
    });
  } catch (err) {
    if (definitive(err)) update(userId, (p) => {
      if (p.books[bookId]?.at === chosen.at) p.books[bookId] = { rate: chosen.rate, at: chosen.at };
    });
  }
}

async function sendDefault(userId: string, chosen: Remembered): Promise<ListeningSettings | null> {
  try {
    const saved = await api.setListening({ defaultRate: chosen.rate, at: chosen.at });
    update(userId, (p) => {
      if (p.default?.at === chosen.at) p.default = { rate: saved.defaultRate, at: saved.at };
    });
    return saved;
  } catch (err) {
    if (definitive(err)) update(userId, (p) => {
      if (p.default?.at === chosen.at) p.default = { rate: chosen.rate, at: chosen.at };
    });
    return null;
  }
}

/** Send whatever was chosen here offline (with the reading outbox: on reconnect, every 15 s). */
export async function sendUnsentSpeeds(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const p = read()[userId];
  if (!p) return;
  const sends: Promise<unknown>[] = [];
  if (isRemembered(p.default) && p.default.unsent) sends.push(sendDefault(userId, p.default));
  for (const [bookId, r] of Object.entries(p.books ?? {})) if (isRemembered(r) && r.unsent) sends.push(sendBook(userId, bookId, r));
  await Promise.all(sends);
}

export const SPEED_STORAGE_KEYS = { current: KEY, legacy: LEGACY_KEY } as const;
