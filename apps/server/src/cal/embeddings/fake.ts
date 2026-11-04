import { createHash } from 'node:crypto';
import { type EmbedResult, type EmbeddingsProvider } from './provider';

/**
 * A deterministic, offline embedding: the same text always yields the same vector, and texts
 * that share words land closer together than texts that do not (a hashed bag-of-words), which is
 * enough for unit and integration tests of chunking, indexing and hybrid search to exercise real
 * cosine similarity without a network call or a key.
 */
export class FakeEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = 'fake';
  readonly model = 'fake-hashing-v1';
  readonly dim: number;

  constructor(dim = 64) {
    this.dim = dim;
  }

  async embed(texts: readonly string[]): Promise<EmbedResult> {
    return { vectors: texts.map((t) => this.embedOne(t)), inputUnits: texts.reduce((s, t) => s + t.length, 0), costUsd: 0 };
  }

  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const word of words) {
      const digest = createHash('sha1').update(word).digest();
      for (let i = 0; i < this.dim; i++) {
        const byte = digest[i % digest.length]!;
        // Spread a word's hash across every dimension with alternating sign, so unrelated words
        // rarely cancel out completely and shared words reliably pull vectors together.
        v[i] = (v[i] ?? 0) + (byte / 255 - 0.5) * (i % 2 === 0 ? 1 : -1);
      }
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) v[i] = v[i]! / norm;
    return v;
  }
}
