import { type SpeakOptions, type SttProvider, type SttResult, type TtsProvider, type TtsVoice } from './types';

/** Deterministic, offline voice providers for tests: no network, no key, instant. */
export class FakeSttProvider implements SttProvider {
  readonly name = 'fake';
  readonly model = 'fake-stt';
  constructor(private readonly fixedText = 'Tell me about chapter one.') {}
  async transcribe(): Promise<SttResult> {
    return { text: this.fixedText, costUsd: 0 };
  }
}

/** The bytes the fake speaks first: which voice it was asked for, so a test can tell whose reply it heard (D223). */
export function fakeVoiceTag(voice: TtsVoice | undefined): string {
  return voice?.kind === 'narrator' ? `voice:${voice.voiceId}:${voice.settings.speed}` : 'voice:cal';
}

export class FakeTtsProvider implements TtsProvider {
  readonly name = 'fake';
  readonly model = 'fake-tts';
  readonly outputMimeType = 'audio/wav';
  /** Stands in for ElevenLabs, so a narrator's ElevenLabs voice is one it speaks. */
  accepts(): boolean {
    return true;
  }
  async *speak(text: string, options: SpeakOptions): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(fakeVoiceTag(options.voice));
    // A few silent "chunks" scaled to the text length, so streaming behaviour is still exercised.
    const chunks = Math.max(1, Math.ceil(text.length / 80));
    for (let i = 0; i < chunks; i++) yield new Uint8Array(256);
  }
}
