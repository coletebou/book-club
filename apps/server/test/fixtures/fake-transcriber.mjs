#!/usr/bin/env node
/**
 * A stand-in for tools/align/transcribe.py in tests: `--words FILE --out FILE track…`. It "hears"
 * the words listed in FILE (one array per track, in order) spread evenly over each track, and
 * writes a bookclub-transcript/1 document naming each track by its SHA-256, as the real one does.
 * When TRANSCRIBE_PROGRESS_FILE is set, writes bookclub-transcribe-progress/1 as it goes.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ options: { words: { type: 'string' }, out: { type: 'string' } }, allowPositionals: true });
const heard = JSON.parse(readFileSync(values.words, 'utf8'));
const durationMs = 4000;
const progressFile = process.env.TRANSCRIBE_PROGRESS_FILE;
const audioTotal = Number(process.env.TRANSCRIBE_AUDIO_MS_TOTAL || positionals.length * durationMs);
const startedAt = Date.now() / 1000;
const engine = process.env.FAKE_ENGINE === 'gpu' ? 'gpu' : 'cpu';
const stage = engine === 'gpu' ? 'transcribing_gpu' : 'transcribing_cpu';

function writeProgress(partial) {
  if (!progressFile) return;
  const doc = {
    format: 'bookclub-transcribe-progress/1',
    stage,
    engine,
    startedAt,
    updatedAt: Date.now() / 1000,
    audioMsTotal: audioTotal,
    tracksTotal: positionals.length,
    ...partial,
  };
  const tmp = `${progressFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc));
  renameSync(tmp, progressFile);
  console.error(`PROGRESS ${JSON.stringify(doc)}`);
}

writeProgress({ tracksDone: 0, audioMsDone: 0 });
const doc = {
  format: 'bookclub-transcript/1',
  engine: 'fake-transcriber',
  tracks: positionals.map((file, k) => {
    const words = heard[k] ?? [];
    const step = (durationMs - 1000) / Math.max(1, words.length);
    writeProgress({ tracksDone: k, audioMsDone: k * durationMs });
    return {
      file,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      durationMs,
      words: words.map((w, i) => [Math.round(500 + i * step), Math.round(500 + (i + 0.8) * step), w]),
    };
  }),
};
writeProgress({ tracksDone: positionals.length, audioMsDone: positionals.length * durationMs });
writeFileSync(values.out, JSON.stringify(doc));
