import { Worker } from 'node:worker_threads';
import { type BuiltPublication, EpubError } from '@bookclub/epub';
import {
  type AlignResult,
  type AlignTask,
  type PdfTextResult,
  type PdfTextTask,
  type PrintAlignResult,
  type PrintAlignTask,
  type PublicationTask,
  type ReadResult,
  type ReadTask,
  type TranscriptAtomsResult,
  type TranscriptAtomsTask,
  WORKER_ROLE,
  type WorkReply,
  type WorkResult,
  type WorkTask,
} from './align-worker';
import { workerFromSources } from '../lib/worker-source';

/*
 * Reading EPUBs, PDFs' text and transcripts, and lining audiobooks and PDFs up with their text,
 * happen in worker threads (align-worker.ts), each piece of work in a worker of its own with a
 * time and a memory limit: the server's own thread only hands the work over and keeps what comes
 * back, so a crafted transcript costs one worker its limits, never the server its answers.
 */

/**
 * How long a piece of work may take, and how much memory its JavaScript heap may use. Buffers (a
 * book's files) sit outside that heap: the work's own limits bound them.
 */
export interface WorkLimits {
  readonly ms: number;
  readonly heapMb: number;
}

/**
 * Cal's atoms of one audiobook's transcript (D160): a 100-hour audiobook (TRANSCRIBE_MAX_HOURS) is
 * about a million words, read and walked in a few seconds with room to spare in this heap.
 */
export const TRANSCRIPT_ATOMS_LIMITS: WorkLimits = { ms: 120_000, heapMb: 1024 };

/** Work stopped at one of its limits; the message says which ("it took longer than 60 s"). */
export class WorkLimitError extends Error {
  override name = 'WorkLimitError';
}

/** The worker: beside the bundle once built (build.mjs); from the sources, bundled here in memory. */
const BUILT = import.meta.url.endsWith('.ts') ? null : new URL('./align-worker.mjs', import.meta.url);

async function startWorker(heapMb: number): Promise<Worker> {
  // None of the server's own command-line flags (a development loader) are the worker's business.
  const options = { workerData: { role: WORKER_ROLE }, resourceLimits: { maxOldGenerationSizeMb: heapMb } };
  if (BUILT) return new Worker(BUILT, { ...options, execArgv: [] });
  return new Worker(await workerFromSources(new URL('./align-worker.ts', import.meta.url)), { ...options, eval: true, execArgv: ['--input-type=module'] });
}

/**
 * Do one piece of work in a worker thread of its own: the worker is stopped once it answers, when
 * it takes longer than `limits.ms` (a WorkLimitError), and by Node when its heap would grow past
 * `limits.heapMb` (a WorkLimitError too). Anything else that goes wrong in it is an Error with its
 * message.
 */
export function runInWorker(task: ReadTask, limits: WorkLimits): Promise<ReadResult>;
export function runInWorker(task: AlignTask, limits: WorkLimits): Promise<AlignResult>;
export function runInWorker(task: PublicationTask, limits: WorkLimits): Promise<BuiltPublication>;
export function runInWorker(task: PdfTextTask, limits: WorkLimits): Promise<PdfTextResult>;
export function runInWorker(task: PrintAlignTask, limits: WorkLimits): Promise<PrintAlignResult>;
export function runInWorker(task: TranscriptAtomsTask, limits: WorkLimits): Promise<TranscriptAtomsResult>;
export async function runInWorker(task: WorkTask, limits: WorkLimits): Promise<WorkResult> {
  const worker = await startWorker(limits.heapMb);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      done();
    };
    const timer = setTimeout(() => settle(() => reject(new WorkLimitError(`it took longer than ${limits.ms / 1000} s`))), limits.ms);
    worker.once('message', (reply: WorkReply) =>
      settle(() => ('error' in reply ? reject(reply.epub ? new EpubError(reply.error, reply.epub) : new Error(reply.error)) : resolve(reply.result))),
    );
    // Listened to for as long as the worker lives: an error nobody listens to would end the server.
    worker.on('error', (err: Error & { code?: string }) =>
      settle(() => reject(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new WorkLimitError(`it needed more than ${limits.heapMb} MB`) : err)),
    );
    worker.once('exit', (code) => settle(() => reject(new Error(`the worker stopped (exit code ${code})`))));
    worker.postMessage(task);
  });
}
