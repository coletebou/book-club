import { runChatTurn } from '../anthropic';
import { embeddingsProviderFor } from '../embeddings';
import { conversationById, insertMessage, logCost, messageContent, messagesForConversation, renameConversation, settingsFor, threadTitle } from '../store';
import { type CalContentPart } from '../types';
import { type AppContext } from '../../context';
import { bookById, bookChapters } from '../../repos/books';
import { progressFor } from '../../repos/progress';
import { chapterNameAt, formatPercent } from '@bookclub/shared';
import { elevenLabsCostPerChar } from './elevenlabs';
import { openAiCostPerChar } from './openai';
import { type SttProvider, type TtsProvider } from './types';

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
  readonly signal: AbortSignal;
  readonly onTranscript?: (text: string) => void;
  readonly onTextDelta?: (text: string) => void;
  readonly onSpeakingStart?: () => void;
  readonly onAudioChunk: (chunk: Uint8Array) => void;
  readonly onSpeakingEnd?: () => void;
}

/** `[[cite:ID]]` is already turned into a `[n]` footnote by anthropic.ts's buildContent; spoken aloud that reads as noise, so it is dropped here. */
function textForSpeech(content: readonly CalContentPart[]): string {
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
export async function runVoiceTurn(input: VoiceTurnInput): Promise<void> {
  const sttResult = await input.stt.transcribe(input.audio, input.mimeType);
  logCost(input.ctx.db, { clubId: input.clubId, userId: input.userId, kind: 'voice_stt', provider: input.stt.name, model: input.stt.model, inputUnits: input.audio.byteLength, outputUnits: 0, costUsd: sttResult.costUsd });
  input.onTranscript?.(sttResult.text);
  if (sttResult.text.trim().length === 0) return;

  const conversation = conversationById(input.ctx.db, input.conversationId);
  const history = conversation ? messagesForConversation(input.ctx.db, conversation.id).map((m) => ({ role: m.role, text: plainText(messageContent(m)) })) : [];
  insertMessage(input.ctx.db, { conversationId: input.conversationId, role: 'user', content: [{ type: 'text', text: sttResult.text }], wholeSeries: input.wholeSeries });
  // A thread begun aloud is named by its first question too (D183), as a typed one is.
  if (conversation && conversation.title === '') renameConversation(input.ctx.db, conversation.id, threadTitle(sttResult.text));

  const result = await runChatTurn(
    { ctx: input.ctx, embeddings: embeddingsProviderFor(input.ctx.config) },
    {
      clubId: input.clubId,
      userId: input.userId,
      wholeSeries: input.wholeSeries,
      contextLine: contextLineFor(input.ctx, input.userId, conversation?.book_id ?? null),
      history,
      message: sttResult.text,
      onDelta: input.onTextDelta,
    },
  );
  insertMessage(input.ctx.db, { conversationId: input.conversationId, role: 'assistant', content: result.content, wholeSeries: input.wholeSeries, inputTokens: result.inputTokens, outputTokens: result.outputTokens });

  const speech = textForSpeech(result.content);
  if (speech.length === 0 || input.signal.aborted) return;
  input.onSpeakingStart?.();
  try {
    for await (const chunk of input.tts.speak(speech, input.signal)) {
      if (input.signal.aborted) break;
      input.onAudioChunk(chunk);
    }
    logCost(input.ctx.db, { clubId: input.clubId, userId: input.userId, kind: 'voice_tts', provider: input.tts.name, model: input.tts.model, inputUnits: speech.length, outputUnits: 0, costUsd: speech.length * costPerChar(input.tts.name) });
  } finally {
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
