import type Anthropic from '@anthropic-ai/sdk';
import { stopLabel } from '@bookclub/shared';
import { type AppContext } from '../context';
import { type BookRow, bookChapters } from '../repos/books';
import { clientFor, estimateChatCostUsd } from './anthropic';
import { logCost } from './store';

/**
 * Cal's discussion questions for a meet-up (D209). He is given the book's own text up to the stop
 * the club agreed to read to, never a word past it (its indexed chunks that end by the stop, the
 * latest last, at most EXCERPT_CHARS of them), and told to treat the end of that text as the end of
 * everything he knows about the book, because a well-known book's later events may be in what the
 * model already knows. The questions it writes are then gated like any friend's (placed at the
 * stop), so they reach only friends who have read that far.
 */

/** How much of the book, up to the stop, he reads: about 15,000 tokens, the latest part. */
export const EXCERPT_CHARS = 60_000;
/** How many questions one ask brings. */
export const QUESTIONS_PER_ASK = 5;

/** The slice of the Anthropic client used here: a seam so tests and the demo give a deterministic stand-in. */
export interface QuestionModel {
  create(params: {
    model: string;
    max_tokens: number;
    thinking: { type: 'adaptive' };
    output_config: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
    system: string;
    messages: Anthropic.MessageParam[];
  }): Promise<Pick<Anthropic.Message, 'content' | 'usage'>>;
}

export class NoTextError extends Error {}

interface ExcerptChunk {
  text: string;
  chapter_title: string | null;
}

/** The text the club has agreed to read, up to the stop: the latest `EXCERPT_CHARS` of it, in reading order. */
export function excerptToStop(ctx: AppContext, book: BookRow, stopT: number): string {
  // The reference edition's chunks if it has any, else a text edition's, else an audiobook transcript's.
  const editions = ctx.db.all<{ edition_id: string; kind: string }>(
    `SELECT c.edition_id, e.kind FROM cal_chunks c JOIN editions e ON e.id = c.edition_id
      WHERE c.book_id = ? AND c.source_type = 'book' GROUP BY c.edition_id, e.kind`,
    [book.id],
  );
  const rank = (e: { edition_id: string; kind: string }) => (e.edition_id === book.reference_edition_id ? 0 : e.kind === 'epub' ? 1 : e.kind === 'pdf' ? 2 : 3);
  const edition = [...editions].sort((a, b) => rank(a) - rank(b))[0];
  if (!edition) return '';
  // Only what ends by the stop: a chunk across it would carry words from past it.
  const rows = ctx.db.all<ExcerptChunk>('SELECT text, chapter_title FROM cal_chunks WHERE edition_id = ? AND t_end IS NOT NULL AND t_end <= ? ORDER BY seq DESC', [
    edition.edition_id,
    stopT + 1e-9,
  ]);
  const taken: ExcerptChunk[] = [];
  let total = 0;
  for (const row of rows) {
    if (total + row.text.length > EXCERPT_CHARS && taken.length > 0) break;
    taken.push(row);
    total += row.text.length;
  }
  taken.reverse();
  const parts: string[] = [];
  let chapter: string | null = null;
  for (const row of taken) {
    if (row.chapter_title && row.chapter_title !== chapter) {
      chapter = row.chapter_title;
      parts.push(`\n## ${chapter}\n`);
    }
    parts.push(row.text);
  }
  return parts.join('\n').trim();
}

const SYSTEM = `You are Cal (Callimachus), the librarian of a small private book club of friends. You write questions for the club's next meeting.

You are given the book's text up to the place the club agreed to read to, and nothing after it. Rules:
- Ask only about what happens in the text you are given. Never mention, hint at, foreshadow or ask about anything that happens after the end of that text, even if you know this book: the end of the text is the end of everything you know about it.
- No summaries, no quotations longer than a few words, no facts about the author's life that reveal later events.
- Write questions friends who have all read this far would enjoy arguing about: characters' choices, what surprised them, what they expect next and why, how the writing works, how it made them feel.
- Each question is open-ended (not yes or no), one or two sentences, under 200 characters.
- Output exactly the number of questions asked for, one per line, with no numbering, bullets or anything else.`;

/** The questions in a reply: one a line, bullets and numbers gone, short enough, new to the stop. */
export function parseQuestions(text: string, existing: readonly string[], max = QUESTIONS_PER_ASK): string[] {
  const seen = new Set(existing.map((q) => q.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)]|Q\d+[:.)])\s*/i, '').trim();
    if (line.length < 10 || line.length > 400) continue;
    if (!line.endsWith('?')) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A deterministic stand-in for the model (the demo and the tests, `CAL_TEST_FAKE_MODEL`): a question
 * about each of a few sentences of the excerpt it is given, so it can only ever use what it was given.
 */
export class FakeQuestionModel implements QuestionModel {
  create(params: Parameters<QuestionModel['create']>[0]): Promise<Pick<Anthropic.Message, 'content' | 'usage'>> {
    const user = params.messages.find((m) => m.role === 'user');
    const prompt = typeof user?.content === 'string' ? user.content : '';
    const excerpt = prompt.split('<excerpt>')[1]?.split('</excerpt>')[0] ?? '';
    const sentences = excerpt
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 40 && s.length < 160 && !s.startsWith('#'));
    const step = Math.max(1, Math.floor(sentences.length / (QUESTIONS_PER_ASK + 1)));
    const picked = sentences.filter((_, i) => i % step === step - 1).slice(-QUESTIONS_PER_ASK);
    const text = picked.map((s) => `What did you make of the moment that begins “${s.split(' ').slice(0, 8).join(' ')}…”?`).join('\n');
    return Promise.resolve({ content: [{ type: 'text', text, citations: null }] as unknown as Anthropic.ContentBlock[], usage: { input_tokens: 10, output_tokens: 10 } as Anthropic.Usage });
  }
}

export function questionModelFor(ctx: AppContext): QuestionModel | null {
  if (ctx.config.CAL_TEST_FAKE_MODEL) return new FakeQuestionModel();
  const client = clientFor(ctx.config);
  return client ? client.messages : null;
}

/** Ask Cal for questions for the stop at `stopT`: the new ones, already parsed and checked against those there. */
export async function suggestQuestions(
  ctx: AppContext,
  input: { book: BookRow; stopT: number; userId: string; existing: readonly string[]; model: QuestionModel },
): Promise<string[]> {
  const excerpt = excerptToStop(ctx, input.book, input.stopT);
  if (!excerpt) throw new NoTextError('Cal has not read this book yet: he reads each book once its text is in.');
  const label = stopLabel(bookChapters(input.book), input.stopT);
  const author = input.book.author ? ` by ${input.book.author}` : '';
  const content = `The book: "${input.book.title}"${author}. The club is reading to ${label}. Here is the text up to there, the latest part last:

<excerpt>
${excerpt}
</excerpt>

That is the end of the text the club has read: nothing after it exists for you. Write ${QUESTIONS_PER_ASK} questions for the meeting.`;
  const model = ctx.config.CAL_MODEL;
  const reply = await input.model.create({
    model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: ctx.config.CAL_EFFORT },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const fake = ctx.config.CAL_TEST_FAKE_MODEL;
  logCost(ctx.db, {
    clubId: input.book.club_id,
    userId: input.userId,
    kind: 'chat',
    provider: fake ? 'fake' : 'anthropic',
    model,
    inputUnits: reply.usage.input_tokens,
    outputUnits: reply.usage.output_tokens,
    costUsd: fake ? 0 : estimateChatCostUsd(model, reply.usage.input_tokens, reply.usage.output_tokens),
  });
  const text = reply.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return parseQuestions(text, input.existing);
}
