import { runChatTurn } from '../anthropic';
import { DeterministicFakeChatModel } from '../fake-model';
import { embeddingsProviderFor } from '../embeddings';
import { conversationById, insertMessage, logCost, messageContent, messagesForConversation, renameConversation, settingsFor, threadTitle } from '../store';
import { type CalContentPart } from '../types';
import { type AppContext } from '../../context';
import { bookById, bookChapters } from '../../repos/books';
import { progressFor } from '../../repos/progress';
import { chapterNameAt, formatPercent } from '@bookclub/shared';
import { elevenLabsCostPerChar } from './elevenlabs';
import { openAiCostPerChar } from './openai';
import { narratorVoiceFor } from './narrator';
import { transcribeAndLog } from './transcription';
import { CAL_VOICE, type SttProvider, type TtsProvider, type TtsVoice } from './types';

export interface VoiceTurnInput {
  readonly ctx: AppContext;
  readonly stt: SttProvider;
  readonly tts: TtsProvider;
  readonly clubId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly wholeSeries: boolean;
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly handsFree?: boolean;
  readonly signal: AbortSignal;
  readonly verifyAccess?: () => void;
  readonly onTranscript?: (text: string) => void;
  readonly onTextDelta?: (text: string) => void;
  /** Who is speaking: Cal, or the book's narrator (D223), so the client can say so and match the listener's speed. */
  readonly onSpeakingStart?: (voice: SpokenVoice) => void;
  readonly onAudioChunk: (chunk: Uint8Array) => void;
  readonly onSpeakingEnd?: () => void;
}

/** `[[cite:ID]]` is already turned into a `[n]` footnote by anthropic.ts's buildContent; spoken aloud that reads as noise, so it is dropped here. */
export function textForSpeech(content: readonly CalContentPart[]): string {
  return content
    .filter((p): p is Extract<CalContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text.replace(/\s*\[\d+]/g, ''))
    .join(' ')
    .trim();
}

function plainText(content: readonly CalContentPart[]): string {
  return content
    .filter((p): p is Extract<CalContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function costPerChar(provider: string): number {
  return provider === 'elevenlabs' ? elevenLabsCostPerChar() : provider === 'openai' ? openAiCostPerChar() : 0;
}

/**
 * One voice turn (D160, architecture (b)): speech-to-text, then the same brain text chat uses
 * (runChatTurn — same persona, same tools, same spoiler rule, anthropic.ts), then streaming
 * text-to-speech. Barge-in is the caller's `signal`: aborting it stops speech generation mid-
 * sentence (the ws route wires a client "bargeIn" message to this).
 */
/** What the client is told of the voice a reply is spoken in: never the voice id or its settings. */
export type SpokenVoice =
  | { readonly kind: 'cal' }
  | { readonly kind: 'narrator'; readonly narrator: string; readonly source: 'narration' | 'clone' | 'designed'; /** The player's rate for the narrator's pace (TtsVoiceSettings.rate). */ readonly rate: number };

/**
 * The voice a reply about this conversation's book is spoken in (D223): its narrator's, when the
 * book has one, the server allows it and the TTS provider can speak it; else Cal's own.
 */
export function replyVoiceFor(ctx: AppContext, tts: TtsProvider, bookId: string | null): TtsVoice {
  if (!ctx.config.CAL_NARRATOR_VOICES) return CAL_VOICE;
  const narrator = narratorVoiceFor(ctx.db, bookId);
  return narrator && tts.accepts(narrator) ? narrator : CAL_VOICE;
}

function spoken(voice: TtsVoice): SpokenVoice {
  return voice.kind === 'narrator' ? { kind: 'narrator', narrator: voice.narrator, source: voice.source, rate: voice.settings.rate } : { kind: 'cal' };
}

export type VoiceTurnOutcome = 'silent' | 'stopped' | 'answered';

export async function runVoiceTurn(input: VoiceTurnInput): Promise<VoiceTurnOutcome> {
  const verifyActive = () => {
    input.signal.throwIfAborted();
    input.verifyAccess?.();
    input.signal.throwIfAborted();
  };
  const transcript = await transcribeAndLog(input.ctx, { clubId: input.clubId, userId: input.userId }, input.stt, input.audio, input.mimeType);
  // Account for a completed transcription even when the listener interrupted the turn.
  verifyActive();
  // Continuous mode reserves the single spoken word "stop" as a command (D272).
  if (input.handsFree && /^stop[.!?]*$/i.test(transcript.trim())) return 'stopped';
  input.onTranscript?.(transcript);
  if (transcript.trim().length === 0) return 'silent';
  input.signal.throwIfAborted();

  const conversation = conversationById(input.ctx.db, input.conversationId);
  const history = conversation ? messagesForConversation(input.ctx.db, conversation.id).map((m) => ({ role: m.role, text: plainText(messageContent(m)) })) : [];
  insertMessage(input.ctx.db, { conversationId: input.conversationId, role: 'user', content: [{ type: 'text', text: transcript }], wholeSeries: input.wholeSeries });
  // A thread begun aloud is named by its first question too (D183), as a typed one is.
  if (conversation && conversation.title === '') renameConversation(input.ctx.db, conversation.id, threadTitle(transcript));

  const result = await runChatTurn(
    // The same test stand-in text chat uses (routes/cal.ts): with CAL_TEST_FAKE_MODEL, voice never calls Anthropic either.
    { ctx: input.ctx, embeddings: embeddingsProviderFor(input.ctx.config), model: input.ctx.config.CAL_TEST_FAKE_MODEL ? new DeterministicFakeChatModel() : undefined },
    {
      clubId: input.clubId,
      userId: input.userId,
      wholeSeries: input.wholeSeries,
      contextLine: contextLineFor(input.ctx, input.userId, conversation?.book_id ?? null),
      history,
      message: transcript,
      signal: input.signal,
      onDelta: input.onTextDelta,
    },
  );
  verifyActive();
  insertMessage(input.ctx.db, { conversationId: input.conversationId, role: 'assistant', content: result.content, wholeSeries: input.wholeSeries, inputTokens: result.inputTokens, outputTokens: result.outputTokens });

  await speakCalReply(input, conversation?.book_id ?? null, textForSpeech(result.content));
  return 'answered';
}

/** Spoken replies share narrator selection, caching and cost accounting across transports. */
export async function speakCalReply(
  input: Pick<VoiceTurnInput, 'ctx' | 'tts' | 'clubId' | 'userId' | 'signal' | 'onSpeakingStart' | 'onAudioChunk' | 'onSpeakingEnd'>,
  bookId: string | null,
  speech: string,
): Promise<void> {
  if (speech.length === 0 || input.signal.aborted) return;
  const voice = replyVoiceFor(input.ctx, input.tts, bookId);
  input.onSpeakingStart?.(spoken(voice));
  let cached = false;
  try {
    for await (const chunk of input.tts.speak(speech, { signal: input.signal, voice, onCacheHit: () => (cached = true) })) {
      if (input.signal.aborted) break;
      input.onAudioChunk(chunk);
    }
  } finally {
    // Count a synthesis requested from the provider even if delivery was cancelled. A cache hit
    // (D223) was already counted when this reply was first spoken.
    const costUsd = cached ? 0 : speech.length * costPerChar(input.tts.name);
    logCost(input.ctx.db, { clubId: input.clubId, userId: input.userId, kind: 'voice_tts', provider: input.tts.name, model: voice.kind === 'narrator' ? voice.settings.modelId : input.tts.model, inputUnits: speech.length, outputUnits: 0, costUsd });
    input.onSpeakingEnd?.();
  }
}

function contextLineFor(ctx: AppContext, userId: string, bookId: string | null): string {
  if (!bookId) return "This conversation isn't tied to one of the club's books.";
  const book = bookById(ctx.db, bookId);
  if (!book) return "This conversation isn't tied to one of the club's books.";
  const progress = progressFor(ctx.db, userId, bookId);
  const place = progress ? (chapterNameAt(bookChapters(book), progress.t) ?? `before ${formatPercent(progress.t)}`) : 'the asker has not started it';
  const settings = settingsFor(ctx.db, userId);
  const wholeNote = settings.whole_series === 1 ? ' The asker has turned on "Cal may use the whole series" as a standing setting.' : '';
  return `This conversation is about "${book.title}". The asker's own place in it: ${place}.${wholeNote} You are speaking aloud: keep sentences short and natural to listen to.`;
}
