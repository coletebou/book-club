/**
 * Voice providers (D160): speech-to-text and text-to-speech, pluggable so the measured choice
 * (docs/DECISIONS.md D167) is not load-bearing — a club can be moved to another provider by one
 * config change. Architecture (b) (D167): STT -> Claude (runChatTurn, the same brain, the
 * same tools, the same spoiler rule as text chat) -> streaming TTS, rather than a speech-to-speech
 * realtime model, so Cal stays one consistent mind in both surfaces (see anthropic.ts).
 */
export interface SttResult {
  readonly text: string;
  readonly costUsd: number;
}

export interface SttProvider {
  readonly name: string;
  readonly model: string;
  /** Transcribe one turn's audio (a single encoded clip: webm/opus, wav or mp3 — providers below accept all three). */
  transcribe(audio: Uint8Array, mimeType: string): Promise<SttResult>;
}

/** How a voice is spoken (D223): ElevenLabs' voice settings, plus the TTS model to speak it with. */
export interface TtsVoiceSettings {
  readonly stability: number;
  readonly similarityBoost: number;
  readonly style: number;
  /** 0.7-1.2 (ElevenLabs' range): matched to the narrator's measured pace. */
  readonly speed: number;
  readonly useSpeakerBoost: boolean;
  readonly modelId: string;
  /** Fixed per voice, so one text in one voice is spoken the same each time and a cached copy is faithful. */
  readonly seed: number;
}

/** Whose voice a reply is spoken in: the server's own (Cal's), or a book's narrator's (D223). */
export type TtsVoice =
  | { readonly kind: 'cal' }
  | {
      readonly kind: 'narrator';
      readonly provider: 'elevenlabs';
      readonly voiceId: string;
      /** Which of the book's voices this is: (a) the narration's own, (c) a consented clone, (b) a designed match. */
      readonly source: 'narration' | 'clone' | 'designed';
      readonly narrator: string;
      readonly settings: TtsVoiceSettings;
    };

export const CAL_VOICE: TtsVoice = { kind: 'cal' };

export interface SpeakOptions {
  readonly signal: AbortSignal;
  /** Cal's own voice when absent. A provider that cannot speak `voice` (another provider's id) uses its own. */
  readonly voice?: TtsVoice;
  /** Called once, before the first chunk, when the audio comes from the cache rather than the provider (nothing is spent). */
  readonly onCacheHit?: () => void;
}

export interface TtsProvider {
  readonly name: string;
  readonly model: string;
  readonly outputMimeType: string;
  /** Whether `speak` honours this voice; the pipeline asks before saying it answers in the narrator's voice. */
  accepts(voice: TtsVoice): boolean;
  /** Speak `text`, yielding audio chunks as they are generated (streaming synthesis). */
  speak(text: string, options: SpeakOptions): AsyncIterable<Uint8Array>;
}
