/**
 * An embeddings provider turns text into float32 vectors (cal_embeddings.vector, D161). Pluggable
 * by design: OpenAI by default, Gemini as an alternative, and a deterministic fake for tests (no
 * network, no key, same input always gives the same vector) so indexing and search are testable
 * without spending money or needing a key in CI.
 */
export interface EmbedResult {
  readonly vectors: Float32Array[];
  readonly inputUnits: number;
  readonly costUsd: number;
}

export interface EmbeddingsProvider {
  readonly name: string;
  readonly model: string;
  readonly dim: number;
  /** Embed a batch of texts in one call. Throws on a non-retryable error; retried by the caller on 429/5xx. */
  embed(texts: readonly string[]): Promise<EmbedResult>;
}

export class RetryableEmbedError extends Error {
  override name = 'RetryableEmbedError';
}

/** Retry with exponential backoff and jitter, for 429s and transient 5xxs (D161). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof RetryableEmbedError) || i === attempts - 1) throw err;
      const delay = baseMs * 2 ** i * (0.5 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/** A batch small enough that one request stays well within provider token and size limits. */
export const EMBED_BATCH_SIZE = 64;

export async function embedInBatches(provider: EmbeddingsProvider, texts: readonly string[]): Promise<EmbedResult> {
  const vectors: Float32Array[] = [];
  let inputUnits = 0;
  let costUsd = 0;
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const result = await withRetry(() => provider.embed(batch));
    vectors.push(...result.vectors);
    inputUnits += result.inputUnits;
    costUsd += result.costUsd;
  }
  return { vectors, inputUnits, costUsd };
}
