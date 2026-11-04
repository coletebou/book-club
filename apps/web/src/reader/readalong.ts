import type { ReadAlongTrack } from '@bookclub/shared';

/** One sentence of a read-along: where it is in the text, when it is read in its track. */
export interface Sentence {
  readonly index: number;
  readonly section: number;
  readonly offset: number;
  readonly length: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export function sentencesOf(track: ReadAlongTrack | undefined): Sentence[] {
  if (!track) return [];
  return track.sentences.map(([section, offset, length, startMs, endMs], index) => ({ index, section, offset, length, startMs, endMs, text: track.text[index] ?? '' }));
}

/** The sentence being read at `ms` of the track (the last one started), or -1 before the first. */
export function sentenceIndexAt(sentences: readonly Sentence[], ms: number): number {
  let lo = 0;
  let hi = sentences.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid]!.startMs <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * How far into a sentence the narrator is, as a text offset: its start plus the share of its
 * length that matches the share of its time gone (for turning the page mid-sentence).
 */
export function offsetNow(sentence: Sentence, ms: number): number {
  const span = Math.max(1, sentence.endMs - sentence.startMs);
  const share = Math.min(1, Math.max(0, (ms - sentence.startMs) / span));
  return sentence.offset + Math.floor(sentence.length * share);
}

/** A place in the text: a section and an offset in it. */
export interface TextPlace {
  readonly section: number;
  readonly offset: number;
}

/**
 * Where the narrator is in the text (D184):
 * - `reading`: a sentence (the last one started: between two sentences the one just read stays
 *   marked), and how far into it, as a text offset;
 * - `before`: not yet in the text — the opening credits, a track's announcement, a track that is
 *   all credits — with the place the text begins (`lead`), and the sentence that begins it when
 *   this track holds it;
 * - `after`: past the last sentence the audiobook reads (the closing credits);
 * - `loading`: the track's read-along has not arrived yet.
 */
export type Narration =
  | { readonly state: 'reading'; readonly sentence: Sentence; readonly offset: number }
  | { readonly state: 'before'; readonly lead: TextPlace | null; readonly next: Sentence | null }
  | { readonly state: 'after'; readonly previous: TextPlace | null }
  | { readonly state: 'loading' };

export function narrationAt(track: ReadAlongTrack | undefined, sentences: readonly Sentence[], ms: number): Narration {
  if (!track) return { state: 'loading' };
  const i = sentenceIndexAt(sentences, ms);
  if (i >= 0) return { state: 'reading', sentence: sentences[i]!, offset: offsetNow(sentences[i]!, ms) };
  const first = sentences[0];
  // Before this track's first sentence, or a track that reads none: the text begins at its lead
  // (a response from an older server has no lead: this track's own first sentence, if any).
  const lead = track.lead === undefined ? (first ? { section: first.section, offset: first.offset } : null) : track.lead ? { section: track.lead[0], offset: track.lead[1] } : null;
  if (lead) return { state: 'before', lead, next: first ?? null };
  return { state: 'after', previous: track.previous ? { section: track.previous[0], offset: track.previous[1] } : null };
}

/**
 * Where the pages go while following the narrator: the narrated place while reading; before the
 * text, the page where it begins (the story's first page during the opening credits), so it is
 * already open when the narrator starts; after it, nowhere (the page stays).
 */
export function followTarget(narration: Narration): TextPlace | null {
  if (narration.state === 'reading') return { section: narration.sentence.section, offset: narration.offset };
  if (narration.state === 'before') return narration.lead;
  return null;
}

/** Whether a place is on a page: the page's section, from its first offset up to (not including) the next page's. */
export function onPage(place: TextPlace, page: { readonly section: number; readonly start: number; readonly end: number; readonly last: boolean }): boolean {
  return place.section === page.section && place.offset >= page.start && (place.offset < page.end || (page.last && place.offset <= page.end));
}
