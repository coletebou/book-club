import { type Config } from '../../config';
import { type EmbeddingsProvider } from './provider';
import { FakeEmbeddingsProvider } from './fake';
import { GeminiEmbeddingsProvider } from './gemini';
import { OpenAiEmbeddingsProvider } from './openai';

export * from './provider';
export { FakeEmbeddingsProvider } from './fake';

/** The configured embeddings provider, or null when its key is missing (indexing then stays queued). */
export function embeddingsProviderFor(config: Config): EmbeddingsProvider | null {
  switch (config.CAL_EMBEDDING_PROVIDER) {
    case 'fake':
      return new FakeEmbeddingsProvider();
    case 'openai':
      return config.OPENAI_API_KEY ? new OpenAiEmbeddingsProvider(config.OPENAI_API_KEY, config.OPENAI_EMBEDDING_MODEL) : null;
    case 'gemini':
      return config.GOOGLE_API_KEY ? new GeminiEmbeddingsProvider(config.GOOGLE_API_KEY, config.GOOGLE_EMBEDDING_MODEL) : null;
  }
}
