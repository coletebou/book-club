import { describe, expect, it } from 'vitest';
import { closeApp, fileOf, makeEpub, makeTestApp, setupOwner, uploadBook } from '../../test/helpers';
import { clientFor } from './anthropic';
import { OpenAiEmbeddingsProvider } from './embeddings/openai';

/**
 * The one real-provider smoke test (D161, D160): indexes a short chapter with real OpenAI
 * embeddings and asks the real Claude API a question about it. Skipped entirely without both
 * `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in the environment — no key is ever read from a repo
 * file, and this test never prints either. Everything else in this suite uses the deterministic
 * fake provider (embeddings/fake.ts, cal/fake-model.ts); this is the only test that spends money.
 */
const hasKeys = Boolean(process.env.OPENAI_API_KEY) && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!hasKeys)('Cal real-provider smoke test', () => {
  it('indexes a chapter with real OpenAI embeddings and answers a real Claude question about it', async () => {
    const t = await makeTestApp({ CAL_EMBEDDING_PROVIDER: 'openai', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!, OPENAI_API_KEY: process.env.OPENAI_API_KEY! });
    try {
      const { owner, club } = await setupOwner(t);
      const chapter =
        '<p>' +
        'The White Rabbit trotted slowly back again, looking anxiously about as it went, as if it had lost something; ' +
        'and Alice heard it muttering to itself, "The Duchess! The Duchess! Oh my dear paws! Oh my fur and whiskers! ' +
        'She\'ll get me executed, as sure as ferrets are ferrets! Where CAN I have dropped them, I wonder?"' +
        '</p>';
      const file = fileOf('alice-chapter.epub', makeEpub([chapter], { title: 'Alice Excerpt', author: 'Lewis Carroll' }), 'main', 'application/epub+zip');
      const { bookId } = await uploadBook(owner, club.id, 'epub', [file], { title: 'Alice Excerpt', author: 'Lewis Carroll' });
      await t.settle();

      const chunk = t.ctx.db.get<{ id: string; text: string }>('SELECT id, text FROM cal_chunks WHERE book_id = ?', [bookId]);
      expect(chunk).toBeDefined();
      const embedding = t.ctx.db.get('SELECT 1 FROM cal_embeddings WHERE chunk_id = ?', [chunk!.id]);
      expect(embedding).toBeDefined();

      const embeddings = new OpenAiEmbeddingsProvider(process.env.OPENAI_API_KEY!);
      const { vectors } = await embeddings.embed(['What is the White Rabbit worried about?']);
      expect(vectors[0]!.length).toBe(embeddings.dim);

      const client = clientFor(t.ctx.config)!;
      const response = await client.messages.create({
        model: t.ctx.config.CAL_MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: `Read this passage and answer in one sentence: who is the White Rabbit afraid of?\n\n${chunk!.text}` }],
      });
      const text = response.content.find((b) => b.type === 'text');
      expect(text).toBeDefined();
      expect((text as { text: string }).text.toLowerCase()).toContain('duchess');
    } finally {
      await closeApp(t);
    }
  }, 60_000);
});
