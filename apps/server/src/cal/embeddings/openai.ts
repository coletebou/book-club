import { type EmbedResult, type EmbeddingsProvider, RetryableEmbedError } from './provider';

/** $ per input token, OpenAI's published embedding prices (checked 2026-10-28; cost is logged, not billed from this). */
const PRICE_PER_TOKEN: Record<string, number> = {
  'text-embedding-3-small': 0.02 / 1_000_000,
  'text-embedding-3-large': 0.13 / 1_000_000,
};

const DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

export class OpenAiEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = 'openai';
  readonly dim: number;

  constructor(private readonly apiKey: string, readonly model = 'text-embedding-3-small') {
    this.dim = DIMS[model] ?? 1536;
  }

  async embed(texts: readonly string[]): Promise<EmbedResult> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (res.status === 429 || res.status >= 500) throw new RetryableEmbedError(`OpenAI embeddings: ${res.status}`);
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[]; usage?: { total_tokens?: number } };
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => new Float32Array(d.embedding));
    const inputUnits = body.usage?.total_tokens ?? texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
    const price = PRICE_PER_TOKEN[this.model] ?? PRICE_PER_TOKEN['text-embedding-3-small']!;
    return { vectors, inputUnits, costUsd: inputUnits * price };
  }
}
