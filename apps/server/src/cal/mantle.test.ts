import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { clientFor, runChatTurn } from './anthropic';
import { closeApp, makeTestApp, setupOwner } from '../../test/helpers';

const BASE = { NODE_ENV: 'test', DATA_DIR: '.data-config-test', SCRYPT_LOG_N: '12' } as const;
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('explicit Mantle client configuration', () => {
  it('keeps the official endpoint and API-key auth pinned by default', () => {
    const client = clientFor(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'test-key' }))!;
    expect(client.baseURL).toBe('https://api.anthropic.com');
    expect(client.apiKey).toBe('test-key');
    expect(client.authToken).toBeNull();
    expect(loadConfig(BASE).CAL_EFFORT).toBe('low');
  });

  it('rejects ambient custom headers before either auth mode can send a polluted request', () => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'aUtHoRiZaTiOn: Bearer wrong\nX-Api-Key: wrong\nX-Gateway-Tenant: wrong');
    for (const mode of ['api-key', 'bearer']) {
      expect(() => clientFor(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_AUTH_MODE: mode }))).toThrow('ANTHROPIC_CUSTOM_HEADERS is not supported');
      expect(() => clientFor(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_AUTH_MODE: mode, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8443/anthropic', ANTHROPIC_TENANT_ID: 'book-club' }))).toThrow('ANTHROPIC_CUSTOM_HEADERS is not supported');
    }
  });

  it('pins SDK logging and telemetry instead of inheriting ambient tracing', () => {
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token');
    const client = clientFor(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'test-key' }))!;
    expect(client.logLevel).toBe('off');
    expect(client.openTelemetry.traces.enabled).toBe(false);
    expect(client.authToken).toBeNull();
  });

  it('refuses malformed endpoints, tenant headers and effort instead of silently falling back', () => {
    for (const url of ['file:///tmp/api', 'https://user:secret@example.com/api', 'https://example.com/api?key=x', 'https://example.com/api#x']) {
      expect(() => loadConfig({ ...BASE, ANTHROPIC_BASE_URL: url })).toThrow();
    }
    expect(() => loadConfig({ ...BASE, ANTHROPIC_TENANT_ID: 'book-club' })).toThrow();
    for (const endpoint of ['https://api.anthropic.com', 'http://api.anthropic.com', 'https://api.anthropic.com:444', 'https://api.anthropic.com.']) {
      expect(() => loadConfig({ ...BASE, ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_TENANT_ID: 'book-club' })).toThrow();
    }
    expect(() => loadConfig({ ...BASE, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8443', ANTHROPIC_TENANT_ID: 'bad\r\nheader' })).toThrow();
    expect(() => loadConfig({ ...BASE, CAL_EFFORT: 'nonsense' })).toThrow();
  });


  it('streams adaptive thinking across a real SDK tool loop without leaking it to text', async () => {
    const requests: { messages: unknown[]; model: string; thinking: unknown; output_config: unknown; tools: { type?: string; name?: string }[]; system: { text: string }[] }[] = [];
    const frames = (turn: number) => {
      const events: unknown[] = [{ type: 'message_start', message: { id: `msg_${turn}`, type: 'message', role: 'assistant', model: 'anthropic.claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }];
      if (turn === 1) {
        events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'test-signature' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-place', name: 'whats_my_place', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
          { type: 'content_block_stop', index: 1 },
        );
      } else {
        events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
          { type: 'content_block_stop', index: 0 },
        );
      }
      events.push({ type: 'message_delta', delta: { stop_reason: turn === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
      return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number]);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frames(requests.length));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no test server port');
    const t = await makeTestApp({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/anthropic`, ANTHROPIC_AUTH_MODE: 'bearer', ANTHROPIC_TENANT_ID: 'book-club', CAL_MODEL: 'anthropic.claude-opus-5-5', CAL_WEB_SEARCH: 'false' });
    try {
      const { owner, club } = await setupOwner(t);
      const me = await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200);
      const deltas: string[] = [];
      const result = await runChatTurn({ ctx: t.ctx, embeddings: null }, { clubId: club.id, userId: me.user.id, wholeSeries: false, contextLine: '', history: [], message: 'hi', onDelta: (text) => deltas.push(text) });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request).toMatchObject({ model: 'anthropic.claude-opus-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
        expect(request.tools.some((tool) => tool.name === 'whats_my_place')).toBe(true);
        expect(request.tools.some((tool) => tool.name === 'web_search')).toBe(false);
        expect(request.system[0]!.text).toContain('Web search is unavailable');
      }
      expect(requests[1]!.messages).toContainEqual({ role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning', signature: 'test-signature' },
        { type: 'tool_use', id: 'call-place', name: 'whats_my_place', input: {} },
      ] });
      const replay = requests[1]!.messages as { role: string; content: { type: string; tool_use_id?: string }[] }[];
      expect(replay.some((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === 'call-place'))).toBe(true);
      expect(deltas.join('')).toBe('OK');
      expect(result.content).toEqual([{ type: 'text', text: 'OK' }]);
      const cost = t.ctx.db.get<{ cost_usd: number }>('SELECT cost_usd FROM cal_cost_log WHERE club_id = ?', [club.id]);
      expect(cost!.cost_usd).toBeCloseTo(0.00024, 8);
    } finally { await closeApp(t); }
  });

  it('serializes the proxy path, exact model, bearer/tenant headers and adaptive low effort through the real SDK', async () => {
    let observed: { path: string; headers: Record<string, unknown>; body: unknown } | undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
      observed = { path: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'anthropic.claude-opus-5-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no test server port');
    const client = clientFor(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'test-scoped-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/anthropic`, ANTHROPIC_AUTH_MODE: 'bearer', ANTHROPIC_TENANT_ID: 'book-club', CAL_MODEL: 'anthropic.claude-opus-5-5' }))!;
    const params = { model: 'anthropic.claude-opus-5-5', max_tokens: 256, messages: [{ role: 'user' as const, content: 'hi' }], thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } };
    await client.messages.create(params);
    expect(observed!.path).toBe('/anthropic/v1/messages');
    expect(observed!.headers['authorization']).toBe('Bearer test-scoped-key');
    expect(observed!.headers['x-api-key']).toBeUndefined();
    expect(observed!.headers['x-gateway-tenant']).toBe('book-club');
    expect(observed!.body).toMatchObject({ model: 'anthropic.claude-opus-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });

    // A gateway that reads the tenant from a header of its own gets it there, and only there.
    const named = clientFor(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'test-scoped-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/anthropic`, ANTHROPIC_AUTH_MODE: 'bearer', ANTHROPIC_TENANT_ID: 'book-club', ANTHROPIC_TENANT_HEADER: 'x-acme-tenant', CAL_MODEL: 'anthropic.claude-opus-5-5' }))!;
    await named.messages.create(params);
    expect(observed!.headers['x-acme-tenant']).toBe('book-club');
    expect(observed!.headers['x-gateway-tenant']).toBeUndefined();
  });

  it('names the tenant header x-gateway-tenant unless told otherwise, and never an authentication header', () => {
    expect(loadConfig(BASE).ANTHROPIC_TENANT_HEADER).toBe('x-gateway-tenant');
    expect(loadConfig({ ...BASE, ANTHROPIC_TENANT_HEADER: '' }).ANTHROPIC_TENANT_HEADER).toBe('x-gateway-tenant');
    expect(loadConfig({ ...BASE, ANTHROPIC_TENANT_HEADER: 'x-acme-tenant' }).ANTHROPIC_TENANT_HEADER).toBe('x-acme-tenant');
    for (const name of ['x-api-key', 'authorization', 'anthropic-version', 'X-Acme-Tenant', 'x-', 'x-acme tenant']) {
      expect(() => loadConfig({ ...BASE, ANTHROPIC_TENANT_HEADER: name })).toThrow();
    }
  });
});
