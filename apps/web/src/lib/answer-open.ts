import { type Chapter, type CommentView, chapterNameAt, formatPercent } from '@bookclub/shared';

/*
 * An answer held for where its writer had read to (D69) opens once you have read that far. It is
 * said, as it would otherwise open without a word, to those in its conversation only: its note's
 * writer and whoever answered the note, the people the server tells of answers (D49). To them it
 * names the conversation: whose note, and where (D89).
 */

/** What the reader is told of: the answer now open, and the note it answers. */
export interface AnswerOpen {
  readonly answer: CommentView;
  readonly note: CommentView;
}

/** Whether someone is in a note's conversation: they wrote the note, or answered it. */
export function inConversation(note: Pick<CommentView, 'id' | 'userId'>, comments: readonly Pick<CommentView, 'parentId' | 'userId'>[], userId: string | undefined): boolean {
  if (!userId) return false;
  return note.userId === userId || comments.some((c) => c.parentId === note.id && c.userId === userId);
}

/** Where a note is, as a phrase: "in Chapter 3", "before Chapter 1" (the front matter), "at 24%". */
export function wherePhrase(chapters: readonly Chapter[], t: number): string {
  const name = chapterNameAt(chapters, t);
  if (!name) return `at ${formatPercent(t)}`;
  return name.startsWith('Before ') ? `before ${name.slice('Before '.length)}` : `in ${name}`;
}

/** "Ana’s answer to Cole’s note in Chapter 3 is open now." To its note's writer, "to your note". */
export function answerOpenText({ answer, note }: AnswerOpen, selfId: string | undefined, chapters: readonly Chapter[]): string {
  const whose = note.userId === selfId ? 'your' : note.userId === answer.userId ? 'their own' : `${note.authorName}’s`;
  return `${answer.authorName}’s answer to ${whose} note ${wherePhrase(chapters, note.t)} is open now.`;
}
