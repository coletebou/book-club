import { type EmbedResult, type EmbeddingsProvider, RetryableEmbedError } from './provider';

/** $ per input token for Gemini embeddings (checked 2026-10-28; gemini-embedding-001 is free up to generous limits, priced beyond). */
const PRICE_PER_TOKEN = 0.15 / 1_000_000;

export class GeminiEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = 'gemini';
  readonly dim = 3072;

  constructor(private readonly apiKey: string, readonly model = 'gemini-embedding-001') {}

  async embed(texts: readonly string[]): Promise<EmbedResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((t) => ({ model: `models/${this.model}`, content: { parts: [{ text: t }] } })),
      }),
    });
    if (res.status === 429 || res.status >= 500) throw new RetryableEmbedError(`Gemini embeddings: ${res.status}`);
    if (!res.ok) throw new Error(`Gemini embeddings failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { embeddings: { values: number[] }[] };
    const vectors = body.embeddings.map((e) => new Float32Array(e.values));
    const inputUnits = texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
    return { vectors, inputUnits, costUsd: inputUnits * PRICE_PER_TOKEN };
  }
}
