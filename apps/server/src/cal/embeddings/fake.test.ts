import { describe, expect, it } from 'vitest';
import { FakeEmbeddingsProvider } from './fake';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe('FakeEmbeddingsProvider', () => {
  it('is deterministic: the same text always embeds to the same vector', async () => {
    const provider = new FakeEmbeddingsProvider(32);
    const a = await provider.embed(['the quick brown fox']);
    const b = await provider.embed(['the quick brown fox']);
    expect([...a.vectors[0]!]).toEqual([...b.vectors[0]!]);
  });

  it('places texts that share words closer together than texts that share none', async () => {
    const provider = new FakeEmbeddingsProvider(64);
    const { vectors } = await provider.embed([
      'the caterpillar asked alice who she was',
      'alice told the caterpillar she hardly knew any more',
      'quantum entanglement in superconducting circuits',
    ]);
    const shared = cosine(vectors[0]!, vectors[1]!);
    const unrelated = cosine(vectors[0]!, vectors[2]!);
    expect(shared).toBeGreaterThan(unrelated);
  });

  it('returns unit-ish normalized vectors', async () => {
    const provider = new FakeEmbeddingsProvider(16);
    const { vectors } = await provider.embed(['a short sentence with several words in it']);
    let norm = 0;
    for (const x of vectors[0]!) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('costs nothing (no network, no key needed)', async () => {
    const provider = new FakeEmbeddingsProvider();
    const result = await provider.embed(['anything']);
    expect(result.costUsd).toBe(0);
  });
});
