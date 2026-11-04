import type { UploadOptions } from 'tus-js-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * An upload paused for the connection goes on as soon as the browser has one again (fidelity review
 * round 16: "Paused at 99%: waiting for the connection" stayed up 37 s after the network came back,
 * the back-off grown to 30 s). tus is replaced by a stand-in that retries as tus does: after each
 * failure onShouldRetry is asked, and the next try waits retryDelays[attempt] (attempt counting the
 * failures since bytes last went through).
 */

const tus = vi.hoisted(() => {
  class FakeUpload {
    static made: FakeUpload[] = [];
    /** The upload URLs tus keeps for resuming, by fingerprint (one is "created" by a first start). */
    static stored = new Map<string, { uploadUrl: string }[]>();
    starts = 0;
    aborts = 0;
    resumedFrom: string | null = null;
    attempt = 0;
    timer: ReturnType<typeof setTimeout> | null = null;
    private fingerprint = '';
    constructor(
      readonly file: Blob,
      readonly options: UploadOptions,
    ) {
      FakeUpload.made.push(this);
    }
    async findPreviousUploads() {
      this.fingerprint = (await this.options.fingerprint!(this.file as File, this.options)) ?? '';
      return FakeUpload.stored.get(this.fingerprint) ?? [];
    }
    resumeFromPreviousUpload(previous: { uploadUrl: string }) {
      this.resumedFrom = previous.uploadUrl;
    }
    start() {
      this.starts++;
      if (!this.resumedFrom && !FakeUpload.stored.has(this.fingerprint)) FakeUpload.stored.set(this.fingerprint, [{ uploadUrl: `/api/uploads/up_${FakeUpload.made.length}` }]);
    }
    abort() {
      this.aborts++;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return Promise.resolve();
    }
    /** A request failed: `status` 0 is a dropped connection. */
    fail(status: number, method = 'PATCH') {
      const err = Object.assign(new Error('tus: failed'), {
        originalRequest: { getMethod: () => method },
        originalResponse: status === 0 ? null : { getStatus: () => status, getBody: () => '' },
      });
      if (this.options.onShouldRetry!(err as never, this.attempt, this.options)) {
        const delay = this.options.retryDelays![this.attempt++]!;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.start();
        }, delay);
      } else this.options.onError!(err);
    }
    progress(sent: number) {
      this.attempt = 0;
      this.options.onProgress!(sent, this.file.size);
    }
    succeed() {
      this.options.onSuccess!({ lastResponse: null as never });
    }
  }
  return { FakeUpload };
});

vi.mock('tus-js-client', () => ({ Upload: tus.FakeUpload }));

const { RETRY_DELAYS, finishImport, uploadAll } = await import('./uploader');
type UploadStatus = Parameters<Parameters<typeof uploadAll>[2]>[0];

const { FakeUpload } = tus;
const job = { index: 0, file: new Blob([new Uint8Array(1000)]), name: '01 - The Beginning.mp3', role: 'track' as const };
const statuses: UploadStatus[] = [];
const last = () => statuses[statuses.length - 1]!;

/** Let the uploader's promises run (finding previous uploads, then starting). */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Each test's uploads, stopped when it ends (one left waiting would hear the next test's network). */
let running = new AbortController();

beforeEach(() => {
  running = new AbortController();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  FakeUpload.made = [];
  FakeUpload.stored = new Map();
  statuses.length = 0;
  localStorage.clear();
});

afterEach(() => {
  running.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** An upload of one file under way, its first request made; `done` settles with it. */
async function underWay(signal = running.signal): Promise<{ done: Promise<void> }> {
  const done = uploadAll('imp_abc123', [job], (s) => statuses.push(s), signal);
  done.catch(() => undefined);
  await settle();
  expect(FakeUpload.made).toHaveLength(1);
  expect(FakeUpload.made[0]!.starts).toBe(1);
  return { done };
}

/** The connection drops, and stays down while tus tries again until its next wait is `delay`. */
async function lostUntil(upload: InstanceType<typeof FakeUpload>, delay: number) {
  upload.fail(0);
  while (RETRY_DELAYS[upload.attempt]! < delay) {
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[upload.attempt - 1]!);
    upload.fail(0);
  }
  await vi.advanceTimersByTimeAsync(RETRY_DELAYS[upload.attempt - 1]!);
  upload.fail(0);
  expect(upload.timer).not.toBeNull();
}

describe('an upload waiting for the connection', () => {
  it('goes on as soon as the browser is online again, from where the server got to, without waiting out its back-off', async () => {
    const { done } = await underWay();
    const first = FakeUpload.made[0]!;
    first.progress(600);
    // Offline long enough for tus to wait 30 s between tries.
    await lostUntil(first, 30_000);
    expect(last()).toMatchObject({ waiting: true, sent: 600 });
    const starts = first.starts;

    window.dispatchEvent(new Event('online'));
    await settle();
    // A fresh upload of the file, resumed from the one the server has (never created anew), now.
    expect(FakeUpload.made).toHaveLength(2);
    const fresh = FakeUpload.made[1]!;
    expect(fresh.starts).toBe(1);
    expect(fresh.resumedFrom).toBe('/api/uploads/up_1');
    expect(fresh.file).toBe(job.file);
    // The old one is stopped, its wait with it.
    expect(first.aborts).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.starts).toBe(starts);

    fresh.progress(1000);
    expect(last()).toMatchObject({ waiting: false, sent: 1000 });
    fresh.succeed();
    await expect(done).resolves.toBeUndefined();
    expect(last()).toMatchObject({ sent: 1000, total: 1000 });
  });

  it('back on screen with a network, goes on the same way; seen again still offline, it waits on', async () => {
    const { done } = await underWay();
    const first = FakeUpload.made[0]!;
    await lostUntil(first, 15_000);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(FakeUpload.made).toHaveLength(1);
    onLine.mockReturnValue(true);
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(FakeUpload.made).toHaveLength(1);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(FakeUpload.made).toHaveLength(2);
    expect(FakeUpload.made[1]!.starts).toBe(1);
    FakeUpload.made[1]!.succeed();
    await expect(done).resolves.toBeUndefined();
  });

  it('is begun again with a short back-off, should the first try after the network is back fail too', async () => {
    await underWay();
    const first = FakeUpload.made[0]!;
    await lostUntil(first, 30_000);
    window.dispatchEvent(new Event('online'));
    await settle();
    const fresh = FakeUpload.made[1]!;
    fresh.fail(0);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]!);
    expect(fresh.starts).toBe(2);
    fresh.fail(0);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]! - 1);
    expect(fresh.starts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fresh.starts).toBe(3);
  });

  it('keeps its back-off when the server failed: the network was never the trouble', async () => {
    await underWay();
    const first = FakeUpload.made[0]!;
    first.fail(503);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]!);
    first.fail(503);
    expect(last()).toMatchObject({ waiting: true });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(FakeUpload.made).toHaveLength(1);
    expect(first.aborts).toBe(0);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]! - 1);
    expect(first.starts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.starts).toBe(3);
  });

  it('does nothing when the network comes back to an upload that is going well, or one that was cancelled', async () => {
    const controller = new AbortController();
    running.signal.addEventListener('abort', () => controller.abort());
    const { done } = await underWay(controller.signal);
    const first = FakeUpload.made[0]!;
    first.progress(100);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(FakeUpload.made).toHaveLength(1);
    first.fail(0);
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(FakeUpload.made).toHaveLength(1);
  });

  it('stops listening for the network once it is over', async () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    const { done } = await underWay();
    FakeUpload.made[0]!.succeed();
    await done;
    expect(removed.mock.calls.map(([type]) => type)).toContain('online');
  });
});

describe('finishing an upload, waiting for the connection', () => {
  const body = { title: 'The Synthetic Tale', author: 'Ada Tone' };
  const finished = { bookId: 'book_new123', editionId: 'ed_new1234' };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  it('asks again as soon as the connection is back', async () => {
    let answer: () => Promise<Response> = () => Promise.reject(new TypeError('Failed to fetch'));
    const fetchMock = vi.fn(() => answer());
    vi.stubGlobal('fetch', fetchMock);
    const finishing = finishImport('imp_abc123', body, new AbortController().signal);
    // 1, 2 and 4 s waits: the next one is 8 s.
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    answer = () => Promise.resolve(json(finished));
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await expect(finishing).resolves.toEqual(finished);
  });

  it('waits out its back-off after a server error', async () => {
    let answer = () => json({ error: { code: 'bad_gateway', message: 'No.' } }, 502);
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    const finishing = finishImport('imp_abc123', body, new AbortController().signal);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer = () => json(finished);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(finishing).resolves.toEqual(finished);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
