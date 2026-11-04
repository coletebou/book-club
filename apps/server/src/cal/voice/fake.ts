import { type SttProvider, type SttResult, type TtsProvider } from './types';

/** Deterministic, offline voice providers for tests: no network, no key, instant. */
export class FakeSttProvider implements SttProvider {
  readonly name = 'fake';
  readonly model = 'fake-stt';
  constructor(private readonly fixedText = 'Tell me about chapter one.') {}
  async transcribe(): Promise<SttResult> {
    return { text: this.fixedText, costUsd: 0 };
  }
}

export class FakeTtsProvider implements TtsProvider {
  readonly name = 'fake';
  readonly model = 'fake-tts';
  readonly outputMimeType = 'audio/wav';
  async *speak(text: string): AsyncIterable<Uint8Array> {
    // A few silent "chunks" scaled to the text length, so streaming behaviour is still exercised.
    const chunks = Math.max(1, Math.ceil(text.length / 80));
    for (let i = 0; i < chunks; i++) yield new Uint8Array(256);
  }
}
