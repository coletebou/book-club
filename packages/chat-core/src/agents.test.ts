import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_HEADERS, AGENT_SIGNATURE_TOLERANCE_S, agentWebhookHeaders, bearerToken, constantTimeEqual, signAgentWebhook, verifyAgentWebhook } from './agents';

/**
 * The agent protocol's signing (D205), against golden vectors whose signatures were made with
 * Node's own `crypto.createHmac` (fixtures/agents/webhook-v1.json), an implementation apart from
 * the Web Crypto one under test: what this signs, any other HMAC-SHA256 checks, and the reverse.
 */
interface Vector {
  readonly name: string;
  readonly secret: string;
  readonly timestamp: number;
  readonly body: string;
  readonly signature: string;
}
const { vectors } = JSON.parse(readFileSync(new URL('../../../fixtures/agents/webhook-v1.json', import.meta.url), 'utf8')) as { vectors: Vector[] };
const at = (v: Vector) => v.timestamp * 1000;

describe('agent webhook signatures (D205)', () => {
  it.each(vectors)('signs as the golden vector does: $name', async (v) => {
    expect(await signAgentWebhook(v.secret, v.timestamp, v.body)).toBe(v.signature);
    expect(await verifyAgentWebhook({ secret: v.secret, body: v.body, timestamp: String(v.timestamp), signature: v.signature, now: at(v) })).toBe(true);
  });

  it('refuses a body changed by a byte, another secret, or no signature at all', async () => {
    const v = vectors[0]!;
    const base = { secret: v.secret, body: v.body, timestamp: String(v.timestamp), signature: v.signature, now: at(v) };
    expect(await verifyAgentWebhook({ ...base, body: `${v.body} ` })).toBe(false);
    expect(await verifyAgentWebhook({ ...base, secret: `${v.secret}x` })).toBe(false);
    expect(await verifyAgentWebhook({ ...base, signature: null })).toBe(false);
    expect(await verifyAgentWebhook({ ...base, signature: 'v0=abc' })).toBe(false);
    expect(await verifyAgentWebhook({ ...base, signature: v.signature.replace(/.$/u, (c) => (c === '0' ? '1' : '0')) })).toBe(false);
  });

  it('refuses a stale or future timestamp, or one that is no number, however well signed', async () => {
    const v = vectors[0]!;
    const base = { secret: v.secret, body: v.body, timestamp: String(v.timestamp), signature: v.signature };
    expect(await verifyAgentWebhook({ ...base, now: at(v) + AGENT_SIGNATURE_TOLERANCE_S * 1000 })).toBe(true);
    expect(await verifyAgentWebhook({ ...base, now: at(v) + (AGENT_SIGNATURE_TOLERANCE_S + 1) * 1000 })).toBe(false);
    expect(await verifyAgentWebhook({ ...base, now: at(v) - (AGENT_SIGNATURE_TOLERANCE_S + 1) * 1000 })).toBe(false);
    for (const timestamp of ['', '12.5', '-1', '1e9', ' ', undefined]) expect(await verifyAgentWebhook({ ...base, timestamp, now: at(v) })).toBe(false);
    // The timestamp is signed: a fresh one swapped in does not verify.
    const later = String(v.timestamp + 10);
    expect(await verifyAgentWebhook({ ...base, timestamp: later, now: at(v) })).toBe(false);
  });

  it('accepts either of two secrets while one is being changed, and either of two signatures', async () => {
    const v = vectors[0]!;
    const old = 'an-older-secret-of-at-least-32-characters';
    const signedOld = await signAgentWebhook(old, v.timestamp, v.body);
    expect(await verifyAgentWebhook({ secret: [old, v.secret], body: v.body, timestamp: String(v.timestamp), signature: v.signature, now: at(v) })).toBe(true);
    expect(await verifyAgentWebhook({ secret: v.secret, body: v.body, timestamp: String(v.timestamp), signature: `${signedOld}, ${v.signature}`, now: at(v) })).toBe(true);
    expect(await verifyAgentWebhook({ secret: [old], body: v.body, timestamp: String(v.timestamp), signature: v.signature, now: at(v) })).toBe(false);
  });

  it('builds the four headers of a delivery, signed at its time', async () => {
    const v = vectors[0]!;
    const headers = await agentWebhookHeaders({ secret: v.secret, body: v.body, event: 'chat.mention', delivery: 'dlv_01', now: at(v) + 999 });
    expect(headers).toEqual({
      [AGENT_HEADERS.event]: 'chat.mention',
      [AGENT_HEADERS.delivery]: 'dlv_01',
      [AGENT_HEADERS.timestamp]: String(v.timestamp),
      [AGENT_HEADERS.signature]: v.signature,
    });
  });

  it('compares in time that depends only on length, and reads a bearer token', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(bearerToken('Bearer tok_123')).toBe('tok_123');
    expect(bearerToken('bearer   tok_123  ')).toBe('tok_123');
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(bearerToken('Bearer two words')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
