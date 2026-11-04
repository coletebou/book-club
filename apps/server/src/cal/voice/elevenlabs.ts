import { type SttProvider, type SttResult, type TtsProvider } from './types';

/** $ per minute of audio transcribed (Scribe), checked 2026-10-28. Logged for the spend cap, never billed from this. */
const STT_PRICE_PER_MINUTE = 0.04;
/** $ per 1K characters synthesised (Flash v2.5-class pricing), checked 2026-10-28. */
const TTS_PRICE_PER_1K_CHARS = 0.05;

export class ElevenLabsSttProvider implements SttProvider {
  readonly name = 'elevenlabs';
  readonly model = 'scribe_v1';

  constructor(private readonly apiKey: string) {}

  async transcribe(audio: Uint8Array, mimeType: string): Promise<SttResult> {
    const form = new FormData();
    form.append('model_id', this.model);
    form.append('file', new Blob([audio], { type: mimeType }), 'audio');
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': this.apiKey }, body: form });
    if (!res.ok) throw new Error(`ElevenLabs STT failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { text: string };
    // ElevenLabs does not return duration on this endpoint; estimated from a typical 16kbps-ish voice clip.
    const estimatedMinutes = audio.byteLength / (16_000 * 60);
    return { text: body.text, costUsd: estimatedMinutes * STT_PRICE_PER_MINUTE };
  }
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = 'elevenlabs';
  readonly model = 'eleven_flash_v2_5';
  readonly outputMimeType = 'audio/mpeg';

  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
  ) {}

  async *speak(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=mp3_44100_128`, {
      method: 'POST',
      signal,
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: this.model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.ok ? '' : await res.text()}`);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
  }
}

export function elevenLabsCostPerChar(): number {
  return TTS_PRICE_PER_1K_CHARS / 1000;
}
