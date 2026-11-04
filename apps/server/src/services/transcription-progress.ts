/**
 * Live progress of the server's recogniser on an audiobook: the progress file the tools write
 * (bookclub-transcribe-progress/1), ETA from measured realtime factor, and the view the API
 * exposes on Edition.transcription.
 */
import type { TranscriptionStage, TranscriptionStatus } from '@bookclub/shared';

export const PROGRESS_FORMAT = 'bookclub-transcribe-progress/1';

/** Wall-seconds per audio-second when nothing has been measured yet (GPU ≈ 0.015, CPU ≈ 0.12). */
export const FALLBACK_RTF = { gpu: 0.015, cpu: 0.12 } as const;

export interface ProgressDoc {
  format: string;
  stage: TranscriptionStage;
  tracksDone?: number | null;
  tracksTotal?: number | null;
  audioMsDone?: number | null;
  audioMsTotal?: number | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  engine?: 'gpu' | 'cpu' | null;
  message?: string | null;
}

/** In-memory copy while a recogniser (or its alignment) is in flight for one audiobook. */
export interface LiveTranscription {
  stage: TranscriptionStage;
  tracksDone: number | null;
  tracksTotal: number | null;
  audioMsDone: number | null;
  audioMsTotal: number | null;
  /** Wall-clock ms when this run's work began (upload or first audio). */
  startedAt: number;
  engine: 'gpu' | 'cpu' | null;
  message: string | null;
  updatedAt: number;
}

export function parseProgressDoc(raw: string): ProgressDoc | null {
  try {
    const doc = JSON.parse(raw) as ProgressDoc;
    if (!doc || doc.format !== PROGRESS_FORMAT || typeof doc.stage !== 'string') return null;
    return doc;
  } catch {
    return null;
  }
}

/** Merge a progress file (or PROGRESS stderr JSON) into the live state; never throws. */
export function applyProgressDoc(live: LiveTranscription, doc: ProgressDoc): void {
  if (doc.stage) live.stage = doc.stage;
  if (doc.tracksDone != null) live.tracksDone = doc.tracksDone;
  if (doc.tracksTotal != null) live.tracksTotal = doc.tracksTotal;
  if (doc.audioMsDone != null) live.audioMsDone = doc.audioMsDone;
  if (doc.audioMsTotal != null) live.audioMsTotal = doc.audioMsTotal;
  if (doc.engine === 'gpu' || doc.engine === 'cpu') live.engine = doc.engine;
  if (doc.message != null) live.message = doc.message;
  if (typeof doc.startedAt === 'number' && doc.startedAt > 0) {
    // Python writes unix seconds; accept either seconds or ms.
    live.startedAt = doc.startedAt < 1e12 ? Math.round(doc.startedAt * 1000) : Math.round(doc.startedAt);
  }
  live.updatedAt = Date.now();
}

/** Parse a PROGRESS <json> stderr line into a doc, or null. */
export function parseProgressLine(line: string): ProgressDoc | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('PROGRESS ')) return null;
  return parseProgressDoc(trimmed.slice('PROGRESS '.length));
}

export function fractionOf(live: Pick<LiveTranscription, 'audioMsDone' | 'audioMsTotal' | 'tracksDone' | 'tracksTotal'>): number | null {
  if (live.audioMsTotal && live.audioMsTotal > 0 && live.audioMsDone != null) {
    return Math.min(1, Math.max(0, live.audioMsDone / live.audioMsTotal));
  }
  if (live.tracksTotal && live.tracksTotal > 0 && live.tracksDone != null) {
    return Math.min(1, Math.max(0, live.tracksDone / live.tracksTotal));
  }
  return null;
}

/**
 * Estimated ms remaining. Prefers measured wall/audio once enough audio has been heard; else a
 * GPU/CPU fallback realtime factor against remaining audio (or full length when still queued).
 */
export function etaMsOf(live: LiveTranscription, now = Date.now()): number | null {
  const total = live.audioMsTotal ?? 0;
  if (total <= 0) return null;
  if (live.stage === 'aligning') return null; // alignment is short and unmeasured
  if (live.stage === 'failed') return null;
  const done = live.audioMsDone ?? 0;
  const remaining = Math.max(0, total - done);
  if (remaining === 0 && (live.stage === 'transcribing_gpu' || live.stage === 'transcribing_cpu')) return 0;
  const elapsed = Math.max(0, now - live.startedAt);
  let rtf: number;
  if (done > 30_000 && elapsed > 5_000) {
    rtf = elapsed / done;
  } else {
    const engine = live.engine ?? (live.stage === 'transcribing_gpu' || live.stage === 'uploading' ? 'gpu' : 'cpu');
    rtf = FALLBACK_RTF[engine];
  }
  // Queued / uploading: treat remaining as the whole book (upload is usually a few seconds).
  const audioLeft = live.stage === 'queued' || live.stage === 'uploading' ? total : remaining;
  return Math.round(audioLeft * rtf);
}

export function toTranscriptionStatus(live: LiveTranscription, now = Date.now()): TranscriptionStatus {
  return {
    stage: live.stage,
    tracksDone: live.tracksDone,
    tracksTotal: live.tracksTotal,
    audioMsDone: live.audioMsDone,
    audioMsTotal: live.audioMsTotal,
    fraction: fractionOf(live),
    etaMs: etaMsOf(live, now),
    message: live.message,
    updatedAt: new Date(live.updatedAt).toISOString(),
  };
}

export function initialLive(opts: {
  stage?: TranscriptionStage;
  tracksTotal: number;
  audioMsTotal: number;
  engine?: 'gpu' | 'cpu' | null;
  now?: number;
}): LiveTranscription {
  const now = opts.now ?? Date.now();
  return {
    stage: opts.stage ?? 'queued',
    tracksDone: 0,
    tracksTotal: opts.tracksTotal,
    audioMsDone: 0,
    audioMsTotal: opts.audioMsTotal,
    startedAt: now,
    engine: opts.engine ?? null,
    message: null,
    updatedAt: now,
  };
}

/** Last meaningful stderr line from a recogniser; skip PROGRESS {…} noise. */
export function lastRecogniserError(stderr: string): string {
  const lines = stderr.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('PROGRESS ')) continue;
    return line;
  }
  return '';
}
