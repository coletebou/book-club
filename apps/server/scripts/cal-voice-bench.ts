#!/usr/bin/env -S tsx
/**
 * Measures voice-pipeline latency for real STT/TTS providers (D167): synthesises a short reply
 * with each TTS provider (time to first audio byte, total synthesis time, for a ~40-word reply —
 * about what Cal says after a typical question), then feeds that same synthesised clip back
 * through each STT provider (time to transcript, and whether the transcript roughly matches the
 * spoken text) — a realistic round trip without needing a microphone or a pre-recorded fixture.
 *
 * Run on a development host with real keys piped through the environment, never argv:
 *
 *   cat <<'EOF' | ssh <dev-host> 'bash -s'
 *   export ELEVENLABS_API_KEY='...'
 *   export OPENAI_API_KEY='...'
 *   cd ~/book-club && pnpm --filter @bookclub/server exec tsx scripts/cal-voice-bench.ts
 *   EOF
 *
 * Prints one line per provider pair and nothing else; never logs a key.
 */
import { ElevenLabsSttProvider, ElevenLabsTtsProvider } from '../src/cal/voice/elevenlabs';
import { OpenAiSttProvider, OpenAiTtsProvider } from '../src/cal/voice/openai';
import { type SttProvider, type TtsProvider } from '../src/cal/voice/types';

const SAMPLE_REPLY =
  "The Caterpillar asks Alice who she is, and she admits she hardly knows any more, since she has " +
  'changed so many times that day. He seems unimpressed, and tells her to explain herself.';

interface Timing {
  readonly ttfbMs: number;
  readonly totalMs: number;
  readonly bytes: number;
}

async function timeSpeak(tts: TtsProvider, text: string): Promise<{ timing: Timing; audio: Uint8Array }> {
  const started = performance.now();
  let ttfbMs = -1;
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const controller = new AbortController();
  for await (const chunk of tts.speak(text, { signal: controller.signal })) {
    if (ttfbMs < 0) ttfbMs = performance.now() - started;
    bytes += chunk.byteLength;
    chunks.push(chunk);
  }
  const totalMs = performance.now() - started;
  const audio = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    audio.set(c, offset);
    offset += c.byteLength;
  }
  return { timing: { ttfbMs, totalMs, bytes }, audio };
}

async function timeTranscribe(stt: SttProvider, audio: Uint8Array, mimeType: string): Promise<{ ms: number; text: string }> {
  const started = performance.now();
  const result = await stt.transcribe(audio, mimeType);
  return { ms: performance.now() - started, text: result.text };
}

function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z']+/g) ?? []);
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return wa.size === 0 ? 0 : shared / wa.size;
}

async function run(): Promise<void> {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'Rachel';

  const providers: { label: string; stt: SttProvider; tts: TtsProvider }[] = [];
  if (elevenKey) providers.push({ label: 'ElevenLabs', stt: new ElevenLabsSttProvider(elevenKey), tts: new ElevenLabsTtsProvider(elevenKey, voiceId) });
  if (openaiKey) providers.push({ label: 'OpenAI', stt: new OpenAiSttProvider(openaiKey), tts: new OpenAiTtsProvider(openaiKey) });

  if (providers.length === 0) {
    console.log('No voice provider keys found in the environment (ELEVENLABS_API_KEY / OPENAI_API_KEY). Nothing to measure.');
    return;
  }

  console.log(`cal-voice-bench: ${providers.length} provider(s), sample reply: ${SAMPLE_REPLY.length} chars\n`);
  for (const p of providers) {
    try {
      const { timing: ttsTiming, audio } = await timeSpeak(p.tts, SAMPLE_REPLY);
      const { ms: sttMs, text } = await timeTranscribe(p.stt, audio, p.tts.outputMimeType);
      const fidelity = Math.round(similarity(SAMPLE_REPLY, text) * 100);
      console.log(
        `${p.label.padEnd(10)} TTS ttfb=${ttsTiming.ttfbMs.toFixed(0)}ms total=${ttsTiming.totalMs.toFixed(0)}ms (${ttsTiming.bytes}B)  ` +
          `STT total=${sttMs.toFixed(0)}ms fidelity=${fidelity}%  round-trip=${(ttsTiming.ttfbMs + sttMs).toFixed(0)}ms-to-first-byte+stt`,
      );
    } catch (err) {
      console.log(`${p.label.padEnd(10)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

await run();
