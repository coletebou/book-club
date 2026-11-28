import { AudioLocatorSchema, locatorToM, mToT, rangesCover, unitStarts, type CarCalBody, type CarCalQuestion, type Span } from '@bookclub/shared';
import { type AppContext } from '../context';
import { fromJson } from '../lib/json';
import { type BookRow, editionById, editionFiles, editionTimeline } from '../repos/books';
import { commentsForBook } from '../repos/comments';
import { progressFor, readingOf } from '../repos/progress';
import { runInWorker } from '../services/aligner';
import { gateFor } from '../services/gating';
import { CalGate } from './gating';

const TEN_MINUTES = 600_000;
const SCENE_WINDOW = 120_000;
const SOURCE_LIMIT = 24;
const CONTENT_LIMIT = 18_000;
const CAR_TRANSCRIPT_LIMITS = { ms: 7_000, heapMb: 256 };

export const CAR_QUESTIONS: Record<CarCalQuestion, string> = {
  recap: 'Recap what I heard in the last ten minutes.',
  scene: 'Who is in this scene?',
  club: 'What did the club say around this part?',
};

export type CarQuestionSource = { readonly kind: 'place-unavailable' } | { readonly kind: 'ready'; readonly read: () => Promise<readonly string[]> };

/** Validate the saved place cheaply before loading the gated source (D245). */
export function sourceForCarQuestion(ctx: AppContext, book: BookRow, userId: string, question: CarCalBody): CarQuestionSource {
  const db = ctx.db;
  const progress = progressFor(db, userId, book.id);
  const edition = editionById(db, question.editionId);
  const timeline = edition?.book_id === book.id ? editionTimeline(edition) : null;
  const current = AudioLocatorSchema.safeParse(fromJson<unknown>(progress?.locator_json ?? null, null));
  if (!timeline || timeline.geometry.kind !== 'audio' || timeline.sync.points.length < 2 || progress?.edition_id !== question.editionId
    || !current.success || current.data.track !== question.locator.track || current.data.ms !== question.locator.ms) {
    return { kind: 'place-unavailable' };
  }
  const sampleMs = locatorToM(timeline.geometry, current.data);
  const fromMs = Math.max(0, sampleMs - (question.question === 'recap' ? TEN_MINUTES : SCENE_WINDOW));

  return { kind: 'ready', read: async () => {
    const reading = readingOf(db, userId, book.id);
    if (question.question === 'club') {
      const start = mToT(timeline.sync, fromMs);
      const end = mToT(timeline.sync, sampleMs);
      if (start >= end) return [];
      const gate = gateFor(db, book);
      const notes = commentsForBook(db, book.id, userId)
        .filter((note) => note.t >= start && note.t <= end)
        .flatMap((note) => {
          const visible = gate.view(note, userId, reading);
          return !visible.hidden && visible.text ? [visible.text] : [];
        });
      return bounded(notes);
    }

    const heard = (reading.byEdition.get(question.editionId) ?? []).map(([from, to]): Span => [
      Math.max(from, fromMs), Math.min(to, sampleMs),
    ]).filter(([from, to]) => from < to);
    if (heard.length === 0) return [];
    // The search index may still use an older alignment. Filter the transcript's original
    // milliseconds before projecting allowed excerpts onto the current book timeline.
    const task = {
      kind: 'transcript-atoms',
      database: ctx.storage.dbFile,
      editionId: question.editionId,
      tracks: editionFiles(db, question.editionId).map((file) => ({ blobId: file.blob_id, idx: file.idx })),
      starts: unitStarts(timeline.geometry),
      window: { heard, maxAtoms: SOURCE_LIMIT, maxChars: CONTENT_LIMIT },
    } as const;
    const { atoms } = await runInWorker(task, CAR_TRANSCRIPT_LIMITS);
    const cal = new CalGate(db, userId, false);
    return bounded(atoms.filter((atom) => rangesCover(heard, atom.m, atom.mEnd) && cal.chunkReadable(book, {
      t_start: mToT(timeline.sync, atom.m),
      t_end: mToT(timeline.sync, atom.mEnd),
    })).map((atom) => atom.text));
  } };
}

function bounded(passages: readonly string[]): string[] {
  let left = CONTENT_LIMIT;
  return passages.slice(-SOURCE_LIMIT).flatMap((text) => {
    if (text.length > left) return [];
    left -= text.length;
    return [text];
  });
}
