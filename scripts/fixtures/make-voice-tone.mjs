#!/usr/bin/env node
// A short synthetic WAV tone for the e2e voice/listening-together specs (D153, live.spec.ts):
// Chromium's `--use-file-for-fake-audio-capture` plays this on a loop as the fake microphone's
// input, loud enough that LiveKit's own speaking detection reliably fires — a silent fake mic
// (the flag's default) would make "the speaking indicator shows" a coin flip. Pure Node, no
// ffmpeg: a 16-bit PCM mono WAV built by hand, so this fixture needs nothing beyond Node itself.
//
// Usage: node scripts/fixtures/make-voice-tone.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_RATE = 16_000;
const SECONDS = 2;
const FREQ = 220;
const AMPLITUDE = 0.6 * 0x7fff;

const frames = SAMPLE_RATE * SECONDS;
const data = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) {
  const sample = Math.round(Math.sin((2 * Math.PI * FREQ * i) / SAMPLE_RATE) * AMPLITUDE);
  data.writeInt16LE(sample, i * 2);
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const dir = path.join(root, 'fixtures/audio');
mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'voice-tone.wav');
writeFileSync(out, wav(data));
console.log('wrote', out);
