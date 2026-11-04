import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeApp, fileOf, makeEpub, makeTestApp, setupOwner, uploadBook, type Client, type TestApp } from '../../test/helpers';
import { type ChatModel, runChatTurn } from './anthropic';
import { FakeEmbeddingsProvider } from './embeddings/fake';

type FinalMessage = Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>;

/** A scripted stand-in for Claude: returns the next entry of `script` on each turn, in order. */
class ScriptedModel implements ChatModel {
  calls: Anthropic.MessageParam[][] = [];
  params: Parameters<ChatModel['stream']>[0][] = [];
  constructor(private readonly script: FinalMessage[]) {}
  stream(params: Parameters<ChatModel['stream']>[0]) {
    this.params.push(params);
    this.calls.push(params.messages);
    const final = this.script[this.calls.length - 1] ?? this.script[this.script.length - 1]!;
    return {
      on: (_event: 'text', listener: (delta: string) => void) => {
        for (const block of final.content) if (block.type === 'text') listener(block.text);
      },
      finalMessage: () => Promise.resolve(final),
    };
  }
}

const usage = { input_tokens: 5, output_tokens: 5 } as Anthropic.Usage;
const textOnly = (text: string): FinalMessage => ({ content: [{ type: 'text', text, citations: null }] as unknown as Anthropic.ContentBlock[], stop_reason: 'end_turn', usage });

const ch1 = '<p>' + 'alpha '.repeat(200) + '.</p>';

async function userId(c: Client): Promise<string> {
  const me = await c.json<{ user: { id: string } }>(c.get('/api/me'), 200);
  return me.user.id;
}

describe('runChatTurn', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp({ CAL_EMBEDDING_PROVIDER: 'fake', ANTHROPIC_API_KEY: 'test-key-unused-with-model-override', CAL_MODEL: 'anthropic.claude-opus-5-5' });
  });
  afterEach(() => closeApp(t));

  it('returns Claude’s text when no tool is used', async () => {
    const { owner, club } = await setupOwner(t);
    const model = new ScriptedModel([textOnly('Hello there.')]);
    const result = await runChatTurn(
      { ctx: t.ctx, embeddings: null, model },
      { clubId: club.id, userId: await userId(owner), wholeSeries: false, contextLine: '', history: [], message: 'hi' },
    );
    expect(result.content).toEqual([{ type: 'text', text: 'Hello there.' }]);
    expect(model.params[0]).toMatchObject({ model: 'anthropic.claude-opus-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    const cost = t.ctx.db.get<{ cost_usd: number }>('SELECT cost_usd FROM cal_cost_log WHERE club_id = ?', [club.id]);
    expect(cost!.cost_usd).toBeCloseTo(0.00012, 8);
  });

  it('runs a tool call, then answers with a citation built from the tool result', async () => {
    const { owner, club } = await setupOwner(t);
    const file = fileOf('book.epub', makeEpub([ch1], { title: 'Alice Clone', author: 'Test' }), 'main', 'application/epub+zip');
    const result = await uploadBook(owner, club.id, 'epub', [file], { title: 'Alice Clone', author: 'Test' });
    await t.settle();
    const edition = t.ctx.db.get<{ id: string }>('SELECT id FROM editions WHERE book_id = ?', [result.bookId])!.id;
    await owner.post(`/api/books/${result.bookId}/progress/read-up-to`, { editionId: edition, locator: { kind: 'epub', section: 0, offset: 9999 } });
    const chunk = t.ctx.db.get<{ id: string }>('SELECT id FROM cal_chunks WHERE book_id = ?', [result.bookId])!;

    const model = new ScriptedModel([
      {
        content: [{ type: 'tool_use', id: 'call-1', name: 'search_library', input: { query: 'alpha' } }] as unknown as Anthropic.ContentBlock[],
        stop_reason: 'tool_use',
        usage,
      },
      textOnly(`There it is. [[cite:${chunk.id}]]`),
    ]);
    const chat = await runChatTurn(
      { ctx: t.ctx, embeddings: new FakeEmbeddingsProvider(), model },
      { clubId: club.id, userId: await userId(owner), wholeSeries: false, contextLine: '', history: [], message: 'tell me about alpha' },
    );
    const text = chat.content.find((c) => c.type === 'text');
    const citations = chat.content.filter((c) => c.type === 'citation');
    expect(text).toMatchObject({ text: 'There it is. [1]' });
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ chunkId: chunk.id, bookId: result.bookId });
  });

  it('drops a citation marker naming a chunk that was never offered this turn (a guessed or stale id)', async () => {
    const { owner, club } = await setupOwner(t);
    const model = new ScriptedModel([textOnly('Spoiler-proof answer. [[cite:not-a-real-chunk]]')]);
    const chat = await runChatTurn(
      { ctx: t.ctx, embeddings: null, model },
      { clubId: club.id, userId: await userId(owner), wholeSeries: false, contextLine: '', history: [], message: 'hi' },
    );
    expect(chat.content).toHaveLength(1);
    expect(chat.content[0]).toMatchObject({ type: 'text', text: 'Spoiler-proof answer.' });
  });

  it('stops after MAX_TOOL_TURNS even if the model keeps asking for tools', async () => {
    const { owner, club } = await setupOwner(t);
    const loopingToolUse: FinalMessage = {
      content: [{ type: 'tool_use', id: 'call-x', name: 'whats_my_place', input: {} }] as unknown as Anthropic.ContentBlock[],
      stop_reason: 'tool_use',
      usage,
    };
    const model = new ScriptedModel(Array.from({ length: 10 }, () => loopingToolUse));
    const chat = await runChatTurn(
      { ctx: t.ctx, embeddings: null, model },
      { clubId: club.id, userId: await userId(owner), wholeSeries: false, contextLine: '', history: [], message: 'loop' },
    );
    expect(model.calls.length).toBeLessThanOrEqual(6);
    expect(model.params.every((params) => params.output_config.effort === 'low' && params.thinking.type === 'adaptive')).toBe(true);
    expect(chat.content[0]).toMatchObject({ type: 'text' });
  });
});
