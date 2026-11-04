import { useSyncExternalStore } from 'react';
import type { AudioControls, BookAudioControls } from '@bookclub/shared';
import { ApiError, api } from '../lib/api';
import { useAudioControlsDefault, useProgress, useSession } from '../lib/queries';

/**
 * The audiobook's controls in the book (D197), on this device. A book with an audiobook you do
 * not listen to need not show it: you can hide its controls for every book (your default, in
 * Settings) and show or hide them for one book over that (its reading settings). The server keeps
 * both per person, so the choice made in the iOS app holds in the browser too; this keeps a copy
 * here, so the reader opens right with no connection, and a choice made offline is sent once the
 * connection is back. Newest wins (the `at` of each, on the chooser's clock), as with speed (D195).
 *
 * Kept per person in local storage under `bookclub:` (wiped at sign-out with the rest).
 */

const KEY = 'bookclub:audio-controls';

interface Remembered<T> {
  readonly hidden: T;
  readonly at: number;
  /** Chosen here and not yet on the server. */
  readonly unsent?: true;
}

interface PersonChoices {
  default?: Remembered<boolean>;
  books: Record<string, Remembered<boolean | null>>;
}

type Store = Record<string, PersonChoices>;

const isChoice = (r: unknown, nullable: boolean): r is Remembered<boolean | null> =>
  !!r && typeof r === 'object' && (typeof (r as Remembered<unknown>).hidden === 'boolean' || (nullable && (r as Remembered<unknown>).hidden === null)) && Number.isFinite((r as Remembered<unknown>).at);

const listeners = new Set<() => void>();
let snapshot: string | null = null;

function raw(): string {
  try {
    return localStorage.getItem(KEY) ?? '{}';
  } catch {
    return '{}';
  }
}

function read(): Store {
  try {
    const parsed: unknown = JSON.parse(raw());
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
  snapshot = null;
  for (const listener of listeners) listener();
}

function person(store: Store, userId: string): PersonChoices {
  const p = store[userId];
  if (!p || typeof p !== 'object' || !p.books || typeof p.books !== 'object') return (store[userId] = { books: {} });
  return p;
}

function update(userId: string, change: (p: PersonChoices) => void): void {
  const store = read();
  change(person(store, userId));
  write(store);
}

/** The newer of two choices (this device's, the server's); the device's on a tie, it may be unsent. */
function newer<T>(a: Remembered<T> | null | undefined, b: Remembered<T> | null | undefined): Remembered<T> | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

/** What the server says: your default (it answers shown at 0 when you never chose) and this book's own choice. */
export interface ServerAudioControls {
  readonly default?: AudioControls | null;
  readonly book?: BookAudioControls | null;
}

/**
 * Whether the audiobook's controls are hidden in this book: the book's own choice if it has one
 * (the newest of this device's and the server's), else your default, else shown.
 */
export function audioControlsHidden(userId: string | undefined, bookId: string, server: ServerAudioControls = {}): boolean {
  return audioControlsChoice(userId, bookId, server).hidden;
}

/** The choice in effect, and what it comes from: this book's own (true or false), or your default. */
export function audioControlsChoice(userId: string | undefined, bookId: string, server: ServerAudioControls = {}): { hidden: boolean; book: boolean | null; byDefault: boolean } {
  const p = userId ? read()[userId] : undefined;
  const localBook = p?.books?.[bookId];
  const localDefault = p?.default;
  const book = newer<boolean | null>(isChoice(localBook, true) ? localBook : null, server.book ?? null);
  const serverDefault = server.default && server.default.at > 0 ? server.default : null;
  const byDefault = newer<boolean>(isChoice(localDefault, false) ? (localDefault) : null, serverDefault)?.hidden ?? false;
  const own = book?.hidden ?? null;
  return { hidden: own ?? byDefault, book: own, byDefault };
}

/** A refusal that sending again would not change (the book is gone, the body not ours). */
const definitive = (err: unknown): boolean => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;

/** You hid (or showed) the controls for every book: kept here at once, and sent (again later if offline). */
export async function chooseAudioControlsDefault(userId: string | undefined, hidden: boolean, at = Date.now()): Promise<AudioControls | null> {
  if (!userId) return null;
  const chosen: Remembered<boolean> = { hidden, at, unsent: true };
  update(userId, (p) => void (p.default = chosen));
  return sendDefault(userId, chosen);
}

/** This book's own choice (null: as your default): kept here at once, and sent (again later if offline). */
export async function chooseBookAudioControls(userId: string | undefined, bookId: string, hidden: boolean | null, at = Date.now()): Promise<void> {
  if (!userId) return;
  const chosen: Remembered<boolean | null> = { hidden, at, unsent: true };
  update(userId, (p) => void (p.books[bookId] = chosen));
  await sendBook(userId, bookId, chosen);
}

async function sendDefault(userId: string, chosen: Remembered<boolean>): Promise<AudioControls | null> {
  try {
    const saved = await api.setAudioControls({ hidden: chosen.hidden, at: chosen.at });
    // The server's answer may be newer still (chosen on another device meanwhile): keep that.
    update(userId, (p) => {
      if (p.default?.at === chosen.at) p.default = { hidden: saved.hidden, at: saved.at };
    });
    return saved;
  } catch (err) {
    if (definitive(err)) update(userId, (p) => {
      if (p.default?.at === chosen.at) p.default = { hidden: chosen.hidden, at: chosen.at };
    });
    return null;
  }
}

async function sendBook(userId: string, bookId: string, chosen: Remembered<boolean | null>): Promise<void> {
  try {
    const saved = await api.setBookAudioControls(bookId, { hidden: chosen.hidden, at: chosen.at });
    update(userId, (p) => {
      if (p.books[bookId]?.at === chosen.at) p.books[bookId] = { hidden: saved.hidden, at: saved.at };
    });
  } catch (err) {
    if (definitive(err)) update(userId, (p) => {
      if (p.books[bookId]?.at === chosen.at) p.books[bookId] = { hidden: chosen.hidden, at: chosen.at };
    });
  }
}

/** Send whatever was chosen here offline (with the reading outbox: on reconnect, every 15 s). */
export async function sendUnsentAudioControls(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const p = read()[userId];
  if (!p) return;
  const sends: Promise<unknown>[] = [];
  if (isChoice(p.default, false) && p.default.unsent) sends.push(sendDefault(userId, p.default));
  for (const [bookId, r] of Object.entries(p.books ?? {})) if (isChoice(r, true) && r.unsent) sends.push(sendBook(userId, bookId, r));
  await Promise.all(sends);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stored choices as one string: what changes when any choice here does (a new choice re-renders). */
function storeSnapshot(): string {
  return (snapshot ??= raw());
}

/**
 * The audiobook's controls for one book, live (D197): whether they are hidden, and the ways to
 * choose. A choice made here shows at once; the server's copy (your default, the book's own, with
 * its progress) comes in as it arrives.
 */
export function useAudioControls(bookId: string) {
  const session = useSession();
  const userId = session.data?.user?.id;
  const progress = useProgress(bookId);
  const defaults = useAudioControlsDefault(!!userId);
  useSyncExternalStore(subscribe, storeSnapshot, storeSnapshot);
  const choice = audioControlsChoice(userId, bookId, { default: defaults.data, book: progress.data?.audioControls });
  return {
    ...choice,
    setBook: (hidden: boolean | null) => void chooseBookAudioControls(userId, bookId, hidden),
    setDefault: (hidden: boolean) => void chooseAudioControlsDefault(userId, hidden),
  };
}

/** Your default, live (Settings): whether you hide the audiobook's controls in every book. */
export function useAudioControlsDefaultChoice() {
  const session = useSession();
  const userId = session.data?.user?.id;
  const defaults = useAudioControlsDefault(!!userId);
  useSyncExternalStore(subscribe, storeSnapshot, storeSnapshot);
  const p = userId ? read()[userId] : undefined;
  const local = isChoice(p?.default, false) ? (p.default) : null;
  const server = defaults.data && defaults.data.at > 0 ? defaults.data : null;
  return { hidden: newer(local, server)?.hidden ?? false, set: (hidden: boolean) => chooseAudioControlsDefault(userId, hidden) };
}

export const AUDIO_CONTROLS_STORAGE_KEY = KEY;
