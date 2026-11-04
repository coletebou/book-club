import { Upload } from 'tus-js-client';
import type { Import } from '@bookclub/shared';
import { ApiError, EXPECTED_USER_HEADER, api, getPageUser, isOfflineError } from '../lib/api';
import { onConnectionBack } from '../lib/online';

export interface FileJob {
  readonly index: number;
  readonly file: File | Blob;
  readonly name: string;
  readonly role: 'main' | 'track' | 'cover';
}

export interface UploadStatus {
  readonly sent: number;
  readonly total: number;
  readonly waiting: boolean;
  readonly perFile: readonly number[];
}

const PENDING_KEY = 'bookclub:pending-import';

export interface PendingImport {
  readonly importId: string;
  readonly clubId: string;
  readonly kind: Import['kind'];
  readonly files: readonly { name: string; size: number; role: FileJob['role'] }[];
  readonly startedAt: number;
}

export function savePending(p: PendingImport): void {
  try {
    localStorage.setItem(`${PENDING_KEY}:${p.clubId}`, JSON.stringify(p));
  } catch {
    // ignore
  }
}

export function loadPending(clubId: string): PendingImport | null {
  try {
    const raw = localStorage.getItem(`${PENDING_KEY}:${clubId}`);
    return raw ? (JSON.parse(raw) as PendingImport) : null;
  } catch {
    return null;
  }
}

export function clearPending(clubId: string): void {
  try {
    localStorage.removeItem(`${PENDING_KEY}:${clubId}`);
  } catch {
    // ignore
  }
}

const fingerprintPrefix = (importId: string) => `bookclub-${importId}-`;

/** Forget the resume points tus kept for an import's files (once it is finished or cancelled). */
export function forgetFingerprints(importId: string): void {
  try {
    const prefix = `tus::${fingerprintPrefix(importId)}`;
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Does a new selection match the files of an unfinished upload (same names and sizes)? */
export function matchesPending(pending: PendingImport, jobs: readonly { name: string; size: number; role: FileJob['role'] }[]): boolean {
  if (pending.files.length !== jobs.length) return false;
  return pending.files.every((f, i) => f.name === jobs[i]!.name && f.size === jobs[i]!.size && f.role === jobs[i]!.role);
}

/**
 * Retry forever with back-off capped at 30 s: hotel Wi-Fi comes back eventually. A file waiting for
 * the connection does not wait out its back-off once the browser has one again (`onConnectionBack`).
 */
export const RETRY_DELAYS = [0, 1000, 2000, 4000, 8000, 15000, ...new Array<number>(400).fill(30000)];

/**
 * Upload every file of an import with tus, skipping the files the server already has (`done`).
 * Each file resumes from the server's offset after a dropped connection (automatic retries) or
 * after a reload (resume points in localStorage, keyed by the import, so the same file in another
 * upload never resumes into the wrong one; they are kept until the import is finished). A file
 * that lost the connection goes on as soon as the browser is online again, or the page is seen
 * again: resumed afresh from the server's offset, its back-off begun again; one waiting after a
 * server error keeps its back-off. If any file fails for good, the others stop too.
 */
export function uploadAll(
  importId: string,
  jobs: readonly FileJob[],
  onStatus: (s: UploadStatus) => void,
  signal: AbortSignal,
  done: ReadonlySet<number> = new Set(),
): Promise<void> {
  const total = jobs.reduce((s, j) => s + j.file.size, 0);
  const perFile = jobs.map((j) => (done.has(j.index) ? j.file.size : 0));
  let waiting = false;
  const emit = () => onStatus({ sent: perFile.reduce((a, b) => a + b, 0), total, waiting, perFile: [...perFile] });
  emit();
  if (signal.aborted) return Promise.reject(new DOMException('cancelled', 'AbortError'));
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal.addEventListener('abort', onAbort);
  /** How each file under way that lost the connection goes on at once. */
  const resumers = new Set<() => void>();
  const stopListening = onConnectionBack(() => {
    for (const resume of [...resumers]) resume();
  });

  const one = (job: FileJob, slot: number) =>
    new Promise<void>((resolve, reject) => {
      const owner = getPageUser();
      /** The file's upload: a fresh one takes over, resumed, when the connection comes back. */
      let upload: Upload;
      /** It waits to try again because the connection dropped (not because the server failed). */
      let dropped = false;
      const settle = () => {
        resumers.delete(resume);
        stop.signal.removeEventListener('abort', cancel);
      };
      const begin = () => {
        upload = new Upload(job.file, {
          endpoint: '/api/uploads',
          headers: owner ? { [EXPECTED_USER_HEADER]: owner } : {},
          chunkSize: 8 * 1024 * 1024,
          retryDelays: RETRY_DELAYS,
          storeFingerprintForResuming: true,
          removeFingerprintOnSuccess: false,
          fingerprint: () => Promise.resolve(`${fingerprintPrefix(importId)}${job.index}-${job.file.size}`),
          metadata: { importId, fileIndex: String(job.index), filename: job.name, filetype: job.file.type || 'application/octet-stream' },
          onShouldRetry: (err) => {
            const status = err.originalResponse?.getStatus() ?? 0;
            // Someone else signed in on this device meanwhile: the upload is not theirs to finish.
            if (err.originalResponse?.getBody()?.includes('session_changed')) return false;
            const creating = err.originalRequest?.getMethod() === 'POST';
            // Retry network failures and server hiccups (and, mid-file, an offset or lock conflict);
            // never retry a refusal.
            const retry = status === 0 || status >= 500 || status === 429 || (!creating && (status === 409 || status === 423));
            if (retry) {
              dropped = status === 0;
              waiting = true;
              emit();
            }
            return retry;
          },
          onProgress: (sent) => {
            dropped = false;
            waiting = false;
            perFile[slot] = sent;
            emit();
          },
          onSuccess: () => {
            perFile[slot] = job.file.size;
            emit();
            settle();
            resolve();
          },
          onError: (err) => {
            settle();
            reject(err);
          },
        });
        const started = upload;
        void started.findPreviousUploads().then((previous) => {
          if (stop.signal.aborted || started !== upload) return;
          if (previous[0]) started.resumeFromPreviousUpload(previous[0]);
          started.start();
        });
      };
      // The connection is back while this file waits for it: no more waiting out its back-off (up
      // to 30 s); it asks the server where it got to and goes on from there (fidelity review round 16).
      const resume = () => {
        if (!dropped || stop.signal.aborted) return;
        dropped = false;
        void upload.abort();
        begin();
      };
      const cancel = () => {
        resumers.delete(resume);
        void upload.abort();
        reject(new DOMException('cancelled', 'AbortError'));
      };
      stop.signal.addEventListener('abort', cancel, { once: true });
      resumers.add(resume);
      begin();
    });

  // Three files at a time (tracks), in order so the first chapters land first.
  const queue = jobs.map((job, slot) => ({ job, slot })).filter(({ job }) => !done.has(job.index));
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0 && !stop.signal.aborted) {
      const next = queue.shift()!;
      await one(next.job, next.slot);
    }
  });
  return Promise.all(workers)
    .then(() => {
      // Cancelled between files: the workers stopped taking new ones, which is not "all sent".
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    })
    .catch((err: unknown) => {
      stop.abort();
      throw err;
    })
    .finally(() => {
      signal.removeEventListener('abort', onAbort);
      stopListening();
    });
}

/**
 * The unfinished upload a new selection continues, as the server knows it now (which files it
 * already has), or null to start afresh: no matching upload, or the server no longer has it.
 */
export async function resumableImport(clubId: string, shape: PendingImport['files']): Promise<Import | null> {
  const pending = loadPending(clubId);
  if (!pending || !matchesPending(pending, shape)) return null;
  try {
    const imp = await api.getImport(pending.importId);
    if (imp.status !== 'cancelled') return imp;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  clearPending(clubId);
  forgetFingerprints(pending.importId);
  return null;
}

/**
 * Wait, unless cancelled first (then reject as cancelled); waiting for the connection (`untilBack`),
 * no longer than until it is back.
 */
const pause = (ms: number, signal: AbortSignal, untilBack = false) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      stopListening();
    };
    const cancelled = () => {
      done();
      reject(new DOMException('cancelled', 'AbortError'));
    };
    const over = () => {
      done();
      resolve();
    };
    const timer = setTimeout(over, ms);
    const stopListening = untilBack ? onConnectionBack(over) : () => undefined;
    signal.addEventListener('abort', cancelled, { once: true });
  });

/**
 * Finish an import, riding out a dropped connection (finishing is idempotent on the server, and is
 * asked again as soon as the connection is back) and waiting while an earlier request is still
 * finishing it.
 */
export async function finishImport(importId: string, body: Parameters<typeof api.finalizeImport>[1], signal: AbortSignal): Promise<{ bookId: string; editionId: string }> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    try {
      return await api.finalizeImport(importId, body);
    } catch (err) {
      const again = isOfflineError(err) || (err instanceof ApiError && ((err.status === 409 && err.code === 'finishing') || err.status >= 500));
      if (!again || attempt >= 30 || signal.aborted) throw err;
      await pause(Math.min(10_000, 1000 * 2 ** Math.min(attempt, 3)), signal, isOfflineError(err));
    }
  }
}

export async function startImport(clubId: string, kind: Import['kind'], jobs: readonly FileJob[]): Promise<Import> {
  return api.createImport(clubId, { kind, files: jobs.map((j) => ({ name: j.name, size: j.file.size, type: j.file.type || 'application/octet-stream', role: j.role })) });
}
