import type { Import } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FileJob,
  type PendingImport,
  type UploadStatus,
  clearPending,
  finishImport,
  forgetFingerprints,
  loadPending,
  matchesPending,
  resumableImport,
  savePending,
  startImport,
  uploadAll,
} from './uploader';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, code: string, message = 'No.') => json({ error: { code, message } }, status);
const dropped = () => Promise.reject(new TypeError('Failed to fetch'));

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** Replace `fetch` with answers given in turn (the last one repeats); record every request. */
function server(...answers: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body });
    return answers[Math.min(calls.length, answers.length) - 1]!();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const pending = (over: Partial<PendingImport> = {}): PendingImport => ({
  importId: 'imp_abc123',
  clubId: 'club_123',
  kind: 'audio',
  files: [
    { name: '01 - The Beginning.mp3', size: 40_653, role: 'track' },
    { name: '02 - The Middle.mp3', size: 32_642, role: 'track' },
    { name: 'cover.jpg', size: 5_477, role: 'cover' },
  ],
  startedAt: 1_700_000_000_000,
  ...over,
});

const imported = (status: Import['status'], over: Partial<Import> = {}): Import => ({
  id: 'imp_abc123',
  clubId: 'club_123',
  kind: 'audio',
  status,
  files: [
    { index: 0, name: '01 - The Beginning.mp3', size: 40_653, role: 'track', uploadId: 'up_1', offset: 40_653, complete: true },
    { index: 1, name: '02 - The Middle.mp3', size: 32_642, role: 'track', uploadId: 'up_2', offset: 1_000, complete: false },
    { index: 2, name: 'cover.jpg', size: 5_477, role: 'cover', uploadId: null, offset: 0, complete: false },
  ],
  createdAt: '2026-10-23T12:00:00.000Z',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* The unfinished upload on this device --------------------------------------------------------- */

describe('savePending, loadPending and clearPending', () => {
  it('keep an unfinished upload per club across reloads', () => {
    savePending(pending());
    savePending(pending({ clubId: 'club_456', importId: 'imp_other1' }));
    expect(loadPending('club_123')).toEqual(pending());
    expect(loadPending('club_456')?.importId).toBe('imp_other1');
    expect(loadPending('club_789')).toBeNull();
  });

  it('forget one club’s upload without touching another’s', () => {
    savePending(pending());
    savePending(pending({ clubId: 'club_456' }));
    clearPending('club_123');
    expect(loadPending('club_123')).toBeNull();
    expect(loadPending('club_456')).not.toBeNull();
  });

  it('treat a damaged record as no record', () => {
    localStorage.setItem('bookclub:pending-import:club_123', '{not json');
    expect(loadPending('club_123')).toBeNull();
  });

  it('never fail when storage is full or disabled', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Access denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Access denied', 'SecurityError');
    });
    expect(() => savePending(pending())).not.toThrow();
    expect(loadPending('club_123')).toBeNull();
    expect(() => clearPending('club_123')).not.toThrow();
    expect(() => forgetFingerprints('imp_abc123')).not.toThrow();
  });
});

describe('matchesPending', () => {
  const shape = pending().files;

  it('matches the same files, by name, size and role, in the same order', () => {
    expect(matchesPending(pending(), shape.map((f) => ({ ...f })))).toBe(true);
  });

  it.each([
    ['a file fewer', shape.slice(0, 2)],
    ['a file more', [...shape, { name: 'extra.mp3', size: 1, role: 'track' as const }]],
    ['another size (a different file of the same name)', [{ ...shape[0]!, size: 40_654 }, shape[1]!, shape[2]!]],
    ['another name', [{ ...shape[0]!, name: '01 - Beginning.mp3' }, shape[1]!, shape[2]!]],
    ['another role', [shape[0]!, shape[1]!, { ...shape[2]!, role: 'track' as const }]],
    ['another order', [shape[1]!, shape[0]!, shape[2]!]],
  ])('does not match %s', (_what, jobs) => {
    expect(matchesPending(pending(), jobs)).toBe(false);
  });
});

describe('forgetFingerprints', () => {
  it('removes only the tus resume points of that import', () => {
    const keep = [
      'tus::bookclub-imp_abc1234-0-40653::0123',
      'tus::bookclub-imp_other1-0-40653::4567',
      'tus::someone-else-0::89ab',
      'bookclub:pending-import:club_123',
      'bookclub:reader-settings',
    ];
    const gone = ['tus::bookclub-imp_abc123-0-40653::0a1b', 'tus::bookclub-imp_abc123-1-32642::2c3d', 'tus::bookclub-imp_abc123-2-5477::4e5f'];
    for (const key of [...keep, ...gone]) localStorage.setItem(key, '{}');
    forgetFingerprints('imp_abc123');
    expect(Object.keys(localStorage).sort()).toEqual([...keep].sort());
  });
});

/* Resuming --------------------------------------------------------------------------------------- */

describe('resumableImport', () => {
  const shape = pending().files;

  it('is null, without asking the server, when nothing is unfinished', async () => {
    const { fetchMock } = server(() => json(imported('uploading')));
    await expect(resumableImport('club_123', shape)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is null, without asking the server, when other files were chosen', async () => {
    savePending(pending());
    const { fetchMock } = server(() => json(imported('uploading')));
    await expect(resumableImport('club_123', shape.slice(1))).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadPending('club_123')).not.toBeNull();
  });

  it('continues the unfinished upload as the server knows it (which files it already has)', async () => {
    savePending(pending());
    const { calls } = server(() => json(imported('uploading')));
    await expect(resumableImport('club_123', shape)).resolves.toEqual(imported('uploading'));
    expect(calls).toEqual([{ url: '/api/imports/imp_abc123', method: 'GET', body: undefined }]);
    expect(loadPending('club_123')).not.toBeNull();
  });

  it('returns an upload the server already finished, so finishing it again leads to the book', async () => {
    savePending(pending());
    server(() => json(imported('finalized')));
    await expect(resumableImport('club_123', shape)).resolves.toMatchObject({ status: 'finalized' });
  });

  it.each([
    ['the server no longer has it (404)', () => apiError(404, 'not_found')],
    ['it was cancelled', () => json(imported('cancelled'))],
  ])('starts afresh, forgetting the old upload and its resume points, when %s', async (_why, answer) => {
    savePending(pending());
    localStorage.setItem('tus::bookclub-imp_abc123-0-40653::0a1b', '{}');
    localStorage.setItem('tus::bookclub-imp_other1-0-40653::0a1b', '{}');
    server(answer);
    await expect(resumableImport('club_123', shape)).resolves.toBeNull();
    expect(loadPending('club_123')).toBeNull();
    expect(Object.keys(localStorage)).toEqual(['tus::bookclub-imp_other1-0-40653::0a1b']);
  });

  it.each([
    ['offline', dropped],
    ['a server error', () => apiError(500, 'internal')],
    ['a refusal other than 404', () => apiError(403, 'forbidden')],
  ])('keeps the unfinished upload and reports the problem when %s', async (_why, answer) => {
    savePending(pending());
    server(answer);
    await expect(resumableImport('club_123', shape)).rejects.toThrow();
    expect(loadPending('club_123')).toEqual(pending());
  });
});

/* Finishing -------------------------------------------------------------------------------------- */

describe('finishImport', () => {
  const body = { title: 'The Synthetic Tale', author: 'Ada Tone', trackOrder: [0, 1], trackTitles: ['The Beginning', 'The Middle'] };
  const done = { bookId: 'book_new123', editionId: 'ed_new1234' };
  const busy = () => apiError(409, 'finishing', 'Still finishing.');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('finishes the import with the title, author and track order', async () => {
    const { calls } = server(() => json(done));
    await expect(finishImport('imp_abc123', body, new AbortController().signal)).resolves.toEqual(done);
    expect(calls).toEqual([{ url: '/api/imports/imp_abc123/finalize', method: 'POST', body }]);
  });

  it.each([
    ['a dropped connection', dropped],
    ['an earlier request that is still finishing (409 finishing)', busy],
    ['a server error', () => apiError(502, 'bad_gateway')],
  ])('rides out %s, sending the same request again', async (_what, failure) => {
    const { calls } = server(failure, failure, () => json(done));
    const finishing = finishImport('imp_abc123', body, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    await expect(finishing).resolves.toEqual(done);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.body).toEqual(body);
  });

  it('waits 1, 2, 4 and then 8 seconds between attempts', async () => {
    const { fetchMock } = server(dropped);
    const finishing = finishImport('imp_abc123', body, new AbortController().signal);
    const outcome = expect(finishing).rejects.toMatchObject({ status: 0 });
    const expected = [1, 2, 3, 4, 5, 6];
    const times = [0, 1_000, 3_000, 7_000, 15_000, 23_000];
    for (let i = 0; i < times.length; i++) {
      await vi.advanceTimersByTimeAsync(times[i]! - (times[i - 1] ?? 0));
      expect(fetchMock).toHaveBeenCalledTimes(expected[i]!);
    }
    await vi.advanceTimersByTimeAsync(7_999);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await outcome;
  });

  it('gives up with the last error after 31 attempts', async () => {
    const { fetchMock } = server(dropped);
    const finishing = finishImport('imp_abc123', body, new AbortController().signal);
    const outcome = expect(finishing).rejects.toMatchObject({ status: 0, code: 'offline' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(31);
  });

  it.each([
    ['a refusal', 400, 'validation'],
    ['a missing import', 404, 'not_found'],
    ['a conflict other than finishing', 409, 'incomplete'],
    ['a signed-out user', 401, 'unauthorized'],
  ])('stops at once on %s (%i %s)', async (_what, status, code) => {
    const { fetchMock } = server(() => apiError(status, code), () => json(done));
    const finishing = finishImport('imp_abc123', body, new AbortController().signal);
    const outcome = expect(finishing).rejects.toMatchObject({ status, code });
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing at all once the upload was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchMock } = server(dropped, () => json(done));
    const finishing = finishImport('imp_abc123', body, controller.signal);
    const outcome = expect(finishing).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // BUG (upload/uploader.ts, finishImport): the signal is only checked after an attempt fails, never
  // after the pause before the next one. Cancelling while it waits (UploadModal's cancel() aborts,
  // asks the server to cancel the import and closes the dialog) still sends one more finalize when
  // the pause ends; if that succeeds (say the cancel request failed offline and the network came
  // back), the book is created and start() goes on to toast "added" and navigate to it, although
  // the person stopped the upload. Checking `signal.aborted` after the pause would stop it.
  it('sends nothing more when the upload is cancelled while it waits to try again', async () => {
    const controller = new AbortController();
    const { fetchMock } = server(dropped, () => json(done));
    const finishing = finishImport('imp_abc123', body, controller.signal);
    const settled = finishing.then(
      () => 'finished',
      () => 'stopped',
    );
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settled).toBe('stopped');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* Starting and uploading ------------------------------------------------------------------------ */

describe('startImport', () => {
  it('tells the server which files are coming, with a type for files the browser could not type', async () => {
    const { calls } = server(() => json(imported('uploading'), 201));
    const jobs: FileJob[] = [
      { index: 0, file: new File([new Uint8Array(10)], '01 - The Beginning.mp3', { type: 'audio/mpeg' }), name: '01 - The Beginning.mp3', role: 'track' },
      { index: 1, file: new Blob([new Uint8Array(4)]), name: 'cover.jpg', role: 'cover' },
    ];
    await expect(startImport('club_123', 'audio', jobs)).resolves.toEqual(imported('uploading'));
    expect(calls).toEqual([
      {
        url: '/api/clubs/club_123/imports',
        method: 'POST',
        body: {
          kind: 'audio',
          files: [
            { name: '01 - The Beginning.mp3', size: 10, type: 'audio/mpeg', role: 'track' },
            { name: 'cover.jpg', size: 4, type: 'application/octet-stream', role: 'cover' },
          ],
        },
      },
    ]);
  });
});

describe('uploadAll', () => {
  const jobs: FileJob[] = [
    { index: 0, file: new Blob([new Uint8Array(300)]), name: 'a.mp3', role: 'track' },
    { index: 1, file: new Blob([new Uint8Array(200)]), name: 'b.mp3', role: 'track' },
  ];

  it('sends nothing for files the server already has, and reports them as sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const statuses: UploadStatus[] = [];
    await uploadAll('imp_abc123', jobs, (s) => statuses.push(s), new AbortController().signal, new Set([0, 1]));
    expect(statuses).toEqual([{ sent: 500, total: 500, waiting: false, perFile: [300, 200] }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports nothing sent yet for the files still to go', async () => {
    const statuses: UploadStatus[] = [];
    const controller = new AbortController();
    controller.abort();
    await uploadAll('imp_abc123', jobs, (s) => statuses.push(s), controller.signal, new Set([1])).catch(() => undefined);
    expect(statuses[0]).toEqual({ sent: 200, total: 500, waiting: false, perFile: [0, 200] });
  });

  // BUG (upload/uploader.ts, uploadAll): cancelled midway, every file's promise rejects with an
  // AbortError (one(): cancel, read, not run: it needs a tus server), which is how UploadModal's
  // start() knows to stop. Cancelled before it starts (the signal already aborted, e.g. during
  // the createImport request), the workers never run and it resolves as if every file were sent,
  // so start() goes on to finishImport for an upload the person cancelled. It should reject with
  // the same AbortError.
  it('rejects as cancelled when cancelled before it starts, as it does when cancelled midway', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadAll('imp_abc123', jobs, () => undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('has nothing to do for an empty list', async () => {
    const statuses: UploadStatus[] = [];
    await uploadAll('imp_abc123', [], (s) => statuses.push(s), new AbortController().signal);
    expect(statuses).toEqual([{ sent: 0, total: 0, waiting: false, perFile: [] }]);
  });
});
