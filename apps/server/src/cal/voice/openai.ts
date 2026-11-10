import { type SpeakOptions, type SttProvider, type SttResult, type TtsProvider, type TtsVoice } from './types';

/** $ per minute of audio transcribed (whisper-1), checked 2026-10-28. */
const STT_PRICE_PER_MINUTE = 0.006;
/** $ per 1M characters synthesised (tts-1), checked 2026-10-28. */
const TTS_PRICE_PER_1M_CHARS = 15;

export class OpenAiSttProvider implements SttProvider {
  readonly name = 'openai';
  readonly model = 'whisper-1';

  constructor(private readonly apiKey: string) {}

  async transcribe(audio: Uint8Array, mimeType: string): Promise<SttResult> {
    const form = new FormData();
    form.append('model', this.model);
    form.append('file', new Blob([audio], { type: mimeType }), `audio.${extFor(mimeType)}`);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: form });
    if (!res.ok) throw new Error(`OpenAI STT failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { text: string };
    const estimatedMinutes = audio.byteLength / (16_000 * 60);
    return { text: body.text, costUsd: estimatedMinutes * STT_PRICE_PER_MINUTE };
  }
}

export class OpenAiTtsProvider implements TtsProvider {
  readonly name = 'openai';
  readonly model = 'tts-1';
  readonly outputMimeType = 'audio/mpeg';

  constructor(
    private readonly apiKey: string,
    private readonly voice = 'alloy',
  ) {}

  /** OpenAI has no narrator voices: a narrator's ElevenLabs voice is not one it can speak (D223). */
  accepts(voice: TtsVoice): boolean {
    return voice.kind === 'cal';
  }

  async *speak(text: string, { signal }: SpeakOptions): AsyncIterable<Uint8Array> {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: 'mp3' }),
    });
    if (!res.ok || !res.body) throw new Error(`OpenAI TTS failed: ${res.status} ${res.ok ? '' : await res.text()}`);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
  }
}

export function openAiCostPerChar(): number {
  return TTS_PRICE_PER_1M_CHARS / 1_000_000;
}

function extFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('wav')) return 'wav';
  return 'mp3';
}
