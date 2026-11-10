import { solModel, transientModelFailure } from './sol';
import Anthropic from '@anthropic-ai/sdk';
import { type Config } from '../config';
import { type AppContext } from '../context';
import { bookById } from '../repos/books';
import { type EmbeddingsProvider } from './embeddings';
import { CalGate } from './gating';
import { type BookScope, chunkById, inScope, logCost } from './store';
import { CAL_TOOLS, type ToolContext, runTool } from './tools';
import { type CalContentPart } from './types';

/**
 * Cal's persona (D160): a warm, erudite, concise librarian, never twee — named for Callimachus,
 * who catalogued the Library of Alexandria in the Pinakes. The spoiler rule binds his own general
 * knowledge too (D162): he knows a famous book's ending from training, and must hold it back from
 * someone who has not read that far, exactly as he holds back a club's own text.
 */
const PERSONA = `You are Cal — Callimachus — the Book Club's librarian. You catalogued the Library of \
Alexandria in the Pinakes once; now you catalogue this club's own shelf. You are warm, erudite and \
concise. Never twee, never gushing, never an exclamation point you didn't earn. You answer any \
question about anything — the club's books, a method of close reading, the weather of plot \
structure, or something with nothing to do with books at all.

For questions about the club's books, use search_library (hybrid full-text + semantic search over \
the club's indexed editions and Cal's shelf) before answering from memory: the club's own text is \
the primary source, and you cite it. Cite a search result you actually rely on with a bare \
[[cite:CHUNK_ID]] marker immediately after the sentence it supports — never show a chunk id to the \
reader any other way, and never cite a chunk you were not given by a tool call this turn. Use \
get_passage when you need a result's surrounding context. Use whats_my_place to see the asker's \
own and their club friends' reading positions (chapter and percentage only — you are never given a \
friend's notes or reactions past the asker's own place, and must not relay anything about them \
beyond where they have read to).

THE SPOILER RULE (binding on everything you say, not only on search results): never reveal what \
happens in a club book beyond the asker's own place in it — not from search results, which are \
already filtered to what they have read, and not from your own training either. You may know a \
famous book's ending from memory; you must hold it back exactly as you would hold back a club \
member's own spoiler, unless the asker has turned on "whole series" in your settings, a \
standing choice (you will be told plainly when it is on). When you are unsure whether \
something is past the asker's place, say so and ask, rather than guess wrong in the spoiler \
direction. This rule never applies to a question with nothing to do with a club book.

You are not only a librarian of this one shelf.

What you write is the answer itself: no notes on how you will answer, and no internal or system \
XML tags or markers in your response.`;

export const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 } as const;

/** The tools that search what he may draw on: offered only when a turn has anything to search (D204). */
const LIBRARY_TOOLS = new Set(['search_library', 'get_passage']);

function anthropicTools(options: { readonly library: boolean; readonly web: boolean }): Anthropic.Tool[] {
  const custom = CAL_TOOLS.filter((d) => options.library || !LIBRARY_TOOLS.has(d.name)).map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
  // The tool list depends only on config and the kind of turn (his panel, or a channel of the
  // club's chat, D204), never on the request's words, and its last entry carries the cache
  // breakpoint: tools render before system/messages, so one breakpoint there caches the whole
  // tools array for every turn of that kind this process serves.
  const list = options.web ? [...custom, WEB_SEARCH_TOOL] : custom;
  return list.map((t, i) => (i === list.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t)) as unknown as Anthropic.Tool[];
}

/**
 * The slice of the Anthropic SDK's streaming surface runChatTurn actually uses — narrowed to a
 * seam so tests can supply a deterministic fake model (cal/anthropic.test.ts) without touching
 * the real API. `clientFor`'s result satisfies this structurally; no adapter needed.
 */
export interface ChatModel {
  /** `options.signal`: the turn is called off (a deadline, a shutdown): stop at once. */
  stream(params: {
    model: string;
    max_tokens: number;
    thinking: { type: 'adaptive' };
    output_config: { effort: Config['CAL_EFFORT'] };
    system: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
  }, options?: { signal?: AbortSignal }): {
    readonly currentMessage?: Anthropic.Message;
    on(event: 'text', listener: (delta: string) => void): void;
    finalMessage(): Promise<Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>>;
  };
}

export interface ChatDeps {
  readonly ctx: AppContext;
  readonly embeddings: EmbeddingsProvider | null;
  /** Overrides the real Anthropic client (tests only); defaults to `clientFor(ctx.config).messages`. */
  readonly model?: ChatModel;
  /** Test seam for the explicit Sol fallback. */
  readonly fallbackModel?: ChatModel;
}

export interface ChatRequest {
  readonly clubId: string;
  readonly userId: string;
  readonly wholeSeries: boolean;
  /**
   * Which of the club's books Cal may draw on this turn (D204): in the club's chat, the channel's
   * own book, or none in General, since what he says there is read by everyone at once. Absent
   * (his own panel), all of them, each gated for the asker as ever (D162).
   */
  readonly books?: BookScope;
  /**
   * What else he may draw on (D204): his shelf, and the web. Neither has a place in a book, so
   * neither can be held to a spoiler fence: the club's chat turns both off. Absent (his own
   * panel): both, as configured.
   */
  readonly sources?: { readonly shelf: boolean; readonly web: boolean };
  /** The turn is called off (a deadline, a shutdown): it stops between steps, and its model call with it. */
  readonly signal?: AbortSignal;
  /** A short line of dynamic context: the asker's current book and place, if any (never cached). */
  readonly contextLine: string;
  /** Prior turns of this conversation, final text only (no tool scaffolding is persisted, see store.ts). */
  readonly history: readonly { role: 'user' | 'assistant'; text: string }[];
  readonly message: string;
  readonly onDelta?: (text: string) => void;
}

export interface ChatResult {
  readonly content: CalContentPart[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Tool-use turns Cal may take before an answer is forced, so a loop (or a confused model) cannot run away with the club's spend cap. */
const MAX_TOOL_TURNS = 6;

/** Citation markers Cal is asked to emit: `[[cite:chunkId]]`. */
const CITE_MARKER = /\s*\[\[cite:([A-Za-z0-9_-]+)\]\]/g;

export function clientFor(config: Config): Anthropic | null {
  if (!config.ANTHROPIC_API_KEY) return null;
  // SDK 1.x merges this ambient escape hatch after generated authentication. Never let
  // a CLI profile replace the scoped server credential or add an accounting identity.
  if (process.env.ANTHROPIC_CUSTOM_HEADERS?.trim()) throw new Error('ANTHROPIC_CUSTOM_HEADERS is not supported; configure the server provider explicitly.');
  return new Anthropic({
    apiKey: config.ANTHROPIC_AUTH_MODE === 'api-key' ? config.ANTHROPIC_API_KEY : null,
    authToken: config.ANTHROPIC_AUTH_MODE === 'bearer' ? config.ANTHROPIC_API_KEY : null,
    baseURL: config.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    logLevel: 'off',
    openTelemetry: false,
    defaultHeaders: config.ANTHROPIC_TENANT_ID ? { [config.ANTHROPIC_TENANT_HEADER]: config.ANTHROPIC_TENANT_ID } : {},
  });
}

/**
 * One chat turn: streams Cal's text as it is generated (`onDelta`), running his tools as he asks
 * for them, until he gives a final answer or MAX_TOOL_TURNS is reached. Citations are built from
 * `[[cite:ID]]` markers in the final text, each re-verified against the spoiler gate and against
 * the set of chunk ids actually offered to the model this turn before being shown to anyone
 * (D162: a marker naming anything else is silently dropped, never trusted).
 */
export async function runChatTurn(deps: ChatDeps, req: ChatRequest): Promise<ChatResult> {
  const chatModel: ChatModel | null = deps.model ?? clientFor(deps.ctx.config)?.messages ?? null;
  if (!chatModel) throw new Error('Cal has no ANTHROPIC_API_KEY configured.');
  let model = deps.ctx.config.CAL_MODEL;
  let activeModel = chatModel;
  let visibleText = false;
  let usedSol = false;
  let primaryStreamStarted = false;
  const fallback = deps.ctx.config.CAL_SOL_BASE_URL ? deps.fallbackModel ?? solModel(deps.ctx.config) : null;
  const web = deps.ctx.config.CAL_WEB_SEARCH && (req.sources?.web ?? true);
  const shelf = req.sources?.shelf ?? true;
  // Nothing to search (General in the club's chat): no search tools to call for nothing.
  const library = shelf || !req.books || req.books.length > 0;
  const tools = anthropicTools({ library, web });
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: PERSONA + (web ? '\nYou may use web_search for current or obscure information.' : '\nWeb search is unavailable here. Do not claim to browse or check current information.'), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: req.contextLine },
  ];
  const messages: Anthropic.MessageParam[] = [
    ...req.history.map((h): Anthropic.MessageParam => ({ role: h.role, content: h.text })),
    { role: 'user', content: req.message },
  ];
  const toolContext: ToolContext = {
    ctx: deps.ctx,
    embeddings: deps.embeddings,
    clubId: req.clubId,
    userId: req.userId,
    wholeSeries: req.wholeSeries,
    books: req.books ?? null,
    shelf,
    offeredChunkIds: new Set<string>(),
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = '';

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    req.signal?.throwIfAborted();
    const call = async () => {
      const params = { model, max_tokens: 16000, thinking: { type: 'adaptive' as const }, output_config: { effort: deps.ctx.config.CAL_EFFORT }, system, messages, tools };
      // A turn that can be called off says so; one that cannot (his panel) calls the model as ever.
      const stream = req.signal ? activeModel.stream(params, { signal: req.signal }) : activeModel.stream(params);
      stream.on('text', (delta) => { if (delta) visibleText = true; req.onDelta?.(delta); });
      try { return await stream.finalMessage(); }
      catch (error) { if (!usedSol && stream.currentMessage) primaryStreamStarted = true; throw error; }
    };
    let response: Awaited<ReturnType<ReturnType<ChatModel['stream']>['finalMessage']>>;
    try { response = await call(); }
    catch (error) {
      // Never mix answers, replay executed tools, hide refusals or cross an auth boundary.
      if (!fallback || usedSol || turn !== 0 || visibleText || primaryStreamStarted || !transientModelFailure(error)) throw error;
      activeModel = fallback;
      usedSol = true;
      model = deps.ctx.config.CAL_SOL_MODEL;
      response = await call();
    }
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const turnText = textBlocks.map((b) => b.text).join('');
    finalText += (finalText && turnText ? '\n' : '') + turnText;

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const results = await Promise.all(
      toolUses.map(async (call) => {
        // Only a tool offered this turn runs: a model naming another (General has no search, D204) gets nothing from it.
        if (!tools.some((tool) => tool.name === call.name)) return { call, result: { text: `Unknown tool: ${call.name}` } };
        const result = await runTool(toolContext, call.name, call.input).catch((err: unknown) => ({
          text: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
        }));
        return { call, result };
      }),
    );
    messages.push({
      role: 'user',
      content: results.map(({ call, result }): Anthropic.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: call.id, content: result.text })),
    });
  }

  logCost(deps.ctx.db, {
    clubId: req.clubId,
    userId: req.userId,
    kind: 'chat',
    provider: usedSol ? 'mantle-sol' : 'anthropic',
    model,
    inputUnits: inputTokens,
    outputUnits: outputTokens,
    costUsd: usedSol ? (inputTokens * deps.ctx.config.CAL_SOL_INPUT_USD_PER_MILLION! + outputTokens * deps.ctx.config.CAL_SOL_OUTPUT_USD_PER_MILLION!) / 1_000_000 : estimateChatCostUsd(model, inputTokens, outputTokens),
  });

  return { content: buildContent(finalText, toolContext.offeredChunkIds, deps.ctx, req), inputTokens, outputTokens };
}

/** $/1M tokens, Anthropic's published prices (checked 2026-10-28, apps/server/src/cal/anthropic.ts). Logged for the spend cap, never billed from this. */
const CHAT_PRICE: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
};

export function estimateChatCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = CHAT_PRICE[model.replace(/^anthropic\./, '')] ?? CHAT_PRICE['claude-sonnet-5-5']!;
  return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
}

function buildContent(text: string, offered: ReadonlySet<string>, ctx: AppContext, req: ChatRequest): CalContentPart[] {
  const citations: CalContentPart[] = [];
  const cleaned = text.replace(CITE_MARKER, (_match, chunkId: string) => {
    if (!offered.has(chunkId)) return '';
    const part = citationFor(ctx, req, chunkId);
    if (!part) return '';
    citations.push(part);
    return ` [${citations.length}]`;
  });
  return [{ type: 'text', text: cleaned.trim() }, ...citations];
}

function citationFor(ctx: AppContext, req: ChatRequest, chunkId: string): CalContentPart | null {
  const chunk = chunkById(ctx.db, chunkId);
  if (!chunk || chunk.club_id !== req.clubId || chunk.source_type !== 'book' || !chunk.book_id || !inScope(req.books ?? null, chunk)) return null;
  const book = bookById(ctx.db, chunk.book_id);
  if (!book) return null;
  const gate = new CalGate(ctx.db, req.userId, req.wholeSeries);
  if (!gate.bookIncluded(book) || !gate.chunkReadable(book, chunk) || chunk.t_start === null) return null;
  return {
    type: 'citation',
    chunkId: chunk.id,
    bookId: book.id,
    bookTitle: book.title,
    chapterTitle: chunk.chapter_title,
    t: chunk.t_start,
    quote: chunk.text.slice(0, 280),
  };
}
