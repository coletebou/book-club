import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeApp, makeTestApp, setupOwner, type TestApp } from '../../test/helpers';
import { loadConfig } from '../config';
import { runChatTurn, type ChatModel } from './anthropic';
import { solModel, transientModelFailure } from './sol';

const env = { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'test-scoped-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8443/anthropic', ANTHROPIC_AUTH_MODE: 'bearer', ANTHROPIC_TENANT_ID: 'book-club', CAL_MODEL: 'anthropic.claude-opus-5-5', CAL_WEB_SEARCH: 'false', CAL_SOL_BASE_URL: 'http://127.0.0.1:8443/openai', CAL_SOL_INPUT_USD_PER_MILLION: '4', CAL_SOL_OUTPUT_USD_PER_MILLION: '20' };
const params: Parameters<ChatModel['stream']>[0] = { model: 'openai.gpt-6.1-sol', max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, system: [{ type: 'text', text: 'system' }], messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'whats_my_place', description: 'place', input_schema: { type: 'object' } }] };
const usage = { input_tokens: 5, output_tokens: 5 } as Anthropic.Usage;
const answer = { content: [{ type: 'text', text: 'OK', citations: null }], stop_reason: 'end_turn', usage } satisfies Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>;
let app: TestApp | undefined;
afterEach(async () => { if (app) await closeApp(app); app = undefined; vi.unstubAllEnvs(); });
function sse(events: unknown[]): Response { return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
const final = (output: unknown[], status = 'completed') => ({ type: 'response.completed', response: { model: 'openai.gpt-6.1-sol', status, output, usage: { input_tokens: 5, output_tokens: 5 } } });

function scripted(reply: () => ReturnType<ReturnType<ChatModel['stream']>['finalMessage']>, emit = '') {
  return { stream: vi.fn(() => ({ on(_event: 'text', listener: (delta: string) => void) { if (emit) listener(emit); }, finalMessage: reply })) } satisfies ChatModel;
}
async function invoke(primary: ChatModel, fallback: ChatModel) {
  app = await makeTestApp(env);
  const { owner, club } = await setupOwner(app);
  const me = await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200);
  const result = await runChatTurn({ ctx: app.ctx, embeddings: null, model: primary, fallbackModel: fallback }, { clubId: club.id, userId: me.user.id, wholeSeries: false, contextLine: '', history: [], message: 'hi' });
  return { result, club };
}

describe('Mantle Sol fallback', () => {
  it.each([429, 500, 502, 503, 529])('switches once on %i before output and records the fallback model cost', async (status) => {
    const primary = scripted(() => Promise.reject(Object.assign(new Error('capacity'), { status })));
    const fallback = scripted(() => Promise.resolve(answer), 'OK');
    const { result, club } = await invoke(primary, fallback);
    expect(result.content).toEqual([{ type: 'text', text: 'OK' }]);
    expect(primary.stream).toHaveBeenCalledTimes(1);
    expect(fallback.stream).toHaveBeenCalledTimes(1);
    expect(fallback.stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai.gpt-6.1-sol' }));
    expect(app!.ctx.db.get('SELECT provider, model, cost_usd FROM cal_cost_log WHERE club_id = ?', [club.id])).toMatchObject({ provider: 'mantle-sol', model: 'openai.gpt-6.1-sol', cost_usd: 0.00012 });
  });

  it.each([400, 401, 403, 404, 422])('does not fallback on request/auth failure %i', async (status) => {
    const fallback = scripted(() => Promise.resolve(answer));
    await expect(invoke(scripted(() => Promise.reject(Object.assign(new Error('request failure'), { status }))), fallback)).rejects.toThrow('request failure');
    expect(fallback.stream).not.toHaveBeenCalled();
  });

  it('does not mix a partial answer or fallback for an aborted request', async () => {
    const fallback = scripted(() => Promise.resolve(answer));
    await expect(invoke(scripted(() => Promise.reject(Object.assign(new Error('capacity'), { status: 529 })), 'partial'), fallback)).rejects.toThrow();
    expect(fallback.stream).not.toHaveBeenCalled();
    expect(transientModelFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(transientModelFailure(new Anthropic.APIConnectionError({ message: 'reset' }))).toBe(true);
    expect(transientModelFailure(new Anthropic.APIConnectionTimeoutError())).toBe(true);
  });

  it('does not switch after a primary message starts, even without visible text', async () => {
    const primary: ChatModel = { stream: () => ({ currentMessage: { ...answer, id: 'm', type: 'message', role: 'assistant', model: 'anthropic.claude-opus-5-5', container: null, diagnostics: null, stop_details: null, stop_sequence: null }, on() {}, finalMessage: () => Promise.reject(Object.assign(new Error('capacity'), { status: 529 })) }) };
    const fallback = scripted(() => Promise.resolve(answer));
    await expect(invoke(primary, fallback)).rejects.toThrow('capacity');
    expect(fallback.stream).not.toHaveBeenCalled();
  });

  it('never replays tools after a successful primary tool turn fails later', async () => {
    let calls = 0;
    const primary = scripted(() => ++calls === 1 ? Promise.resolve({ content: [{ type: 'tool_use', id: 'call1', name: 'whats_my_place', input: {} }], stop_reason: 'tool_use', usage } as Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>) : Promise.reject(Object.assign(new Error('capacity'), { status: 529 })));
    const fallback = scripted(() => Promise.resolve(answer));
    await expect(invoke(primary, fallback)).rejects.toThrow('capacity');
    expect(fallback.stream).not.toHaveBeenCalled();
  });

  it('uses sticky Sol for its complete tool loop', async () => {
    let calls = 0;
    const fallback = scripted(() => ++calls === 1 ? Promise.resolve({ content: [{ type: 'tool_use', id: 'call1', name: 'whats_my_place', input: {} }], stop_reason: 'tool_use', usage } as Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>) : Promise.resolve(answer));
    const primary = scripted(() => Promise.reject(Object.assign(new Error('capacity'), { status: 529 })));
    await invoke(primary, fallback);
    expect(primary.stream).toHaveBeenCalledTimes(1);
    expect(fallback.stream).toHaveBeenCalledTimes(2);
  });

  it('does not switch on refusal', async () => {
    const fallback = scripted(() => Promise.resolve(answer));
    await invoke(scripted(() => Promise.resolve({ ...answer, stop_reason: 'refusal' })), fallback);
    expect(fallback.stream).not.toHaveBeenCalled();
  });

  it('requires explicit scoped endpoint, accounting prices and compatible tools', () => {
    for (const override of [{ CAL_SOL_INPUT_USD_PER_MILLION: '' }, { CAL_SOL_OUTPUT_USD_PER_MILLION: '' }, { CAL_WEB_SEARCH: 'true' }, { CAL_SOL_BASE_URL: 'http://other.example/openai' }, { ANTHROPIC_AUTH_MODE: 'api-key' }, { CAL_SOL_BASE_URL: 'https://api.openai.com' }, { CAL_SOL_BASE_URL: 'http://127.0.0.1:8443/openai?secret=bad' }]) expect(() => loadConfig({ ...env, ...override })).toThrow();
  });

  it('serializes Responses auth, history, tool outputs and low effort without ambient OpenAI authority', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'wrong-key'); vi.stubEnv('OPENAI_BASE_URL', 'https://untrusted.example');
    let body: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = (_input, init) => {
      expect(_input).toBe('http://127.0.0.1:8443/openai/v1/responses');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-scoped-key');
      expect(new Headers(init?.headers).get('x-gateway-tenant')).toBe('book-club');
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Promise.resolve(sse([{ type: 'response.output_text.delta', delta: 'OK' }, final([{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }])]));
    };
    const stream = solModel(loadConfig(env), fetcher).stream({ ...params, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'whats_my_place', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'position' }] }] });
    const deltas: string[] = []; stream.on('text', (text) => deltas.push(text));
    const response = await stream.finalMessage();
    expect(body).toMatchObject({ model: 'openai.gpt-6.1-sol', reasoning: { effort: 'low' }, service_tier: 'default', store: false, stream: true, max_output_tokens: 16000, input: [{ type: 'function_call', call_id: 'call1', name: 'whats_my_place', arguments: '{}' }, { type: 'function_call_output', call_id: 'call1', output: 'position' }], tools: [{ type: 'function', name: 'whats_my_place' }] });
    expect(deltas).toEqual(['OK']); expect(response).toMatchObject(answer);
  });

  it('parses Sol function-call output and suppresses reasoning deltas', async () => {
    const stream = solModel(loadConfig(env), () => Promise.resolve(sse([{ type: 'response.reasoning_text.delta', delta: 'private' }, final([{ type: 'function_call', call_id: 'call1', name: 'whats_my_place', arguments: '{}' }])]))).stream(params);
    const listener = vi.fn(); stream.on('text', listener);
    expect(await stream.finalMessage()).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call1', name: 'whats_my_place', input: {} }] });
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(['truncated', 'refusal', 'failed'])('rejects %s Sol output without manufacturing a completion', async (kind) => {
    const events = kind === 'truncated' ? [{ type: 'response.output_text.delta', delta: 'partial' }] : [{ type: kind === 'refusal' ? 'response.refusal.delta' : 'response.failed' }];
    const stream = solModel(loadConfig(env), () => Promise.resolve(sse(events))).stream(params);
    await expect(stream.finalMessage()).rejects.toThrow();
  });
});
