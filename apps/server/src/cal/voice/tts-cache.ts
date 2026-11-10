import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../../lib/crypto';
import { CAL_VOICE, type SpeakOptions, type TtsProvider, type TtsVoice } from './types';

/** How a cached reply is handed back: in pieces the size a stream would bring them, so the client plays it the same way. */
const CHUNK_BYTES = 16 * 1024;
/** Pruning walks the whole cache: at most once a minute, whatever the rate of new replies. */
const PRUNE_EVERY_MS = 60_000;

/**
 * Spoken replies, kept (D223): the same words in the same voice, spoken the same way, are read
 * from disk instead of being synthesised and paid for again. The key is everything that changes
 * the audio: the provider, its model and output format, the voice (Cal's own, by the id the
 * server is configured with, or the narrator's voice id with its settings and seed) and the text.
 * Only a reply that was spoken to its end is kept; one cut off by a barge-in never is, so a later
 * hit is never half a sentence.
 *
 * It lives in the data directory's `derived/` (safe to delete, never served over HTTP), bounded
 * by size and age: past `maxBytes` the least recently used go first, and nothing is kept longer
 * than `maxAgeMs`, so a reply is not kept long after the conversation it was said in.
 */
export class CachedTtsProvider implements TtsProvider {
  readonly name: string;
  readonly model: string;
  readonly outputMimeType: string;
  private lastPrune = 0;
  private pruning: Promise<void> | null = null;

  constructor(
    private readonly inner: TtsProvider,
    private readonly dir: string,
    private readonly options: { readonly maxBytes: number; readonly maxAgeMs: number; readonly calVoiceId: string },
  ) {
    this.name = inner.name;
    this.model = inner.model;
    this.outputMimeType = inner.outputMimeType;
  }

  accepts(voice: TtsVoice): boolean {
    return this.inner.accepts(voice);
  }

  keyFor(text: string, voice: TtsVoice | undefined): string {
    const v = voice ?? CAL_VOICE;
    // The player's rate is applied after synthesis, so it does not change the audio kept.
    const who = v.kind === 'narrator' && this.inner.accepts(v) ? { voiceId: v.voiceId, settings: { ...v.settings, rate: undefined } } : { cal: this.options.calVoiceId };
    return createHash('sha256').update(JSON.stringify({ provider: this.inner.name, model: this.inner.model, format: this.inner.outputMimeType, who, text })).digest('hex');
  }

  private fileFor(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key}.audio`);
  }

  async *speak(text: string, options: SpeakOptions): AsyncIterable<Uint8Array> {
    const file = this.fileFor(this.keyFor(text, options.voice));
    const cached = await readFile(file).catch(() => null);
    if (cached && cached.byteLength > 0) {
      const now = new Date();
      await utimes(file, now, now).catch(() => undefined);
      options.onCacheHit?.();
      for (let i = 0; i < cached.byteLength; i += CHUNK_BYTES) {
        if (options.signal.aborted) return;
        yield new Uint8Array(cached.buffer, cached.byteOffset + i, Math.min(CHUNK_BYTES, cached.byteLength - i));
      }
      return;
    }
    const parts: Uint8Array[] = [];
    for await (const chunk of this.inner.speak(text, options)) {
      parts.push(chunk);
      yield chunk;
    }
    // Reached only when the provider finished and the listener took every chunk: a reply cut off is never kept.
    if (options.signal.aborted) return;
    await this.keep(file, Buffer.concat(parts));
  }

  private async keep(file: string, bytes: Buffer): Promise<void> {
    if (bytes.byteLength === 0 || bytes.byteLength > this.options.maxBytes) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${newId()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    } catch {
      // A cache that cannot be written costs a synthesis next time, nothing more.
      return;
    }
    if (Date.now() - this.lastPrune >= PRUNE_EVERY_MS) void this.prune();
  }

  /** Remove what is too old, then the least recently used until the cache fits. */
  prune(now = Date.now()): Promise<void> {
    this.pruning ??= this.pruneOnce(now).finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }

  private async pruneOnce(now: number): Promise<void> {
    this.lastPrune = now;
    const entries: { file: string; size: number; mtimeMs: number }[] = [];
    for (const sub of await readdir(this.dir).catch(() => [] as string[])) {
      const subdir = path.join(this.dir, sub);
      for (const name of await readdir(subdir).catch(() => [] as string[])) {
        const file = path.join(subdir, name);
        const s = await stat(file).catch(() => null);
        if (!s?.isFile()) continue;
        // A temporary file left by a write that never finished (the process stopped mid-write).
        if (name.endsWith('.tmp') && now - s.mtimeMs < PRUNE_EVERY_MS) continue;
        entries.push({ file, size: name.endsWith('.tmp') ? Number.POSITIVE_INFINITY : s.size, mtimeMs: s.mtimeMs });
      }
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((n, e) => n + (Number.isFinite(e.size) ? e.size : 0), 0);
    for (const e of entries) {
      const stale = !Number.isFinite(e.size) || now - e.mtimeMs > this.options.maxAgeMs;
      if (!stale && total <= this.options.maxBytes) continue;
      await rm(e.file, { force: true }).catch(() => undefined);
      if (Number.isFinite(e.size)) total -= e.size;
    }
  }
}
