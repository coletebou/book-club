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
  async *speak(_text: string, options: SpeakOptions): AsyncIterable<Uint8Array> {
    // A short, playable reply for the demo. The voice tag sits in a WAV chunk that players skip.
    const tag = Buffer.from(fakeVoiceTag(options.voice));
    const tagSize = tag.length + (tag.length % 2);
    const sampleRate = 16_000;
    const samples = sampleRate / 4;
    const dataStart = 52 + tagSize;
    const wav = Buffer.alloc(dataStart + samples * 2);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('JUNK', 36);
    wav.writeUInt32LE(tagSize, 40);
    tag.copy(wav, 44);
    wav.write('data', dataStart - 8);
    wav.writeUInt32LE(samples * 2, dataStart - 4);
    for (let i = 0; i < samples; i += 1) {
      wav.writeInt16LE(Math.round(750 * Math.sin((2 * Math.PI * i * 440) / sampleRate)), dataStart + i * 2);
    }
    for (let i = 0; i < wav.length && !options.signal.aborted; i += 1024) yield wav.subarray(i, i + 1024);
  }
}
