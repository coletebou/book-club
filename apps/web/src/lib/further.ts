import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  type BookProgress,
  type Chapter,
  type CommentView,
  type EditionKind,
  type HiddenComment,
  type MemberProgress,
  type Span,
  chapterNameAt,
  formatNames,
  formatPercent,
  rangesContain,
  rangesFurthest,
} from '@bookclub/shared';
import { keys } from './queries';

/*
 * Where you are against a friend's note, as far as this device can tell from your reading: writing
 * from further on than its place (D69), past its place while it is still closed (D63), and past it
 * as it opens.
 */

/**
 * How far past a place, on the timeline, someone must have read for what they write there to wait
 * for friends to read as far (about a page, D69).
 */
export const FURTHER_ON = 0.005;

/** Whether someone who has read to `furthest` writes at `t` from further on: their words wait for friends to read as far (D69). */
export function fromFurtherOn(furthest: number | null | undefined, t: number): boolean {
  return typeof furthest === 'number' && furthest > t + FURTHER_ON;
}

/**
 * The friends who have not read as far as `furthest`, by name, as the club's progress last said:
 * those words written from there would wait for (D69). A friend within FURTHER_ON of it has read as
 * far, as the page in front of you counts as read.
 */
export function notAsFar(members: readonly Pick<MemberProgress, 'userId' | 'displayName' | 'furthest'>[], selfId: string | undefined, furthest: number): string[] {
  return members.filter((m) => m.userId !== selfId && fromFurtherOn(furthest, m.furthest)).map((m) => m.displayName);
}

/** "Ana and Ben have not read as far as you", for the question as you post from further on (D69). */
export function notAsFarLine(names: readonly string[]): string {
  return `${formatNames(names, 3)} ${names.length === 1 ? 'has' : 'have'} not read as far as you`;
}

/**
 * A place as the app names where someone had read to, as the server names a horizon: the chapter
 * of the last place read ("Chapter 12"; read to a chapter's very start is read to the chapter
 * before), else how far into the book.
 */
export function placeName(chapters: readonly Chapter[], t: number): string {
  return chapterNameAt(chapters, Math.max(0, t - 1e-9)) ?? formatPercent(t);
}

/** What you have read of a book on the shared timeline, as this device last heard from the server. */
export function readRangesOf(qc: QueryClient, bookId: string): readonly Span[] | undefined {
  return qc.getQueryData<BookProgress>(keys.progress(bookId))?.mine?.readRanges;
}

/** How a note was made, by its format: "Ben wrote this while listening". */
export const MADE_IN: Readonly<Record<EditionKind, string>> = { epub: 'in the EPUB', pdf: 'in the PDF', audio: 'while listening' };

/**
 * Why a friend's note is closed to you (D63, D69):
 * - `held`: it waits for where its writer had read to (the server names it, `horizon`);
 * - `near`: you have read its place, but it was made in another format, whose map may put its
 *   words a little after where yours does (or its passage runs on): it opens a little further on,
 *   once you are surely past it;
 * - `skipped`: its place is in a part you went past without reading;
 * - `ahead`: you have not read this far.
 */
export type Closed = 'held' | 'near' | 'skipped' | 'ahead';

export function whyClosed(c: Pick<HiddenComment, 'horizon' | 't'>, readRanges: readonly Span[] | undefined): Closed {
  if (c.horizon) return 'held';
  const read = readRanges ?? [];
  if (rangesContain(read, c.t)) return 'near';
  return c.t < rangesFurthest(read) ? 'skipped' : 'ahead';
}

/** A friend's reaction with no words, as the server sends it closed: nothing of it waits but its place. */
export function reactionOnly(c: Pick<HiddenComment, 'hasText' | 'reaction' | 'deleted'>): boolean {
  return !c.hasText && !!c.reaction && !c.deleted;
}

/**
 * What a friend's reaction with no words says while it is closed to you: who reacted with what, as
 * the club bar shows it, made in another format about here if it was (D63), and that it has no
 * words. Nothing more is said to come: there is nothing more (fidelity review round 16).
 */
export function reactionAlone(c: Pick<HiddenComment, 'authorName' | 'reaction' | 'kind'>, why: Closed): string {
  return `${c.authorName} reacted ${c.reaction ?? ''}${why === 'near' ? ` ${MADE_IN[c.kind]}, about` : ''} here, with no words.`;
}

/**
 * What a note closed until you are surely past it says instead of its words (D63): who made it, in
 * which format, that it is about here, and when it opens; nothing else about it. As a line of the
 * note sheet, or as a sentence of the book's discussion. A reaction with no words says only whose
 * and which it is (`reactionAlone`).
 */
export function nearButClosed(c: Pick<HiddenComment, 'authorName' | 'kind' | 'hasText' | 'reaction' | 'deleted'>, style: 'line' | 'sentence' = 'line'): string {
  if (reactionOnly(c)) return reactionAlone(c, 'near');
  const made = `${c.authorName} ${c.hasText ? 'wrote this' : 'reacted'} ${MADE_IN[c.kind]}, about here`;
  const opens = 'it opens a little further on, once you are surely past it';
  return style === 'line' ? `${made} · ${opens}` : `${made}: ${opens}.`;
}

/**
 * Whether a friend's note that has just opened has words to read. A reaction alone has shown all it
 * has from the first (D100): its opening is no news, and is not told.
 */
export function opensWords(c: CommentView): boolean {
  return !c.hidden && !!c.text?.trim();
}

/** What you are told as a friend's note behind you opens: "Ben’s note in Chapter 3 is open now: you are surely past it." */
export function openedBehind(c: Pick<CommentView, 'authorName' | 't'>, was: 'near' | 'held', chapters: readonly Chapter[]): string {
  const where = chapterNameAt(chapters, c.t);
  return `${c.authorName}’s note${where ? ` in ${where}` : ''} is open now: ${was === 'held' ? 'you have read as far as they had' : 'you are surely past it'}.`;
}

/**
 * Tell of friends' notes that open as you read on past them. One closed until you are surely past
 * it (D63), or until you have read as far as its writer had (D69), is behind the page in front of
 * you by the time it opens, where nothing on screen shows it. A note ahead of you opens on the page
 * you read it on, and "I've already read up to here" says what it opened itself.
 */
export function useOpenedBehind(notes: readonly CommentView[], readRanges: readonly Span[] | undefined, tell: (note: CommentView, was: 'near' | 'held') => void): void {
  const closed = useRef(new Map<string, Closed>());
  useEffect(() => {
    for (const c of notes) {
      if (c.hidden) {
        closed.current.set(c.id, whyClosed(c, readRanges));
        continue;
      }
      const was = closed.current.get(c.id);
      closed.current.delete(c.id);
      if ((was === 'near' || was === 'held') && !c.deleted) tell(c, was);
    }
  }, [notes, readRanges, tell]);
}

/** Within this of a note's place, the player is at it: it says a friend left a note here. */
export const CUE_HERE_MS = 4000;

/**
 * Whether the player tells of a friend's note, open to you, that it has played past by `past` ms: as
 * you pass its place (`here`, within CUE_HERE_MS); and one that opened while you listened (one made
 * in another format opens a little after its place, D63) as it opens, however far back it is by
 * then (`back`).
 */
export function noteCue(past: number, openedWhileListening: boolean): 'here' | 'back' | null {
  if (past < 0) return null;
  if (past < CUE_HERE_MS) return 'here';
  return openedWhileListening ? 'back' : null;
}

/** How far back a place heard is, as the player's cue says it: "40 s back", "4 min back", "1 h 5 min back". */
export function howFarBack(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s back`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min back`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h back` : `${h} h ${min % 60} min back`;
}
