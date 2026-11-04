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

export interface TtsProvider {
  readonly name: string;
  readonly model: string;
  readonly outputMimeType: string;
  /** Speak `text`, yielding audio chunks as they are generated (streaming synthesis). */
  speak(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}
