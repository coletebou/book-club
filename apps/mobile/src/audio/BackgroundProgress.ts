/**
 * The place saved while iOS has the page asleep (D182). With the phone locked a WebView's scripts
 * stop while native audio plays on, so the page's five-second saves (AudioProvider's `report`) stop
 * too: if iOS or the person then ends the app, everything heard since the phone was locked would
 * be lost (INTENT: "a lost position" must never happen). While the app is in the background this
 * saves what native heard, as the page would: `PUT /api/books/:id/progress` with the place and the
 * stretches heard since the last save, in the page's own shapes (`ProgressUpdateBody`), so the
 * server unions the stretches and keeps the newest place, and the page's own save when it wakes
 * (newer, from the same element) simply follows.
 *
 * Pure apart from its injected `fetch` and clock, so its rules are unit-tested.
 */

export interface AudioPlace {
  readonly kind: 'audio';
  readonly track: number;
  readonly ms: number;
}

export interface Heard {
  readonly from: AudioPlace;
  readonly to: AudioPlace;
}

export interface ProgressTarget {
  readonly bookId: string;
  readonly editionId: string;
  /** Whose listening it is (the page's queue says, D196): the place kept on the device is theirs. */
  readonly userId?: string | null;
}

/**
 * The place kept on the device (D196): the newest native heard, when, whose, and the stretches heard
 * that no save has yet got to the server. Written every few seconds and at once at a pause, a
 * track's end and the app going to the background, so that the app ended by iOS or by a swipe (no
 * code runs then), or a save that could not reach the server, loses nothing: the page, opened again,
 * asks for it and saves it as its own (newest wins).
 */
export interface KeptPlace {
  readonly bookId: string;
  readonly editionId: string;
  readonly userId: string | null;
  readonly locator: AudioPlace;
  readonly at: number;
  readonly spans: readonly Heard[];
}

export interface BackgroundProgressDeps {
  readonly serverUrl: string;
  readonly fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; credentials: 'include' }) => Promise<{ ok: boolean; status: number }>;
  readonly now: () => number;
  /** Whether the app is in the background (the page asleep): only then does this save. */
  readonly inBackground: () => boolean;
  /** Where the place is kept on the device (D196); none in a test that does not need it. */
  readonly keep?: (json: string) => Promise<void> | void;
}

/** How often, at most, the place is kept on the device while it plays (D196). */
export const KEEP_MS = 2_000;

/** How often the place is saved while playing in the background (the page saves every five seconds awake). */
export const BACKGROUND_SAVE_MS = 30_000;

/** A difference from the expected place larger than this is a jump (a skip, a scrub), not listening. */
export const JUMP_TOLERANCE_MS = 3_000;

/** The most stretches one save may carry (the server's `LIMITS.readSpansPerUpdate` is far above it). */
const MAX_SPANS = 50;

interface Sample {
  readonly place: AudioPlace;
  readonly at: number;
  readonly rate: number;
}

export class BackgroundProgress {
  private target: ProgressTarget | null = null;
  private from: AudioPlace | null = null;
  private last: Sample | null = null;
  private spans: Heard[] = [];
  private savedAt = 0;
  private saving: Promise<void> | null = null;
  /** A save asked for while one was on its way: made as soon as that one is done. */
  private again = false;
  private keptAt = 0;
  /**
   * The newest place heard (D196): while playing, or where a stretch of playing ended. What is
   * kept for the page; never a place merely loaded or sought to while paused (the page's own,
   * which it has saved), which reported back as new would outrank the place it was opened from.
   */
  private heard: { readonly place: AudioPlace; readonly at: number } | null = null;
  /** What an earlier run of the app kept, until this one hears a place of its own. */
  private restored: KeptPlace | null = null;

  constructor(private readonly deps: BackgroundProgressDeps) {}

  /** The book and edition loaded (from the page's queue, D181), or none. Changing it saves first. */
  setTarget(target: ProgressTarget | null): void {
    if (this.target && (target?.editionId !== this.target.editionId || target.bookId !== this.target.bookId)) {
      this.close();
      void this.save();
      this.from = null;
      this.last = null;
      // Heard in another book: never saved or kept as this one's (a save in the background has
      // taken them above; in the foreground the page saved its own).
      this.spans = [];
      this.heard = null;
    }
    this.target = target;
  }

  /**
   * What native's player says now: the track, the place in it, whether it plays and how fast. A
   * place that is not where listening would have taken it (a skip, a scrub, another track by a
   * button) ends the stretch heard at the last place and starts another there, so a skip never
   * counts as heard.
   */
  observe(place: AudioPlace, playing: boolean, rate: number): void {
    const now = this.deps.now();
    const last = this.last;
    if (last && this.from) {
      const expected = last.place.ms + (now - last.at) * last.rate;
      const jumped = place.track !== last.place.track || Math.abs(place.ms - expected) > JUMP_TOLERANCE_MS;
      if (jumped) {
        this.close();
        this.from = playing ? place : null;
      }
    }
    if (playing && !this.from) this.from = place;
    if (!playing && this.from) {
      this.last = { place, at: now, rate };
      this.close();
      this.from = null;
      this.hear(place, now, true);
      void this.save();
      return;
    }
    this.last = { place, at: now, rate };
    if (playing) this.hear(place, now, false);
    if (playing && this.deps.inBackground() && now - this.savedAt >= BACKGROUND_SAVE_MS) void this.save();
  }

  /** A place heard: the newest kept, over whatever an earlier run kept; kept at once or every KEEP_MS. */
  private hear(place: AudioPlace, at: number, force: boolean): void {
    this.heard = { place, at };
    this.restored = null;
    this.keepNow(force);
  }

  /** A track played to its end and native went on to the next (D181): the stretch ends at its end. */
  finished(place: AudioPlace): void {
    const now = this.deps.now();
    this.last = { place, at: now, rate: this.last?.rate ?? 1 };
    this.close();
    this.from = null;
    this.hear(place, now, true);
    void this.save();
  }

  /** The app went to the background: start the clock from now, so the first save waits its turn. */
  backgrounded(): void {
    this.savedAt = this.deps.now();
    this.keepNow(true);
  }

  /** What an earlier run of the app kept on the device (`keep`'s JSON), read as the app starts. */
  restore(json: string | null): void {
    if (!json || this.heard) return;
    try {
      const kept = JSON.parse(json) as KeptPlace;
      if (isKept(kept)) this.restored = kept;
    } catch {
      // A file half-written as the app ended: nothing kept.
    }
  }

  /** The place kept now (D196): the newest heard this run, else what an earlier run kept; none before either. */
  kept(): KeptPlace | null {
    const target = this.target;
    const heard = this.heard;
    const last = this.last;
    if (!target || !heard) return this.restored;
    const open = this.from && last && (this.from.track < last.place.track || (this.from.track === last.place.track && this.from.ms < last.place.ms)) ? [{ from: this.from, to: last.place }] : [];
    return { bookId: target.bookId, editionId: target.editionId, userId: target.userId ?? null, locator: heard.place, at: heard.at, spans: [...this.spans, ...open] };
  }

  /** Keep the place on the device: at once (a pause, a jump, a track's end, the background), else every KEEP_MS. */
  private keepNow(force: boolean): void {
    const write = this.deps.keep;
    if (!write) return;
    const now = this.deps.now();
    if (!force && now - this.keptAt < KEEP_MS) return;
    const kept = this.kept();
    if (!kept) return;
    this.keptAt = now;
    try {
      void Promise.resolve(write(JSON.stringify(kept))).catch(() => undefined);
    } catch {
      // A full disk: the server's copy still goes on its way.
    }
  }

  /** The stretch heard from `from` to the last place seen, if any. */
  private close(): void {
    const from = this.from;
    const to = this.last?.place;
    if (!from || !to) return;
    if (from.track < to.track || (from.track === to.track && from.ms < to.ms)) this.spans.push({ from, to });
    if (this.spans.length > MAX_SPANS) this.spans = this.spans.slice(-MAX_SPANS);
    this.from = to;
  }

  /** Send the place and what was heard since the last save, in the background only. */
  save(): Promise<void> {
    if (!this.deps.inBackground() || !this.target || !this.last) return Promise.resolve();
    if (this.saving) {
      this.again = true; // Never dropped: a pause's place must reach the server too.
      return this.saving;
    }
    if (this.from) this.close();
    const target = this.target;
    const spans = this.spans;
    this.spans = [];
    this.savedAt = this.deps.now();
    const body = { editionId: target.editionId, locator: this.last.place, readSpans: spans, at: this.deps.now() };
    const url = `${this.deps.serverUrl.replace(/\/$/, '')}/api/books/${encodeURIComponent(target.bookId)}/progress`;
    this.saving = this.deps
      .fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' })
      .then((res) => {
        // Refused for good (signed out, the book gone): nothing to keep. Otherwise keep the stretches for the next try.
        if (!res.ok && res.status >= 500) this.spans = [...spans, ...this.spans];
      })
      .catch(() => {
        this.spans = [...spans, ...this.spans]; // offline: tried again at the next save
      })
      .finally(() => {
        this.saving = null;
        // What reached the server is no longer kept as unsent.
        this.keepNow(true);
        if (this.again) {
          this.again = false;
          void this.save();
        }
      });
    return this.saving;
  }
}

function isPlace(value: unknown): value is AudioPlace {
  const p = value as Partial<AudioPlace> | null;
  return !!p && p.kind === 'audio' && Number.isInteger(p.track) && p.track! >= 0 && typeof p.ms === 'number' && Number.isFinite(p.ms) && p.ms >= 0;
}

function isKept(value: unknown): value is KeptPlace {
  const k = value as Partial<KeptPlace> | null;
  return (
    !!k &&
    typeof k.bookId === 'string' &&
    typeof k.editionId === 'string' &&
    (k.userId === null || typeof k.userId === 'string') &&
    isPlace(k.locator) &&
    typeof k.at === 'number' &&
    Number.isFinite(k.at) &&
    Array.isArray(k.spans) &&
    k.spans.every((h) => !!h && isPlace((h as Heard).from) && isPlace((h as Heard).to))
  );
}
