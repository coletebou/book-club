import { type AudioMetadata } from 'expo-audio';
import { WidgetSnapshotSchema, type WidgetSnapshot } from '@bookclub/shared';
import { type AudioPlace, type KeptPlace } from '../audio/BackgroundProgress';
import { type Queue } from '../audio/NativeAudioEngine';
import { type KeptQueues } from './keptQueues';
import { type CarAction, type CarCommand, type CarControls, type CarNav, type CarNowPlaying, type CarPlayModel, type CarVoice, type KeptQueue, NOT_READY, carPlayModel, parseCarCommand } from './model';

/**
 * CarPlay's side of the app (D221), in JavaScript: what the car lists (`model.ts`), and what a tap
 * plays. The native side (`CarPlayController.swift`) draws the model it is given and sends back the
 * id of each row tapped; the one player is still NativeAudioEngine, so the lock screen, the Live
 * Activity, the place saved while no page is open (D182, D196) and the streaming tickets (D219) are
 * the same in the car as on the phone.
 */

/** Your own place in a book as the server has it (`GET /api/books/:id/progress`'s `mine`). */
export interface ServerPlace {
  readonly editionId: string | null;
  readonly locator: { readonly kind: string; readonly track?: number; readonly ms?: number } | null;
  readonly at: number;
}

/**
 * Where a book starts in the car: the newest of the place kept on this device and the server's, in
 * this audiobook (its edition) only. A book never started (`server` null) starts at its beginning;
 * a place in another format or edition, or none known while offline (`server` undefined), is not
 * guessed at: the car shows the book's chapters instead.
 */
export function startingPlace(queue: KeptQueue, kept: KeptPlace | null, server: ServerPlace | null | undefined): AudioPlace | 'unknown' {
  const candidates: { place: AudioPlace; at: number }[] = [];
  // The place kept on the device only when it is this person's (the page's own rule, D196).
  if (keptIsTheirs(kept, queue)) candidates.push({ place: kept.locator, at: kept.at });
  const loc = server?.locator;
  if (server && server.editionId === queue.editionId && loc?.kind === 'audio' && typeof loc.track === 'number' && typeof loc.ms === 'number') {
    candidates.push({ place: { kind: 'audio', track: loc.track, ms: loc.ms }, at: server.at });
  }
  const newest = candidates.filter((c) => c.place.track >= 0 && c.place.track < queue.tracks.length).sort((a, b) => b.at - a.at)[0];
  if (newest) return newest.place;
  if (server === null) return { kind: 'audio', track: 0, ms: 0 };
  return 'unknown';
}

/** The place kept on the device is in this audiobook and is the same person's as the queue. */
function keptIsTheirs(kept: KeptPlace | null, queue: KeptQueue): kept is KeptPlace {
  return !!kept && kept.bookId === queue.bookId && kept.editionId === queue.editionId && kept.userId !== null && kept.userId === queue.userId;
}

export interface CarPlayNative {
  setCarPlayModel(json: string): void;
  widgetSnapshot(): string | null;
}

export interface CarPlayEngine {
  playFromCar(queue: Queue, metadata: AudioMetadata, track: number, ms: number): Promise<boolean>;
  carDisconnected(): void;
  keptPlace(): Promise<KeptPlace | null>;
}

export interface CarPlayDriverDeps {
  readonly native: CarPlayNative;
  readonly engine: CarPlayEngine;
  readonly queues: KeptQueues;
  /** The server's `mine` for a book: null when never started, undefined when it could not be asked. */
  readonly serverPlace: (bookId: string) => Promise<ServerPlace | null | undefined>;
  /** One of Now Playing's buttons, or a sheet's choice, tapped (D232): the id the model gave it. */
  readonly onControl?: (id: string, car: CarPlayDriver) => void | Promise<void>;
  /** The voice screen (D232): shown, ended by its bar button, gone by the car's own doing, or not on this iOS. */
  readonly onVoice?: (event: 'shown' | 'cancel' | 'closed' | 'unavailable', car: CarPlayDriver) => void;
  /** A sheet was asked for where there is none (D232, before iOS 17): nothing was shown. */
  readonly onSheet?: (event: 'unavailable', car: CarPlayDriver) => void;
}

/**
 * Now Playing as a build shows it until told otherwise (D232): no buttons of the app's own, and
 * CarPlay's Up Next button opening the book's chapters.
 */
export const DEFAULT_CAR_CONTROLS: CarControls = { buttons: [], upNext: 'Chapters' };

/** A step of the car's navigation without its `seq`, which the driver numbers. */
type Step = CarNav extends infer N ? (N extends CarNav ? Omit<N, 'seq'> : never) : never;

export class CarPlayDriver {
  private nowPlaying: CarNowPlaying | null = null;
  private chaptersOf: string | null = null;
  private nav: CarPlayModel['nav'] = null;
  private controls: CarControls | null = DEFAULT_CAR_CONTROLS;
  private seq = 0;
  private sent = '';
  /** The newest tap wins: one answered after a later one has nothing more to do. */
  private tap = 0;

  constructor(private readonly deps: CarPlayDriverDeps) {}

  /** The widgets' snapshot, as the App Group has it: the books, and whose they are. */
  private snapshot(): WidgetSnapshot | null {
    try {
      const json = this.deps.native.widgetSnapshot();
      const parsed = json ? WidgetSnapshotSchema.safeParse(JSON.parse(json)) : null;
      return parsed?.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  model(): CarPlayModel {
    return carPlayModel({ snapshot: this.snapshot(), queues: this.deps.queues.all(), nowPlaying: this.nowPlaying, chaptersOf: this.chaptersOf, nav: this.nav, controls: this.controls });
  }

  /** Hands native the model, when it changed. Called on every change of anything it shows. */
  refresh(): void {
    const json = JSON.stringify(this.model());
    if (json === this.sent) return;
    this.sent = json;
    this.deps.native.setCarPlayModel(json);
  }

  /** What the engine plays now (its `onNowPlaying`): only which book and track, and whether it plays. */
  setNowPlaying(np: { readonly bookId: string; readonly track: number; readonly playing: boolean } | null): void {
    const next = np ? { bookId: np.bookId, track: np.track, playing: np.playing } : null;
    const same = next === this.nowPlaying || (!!next && !!this.nowPlaying && next.bookId === this.nowPlaying.bookId && next.track === this.nowPlaying.track && next.playing === this.nowPlaying.playing);
    if (same) return;
    if (next && next.bookId !== this.nowPlaying?.bookId) this.chaptersOf = next.bookId;
    this.nowPlaying = next;
    this.refresh();
  }

  private go(to: 'nowPlaying' | 'chapters' | 'message', message?: string): void {
    this.step(to === 'message' ? { to, ...(message ? { message } : {}) } : { to });
  }

  private step(nav: Step): void {
    this.nav = { seq: ++this.seq, ...nav } as CarNav;
    this.refresh();
  }

  /** Now Playing's buttons (D232): at most five are drawn; null for CarPlay's plain Now Playing. */
  setControls(controls: CarControls | null): void {
    this.controls = controls;
    this.refresh();
  }

  /** A short confirmation or error over Now Playing. */
  message(text: string): void {
    this.go('message', text);
  }

  /** An action sheet over the car's screens (D232): each choice's tap comes back to `onControl`. */
  sheet(title: string | null, actions: readonly CarAction[]): void {
    if (actions.length === 0) return;
    this.step({ to: 'sheet', ...(title ? { message: title } : {}), actions });
  }

  /** The voice screen (D232): shown, or moved to another of its states while it is up. */
  voice(voice: CarVoice): void {
    this.step({ to: 'voice', voice });
  }

  /** Takes down the sheet, message or voice screen that is up, if one is. */
  dismiss(): void {
    this.step({ to: 'dismiss' });
  }

  /** A row tapped in the car (its id). */
  async command(id: unknown): Promise<void> {
    // The car went away (CarPlayController.swift's disconnect): the page may have the player back.
    if (id === 'disconnected') {
      // A tap still being answered (its place being asked of the server) must not start playing now.
      this.tap++;
      this.deps.engine.carDisconnected();
      return;
    }
    if (id === 'connected') {
      await this.deps.queues.reload();
      this.refresh();
      return;
    }
    const cmd = parseCarCommand(id);
    if (!cmd) return;
    // Now Playing's buttons and the voice screen (D232) are whoever gave them to the model's to answer.
    if (cmd.kind === 'control') return this.deps.onControl?.(cmd.id, this);
    if (cmd.kind === 'voice') return this.deps.onVoice?.(cmd.event, this);
    if (cmd.kind === 'sheet') return this.deps.onSheet?.(cmd.event, this);
    const tap = ++this.tap;
    await this.deps.queues.ready;
    const model = this.model();
    const bookId = bookOf(cmd, model);
    const queue = bookId ? this.deps.queues.get(bookId) : undefined;
    // Only books the model lists: of the person signed in now (their snapshot), kept on this phone.
    if (!bookId || !queue || !model.books.some((b) => b.coverBookId === bookId && b.playable)) {
      if (tap === this.tap) this.go('message', NOT_READY);
      return;
    }
    if (cmd.kind === 'chapter') {
      if (cmd.track < 0 || cmd.track >= queue.tracks.length) return;
      const kept = await this.deps.engine.keptPlace();
      if (tap !== this.tap) return;
      // The chapter you are in goes on from your place in it; any other starts at its beginning.
      const ms = keptIsTheirs(kept, queue) && kept.locator.track === cmd.track ? kept.locator.ms : 0;
      return this.play(queue, cmd.track, ms, tap);
    }
    const [kept, server] = await Promise.all([this.deps.engine.keptPlace(), this.deps.serverPlace(queue.bookId).catch(() => undefined)]);
    if (tap !== this.tap) return;
    const place = startingPlace(queue, kept, server);
    if (place === 'unknown') {
      this.chaptersOf = queue.bookId;
      this.go('chapters');
      return;
    }
    await this.play(queue, place.track, place.ms, tap);
  }

  private async play(queue: KeptQueue, track: number, ms: number, tap: number): Promise<void> {
    this.chaptersOf = queue.bookId;
    const started = await this.deps.engine.playFromCar(
      // The car's queue always goes on to the next track, independently of a party on the phone.
      { bookId: queue.bookId, editionId: queue.editionId, userId: queue.userId, advance: true, tracks: queue.tracks },
      { title: queue.tracks[track]?.title ?? queue.title, artist: queue.author, albumTitle: queue.title, artworkUrl: queue.artworkUrl ?? undefined },
      track,
      ms,
    ).catch(() => false);
    if (tap !== this.tap) return;
    if (started) this.go('nowPlaying');
    else this.message('Playback could not start');
  }
}

function bookOf(cmd: Exclude<CarCommand, { kind: 'control' | 'voice' | 'sheet' }>, model: CarPlayModel): string | null {
  if (cmd.kind === 'continue') return model.continue?.coverBookId ?? null;
  return cmd.bookId;
}
