import { type TextSpan, sentenceSpans, textWords } from '../text/words';
import { type ChapterLike } from './chapters';
import { type SyncMap, type TiePoint, mToT, syncMapFromTiePoints, tToM } from './syncmap';

/**
 * Forced alignment of an audiobook to its text (docs/ALIGNMENT.md): which spoken word is which
 * word of the book, and from that, when each sentence is read. Speech recognition, outside the
 * app (tools/align/transcribe.py), supplies the words heard and their times; this module never
 * listens to audio, so it runs the same way on the server and in tests.
 *
 * 1. Both sides become sequences of normalised words.
 * 2. Anchors: runs of words that occur exactly once on each side. The longest chain of anchors in
 *    the same order on both sides is kept; an anchor out of order is a coincidence.
 * 3. Between consecutive anchors the remaining words are paired by a small edit-distance
 *    alignment, looking for new anchors first wherever the stretch is too long for that.
 * 4. Each sentence is read from its first word's time, estimated from the words around it when
 *    that word was not recognised.
 */

/** A recognised word: [start ms, end ms, text, probability], times relative to its track. */
export type TranscriptWord = readonly [number, number, string, number?];

export interface TranscriptTrack {
  readonly durationMs: number;
  readonly words: readonly TranscriptWord[];
}

export interface TextSection {
  /** The section's text measure (the text of its `<body>`). */
  readonly text: string;
  /** Offsets in `text` where a block starts or ends (paragraphs, headings, line breaks). */
  readonly breaks: readonly number[];
}

export interface ForcedInput {
  readonly sections: readonly TextSection[];
  /** The part of the text measure that is the story (a licence appendix is not read aloud). */
  readonly story: { readonly start: number; readonly end: number };
  /**
   * Stretches of the story that are no reading, in order (readingContents' `unread`): its title
   * page's lines, its own printed contents. No recording reads them, and what a narrator says of
   * the book before reading it (LibriVox's "Chapters one to three of The Strange Case of Dr Jekyll
   * and Mr Hyde…") must not be taken for them (FR154).
   */
  readonly unread?: readonly TextSpan[];
  readonly tracks: readonly TranscriptTrack[];
}

export interface AlignedSentence {
  /** Start and end in the text measure (cumulative over sections). */
  readonly m: number;
  readonly mEnd: number;
  readonly section: number;
  /** Start inside its section, and length. */
  readonly offset: number;
  readonly length: number;
  /** Start and end in the audio measure (cumulative milliseconds over tracks). */
  readonly ms: number;
  readonly msEnd: number;
  /** The track it starts in, and the start inside that track. */
  readonly track: number;
  readonly trackMs: number;
  readonly words: number;
  readonly matched: number;
}

export interface TrackAlignment {
  readonly spokenWords: number;
  readonly matchedWords: number;
  /** Enough of the track matched the text for its sentences to be trusted. */
  readonly aligned: boolean;
  readonly startMs: number;
  readonly endMs: number;
}

export interface ForcedAlignment {
  /** Sentences of aligned tracks, in reading order, with increasing times. */
  readonly sentences: readonly AlignedSentence[];
  readonly tracks: readonly TrackAlignment[];
  readonly stats: {
    readonly textWords: number;
    readonly spokenWords: number;
    readonly matchedWords: number;
    readonly sentences: number;
    readonly alignedSentences: number;
  };
}

/** A track is trusted when at least half of what was heard in it is found in the text. */
export const TRACK_MATCH_RATIO = 0.5;
const MIN_TRACK_MATCHES = 20;
/** The longest edit-distance alignment between anchors, in cells. */
const DP_LIMIT = 250_000;
const ANCHOR_WORDS = 4;
/** When nothing better is known, how long a word takes to say. */
const DEFAULT_WORD_MS = 330;
/**
 * Words a recogniser may hear between two words of a sentence that its text does not have there:
 * a filler, a word heard as two, a narrator's stumble. The LibriVox Alice has at most two in any
 * of its 1,643 sentences; "End of chapter 1. Read by Krista McQuillan, Tokyo, Japan, November 15,
 * 2005" has eleven between its "chapter" and the "two" of 2005 (FR160).
 */
export const MAX_HEARD_BETWEEN = 4;

/* ------------------------------------------------------------------------------------------ */
/* Word matching                                                                                */
/* ------------------------------------------------------------------------------------------ */

/** One edit at most, for words of four letters or more: "hole"/"hull" no, "alices"/"alice" yes. */
function nearlyEqual(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Longest chain of pairs increasing in both coordinates (pairs come sorted by `a`). */
function longestChain(pairs: readonly (readonly [number, number])[]): [number, number][] {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const b = pairs[k]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < b) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    tails[lo] = k;
  }
  const out: [number, number][] = [];
  for (let k = tails.length > 0 ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) out.push([pairs[k]![0], pairs[k]![1]]);
  return out.reverse();
}

/** Runs of `n` words found exactly once in each range, as (start in a, start in b), by a. */
function uniqueRuns(a: readonly string[], aLo: number, aHi: number, b: readonly string[], bLo: number, bHi: number, n: number): [number, number][] {
  const key = (w: readonly string[], i: number) => (n === 1 ? w[i]! : w.slice(i, i + n).join(' '));
  const inB = new Map<string, number>();
  for (let j = bLo; j + n <= bHi; j++) {
    const k = key(b, j);
    inB.set(k, inB.has(k) ? -1 : j);
  }
  const inA = new Map<string, number>();
  for (let i = aLo; i + n <= aHi; i++) {
    const k = key(a, i);
    inA.set(k, inA.has(k) ? -1 : i);
  }
  const out: [number, number][] = [];
  for (const [k, i] of inA) {
    if (i < 0 || (n === 1 && k.length < 4)) continue;
    const j = inB.get(k);
    if (j !== undefined && j >= 0) out.push([i, j]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

const MATCH = 2;
const NEAR = 1;
const MISMATCH = -1;
const GAP = -1;

/**
 * Edit-distance alignment of a[aLo, aHi) with b[bLo, bHi), recording equal and nearly equal pairs.
 * A free start or end lets either side begin or end with words the other does not have (the
 * narrator's introduction, a heading nobody reads) at no cost.
 */
function editAlign(
  a: readonly string[], aLo: number, aHi: number,
  b: readonly string[], bLo: number, bHi: number,
  out: Int32Array, freeStart: boolean, freeEnd: boolean,
): void {
  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n === 0 || m === 0) return;
  const w = m + 1;
  const score = new Int32Array((n + 1) * w);
  // 1 = diagonal, 2 = up (skip a word of a), 3 = left (skip a word of b).
  const move = new Uint8Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    score[i * w] = freeStart ? 0 : i * GAP;
    move[i * w] = 2;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = freeStart ? 0 : j * GAP;
    move[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    const ai = a[aLo + i - 1]!;
    for (let j = 1; j <= m; j++) {
      const bj = b[bLo + j - 1]!;
      const pair = ai === bj ? MATCH : nearlyEqual(ai, bj) ? NEAR : MISMATCH;
      let best = score[(i - 1) * w + j - 1]! + pair;
      let dir = 1;
      const up = score[(i - 1) * w + j]! + GAP;
      if (up > best) {
        best = up;
        dir = 2;
      }
      const left = score[i * w + j - 1]! + GAP;
      if (left > best) {
        best = left;
        dir = 3;
      }
      score[i * w + j] = best;
      move[i * w + j] = dir;
    }
  }
  let i = n;
  let j = m;
  if (freeEnd) {
    // The best cell on the last row or column; what lies beyond it is left unmatched.
    let best = score[n * w + m]!;
    for (let k = 0; k <= m; k++) if (score[n * w + k]! > best) [best, i, j] = [score[n * w + k]!, n, k];
    for (let k = 0; k <= n; k++) if (score[k * w + m]! > best) [best, i, j] = [score[k * w + m]!, k, m];
  }
  while (i > 0 && j > 0) {
    const dir = move[i * w + j];
    if (dir === 1) {
      const ai = a[aLo + i - 1]!;
      const bj = b[bLo + j - 1]!;
      if (ai === bj || nearlyEqual(ai, bj)) out[aLo + i - 1] = bLo + j - 1;
      i--;
      j--;
    } else if (dir === 2) i--;
    else j--;
  }
}

function alignRange(
  a: readonly string[], aLo: number, aHi: number,
  b: readonly string[], bLo: number, bHi: number,
  out: Int32Array, freeStart: boolean, freeEnd: boolean, n: number,
): void {
  if (aLo >= aHi || bLo >= bHi) return;
  if ((aHi - aLo) * (bHi - bLo) <= DP_LIMIT) {
    editAlign(a, aLo, aHi, b, bLo, bHi, out, freeStart, freeEnd);
    return;
  }
  // Too long to align word by word: find anchors unique inside this stretch, longer ones first.
  for (let size = n; size >= 1; size--) {
    const chain = longestChain(uniqueRuns(a, aLo, aHi, b, bLo, bHi, size));
    if (chain.length === 0) continue;
    let ai = aLo;
    let bi = bLo;
    let first = true;
    for (const [i, j] of chain) {
      if (i < ai || j < bi) continue; // overlaps the previous anchor
      alignRange(a, ai, i, b, bi, j, out, first && freeStart, false, size);
      for (let k = 0; k < size; k++) out[i + k] = j + k;
      ai = i + size;
      bi = j + size;
      first = false;
    }
    alignRange(a, ai, aHi, b, bi, bHi, out, false, freeEnd, size);
    return;
  }
  // Nothing in common at all: these words do not belong together.
}

/**
 * Pair the words of `a` (the book) with the words of `b` (what was heard): for each word of `a`,
 * the index of its word in `b`, or -1. Pairs increase on both sides.
 */
export function matchWords(a: readonly string[], b: readonly string[]): Int32Array {
  const out = new Int32Array(a.length).fill(-1);
  alignRange(a, 0, a.length, b, 0, b.length, out, true, true, ANCHOR_WORDS);
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Sentences in time                                                                            */
/* ------------------------------------------------------------------------------------------ */

interface Heard {
  readonly norm: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly track: number;
}

/**
 * What was heard, as normalised words with absolute times. A recognised token that becomes
 * several words ("rabbit-hole", "1865") shares out its time by length.
 */
function heardWords(tracks: readonly TranscriptTrack[]): Heard[] {
  const out: Heard[] = [];
  let offset = 0;
  tracks.forEach((track, index) => {
    // Joined, so that context carries across tokens ("CHAPTER" then "IV.").
    let joined = '';
    const spans: { start: number; end: number; word: TranscriptWord }[] = [];
    for (const word of track.words) {
      const start = joined.length;
      joined += word[2];
      spans.push({ start, end: joined.length, word });
      joined += ' ';
    }
    let k = 0;
    for (const w of textWords(joined)) {
      while (k < spans.length - 1 && spans[k]!.end <= w.start) k++;
      const s = spans[k]!;
      const [t0, t1] = s.word;
      const len = Math.max(1, s.end - s.start);
      const from = t0 + ((t1 - t0) * (w.start - s.start)) / len;
      const to = t0 + ((t1 - t0) * (w.end - s.start)) / len;
      out.push({ norm: w.norm, startMs: offset + from, endMs: offset + Math.max(from, to), track: index });
    }
    offset += track.durationMs;
  });
  return out;
}

function lowerBound(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Line the text up with what was heard, and time every sentence of the tracks that matched. */
export function forceAlign(input: ForcedInput): ForcedAlignment {
  const { sections, story, tracks } = input;
  // In the text's order, whatever order the contents gave them in.
  const unread = [...(input.unread ?? [])].sort((a, b) => a.start - b.start);
  const words: { norm: string; start: number; end: number; section: number }[] = [];
  const sentences: { m: number; mEnd: number; section: number; offset: number }[] = [];
  let base = 0;
  // Words come in order: one pass over the stretches no recording reads.
  let skip = 0;
  const read = (start: number) => {
    while (skip < unread.length && unread[skip]!.end <= start) skip++;
    return !(skip < unread.length && unread[skip]!.start <= start);
  };
  sections.forEach((section, index) => {
    for (const w of textWords(section.text, base)) {
      if (w.start >= story.start && w.end <= story.end && read(w.start)) words.push({ ...w, section: index });
    }
    for (const s of sentenceSpans(section.text, section.breaks)) {
      const m = Math.max(base + s.start, story.start);
      const mEnd = Math.min(base + s.end, story.end);
      if (mEnd > m) sentences.push({ m, mEnd, section: index, offset: m - base });
    }
    base += section.text.length;
  });
  const heard = heardWords(tracks);
  const match = matchWords(
    words.map((w) => w.norm),
    heard.map((h) => h.norm),
  );

  const trackStarts: number[] = [];
  let at = 0;
  for (const t of tracks) {
    trackStarts.push(at);
    at += t.durationMs;
  }
  const perTrack = tracks.map(() => ({ spoken: 0, matched: 0 }));
  for (const h of heard) perTrack[h.track]!.spoken++;
  let matchedWords = 0;
  for (const j of match) {
    if (j < 0) continue;
    matchedWords++;
    perTrack[heard[j]!.track]!.matched++;
  }
  const trackInfo: TrackAlignment[] = tracks.map((t, i) => {
    const p = perTrack[i]!;
    return {
      spokenWords: p.spoken,
      matchedWords: p.matched,
      aligned: p.matched >= MIN_TRACK_MATCHES && p.matched >= p.spoken * TRACK_MATCH_RATIO,
      startMs: trackStarts[i]!,
      endMs: trackStarts[i]! + t.durationMs,
    };
  });

  // Average time per word over everything matched: for words the recogniser missed.
  let spanMs = 0;
  for (const j of match) if (j >= 0) spanMs += heard[j]!.endMs - heard[j]!.startMs;
  const wordMs = matchedWords > 0 ? Math.max(120, Math.min(800, spanMs / matchedWords + 60)) : DEFAULT_WORD_MS;

  const starts = words.map((w) => w.start);
  const out: AlignedSentence[] = [];
  let lastMs = -Infinity;
  let lastEnd = -Infinity;
  for (const s of sentences) {
    const first = lowerBound(starts, s.m);
    const last = lowerBound(starts, s.mEnd);
    if (last <= first) continue;
    // A sentence is said in one breath: its words are heard one after another, in one track. Of
    // the runs its matched words make, each going on while the next word is heard in the same
    // track with no more than MAX_HEARD_BETWEEN words between, the longest is where it was read;
    // a word matched further off is a coincidence with what is said there (FR160: the "chapter" of
    // a track's closing "End of chapter 1. Read by…", and the "two" of the next track's opening,
    // were CHAPTER II.).
    let f = -1;
    let l = -1;
    let count = 0;
    let runStart = -1;
    let runEnd = -1;
    let run = 0;
    for (let k = first; k < last; k++) {
      const j = match[k]!;
      if (j < 0) continue;
      const joins = run > 0 && heard[j]!.track === heard[match[runEnd]!]!.track && j - match[runEnd]! - (k - runEnd) <= MAX_HEARD_BETWEEN;
      if (!joins) {
        runStart = k;
        run = 0;
      }
      run++;
      runEnd = k;
      if (run > count) [f, l, count] = [runStart, runEnd, run];
    }
    // One word in common is a coincidence ("End of chapter" heard against the next heading).
    if (f < 0 || count < Math.min(2, last - first)) continue;
    const head = heard[match[f]!]!;
    const tail = heard[match[l]!]!;
    const track = head.track;
    if (!trackInfo[track]!.aligned || head.startMs <= lastMs) continue;
    // Words before the first one heard were said just before it, after the previous sentence.
    const estimate = head.startMs - (f - first) * wordMs;
    const ms = Math.min(head.startMs, Math.max(estimate, lastEnd, trackStarts[track]!));
    // And the words after the last one heard, after it, before its track ends.
    const msEnd = Math.max(ms, Math.min(tail.endMs + (last - 1 - l) * wordMs, trackInfo[track]!.endMs));
    out.push({
      m: s.m,
      mEnd: s.mEnd,
      section: s.section,
      offset: s.offset,
      length: s.mEnd - s.m,
      ms,
      msEnd,
      track,
      trackMs: ms - trackStarts[track]!,
      words: last - first,
      matched: count,
    });
    lastMs = ms;
    lastEnd = msEnd;
  }
  // A sentence ends at the latest when the next one starts.
  for (let k = 0; k + 1 < out.length; k++) {
    const next = out[k + 1]!;
    if (out[k]!.msEnd > next.ms) out[k] = { ...out[k]!, msEnd: Math.max(out[k]!.ms, next.ms) };
  }
  return {
    sentences: out,
    tracks: trackInfo,
    stats: { textWords: words.length, spokenWords: heard.length, matchedWords, sentences: sentences.length, alignedSentences: out.length },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Sync maps from an alignment                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Fewer tie points with the same meaning: a point is dropped when the line between its kept
 * neighbours passes within `tolerance` (in the map's own measure) of where it says that place is.
 */
export function simplifyTiePoints(points: readonly TiePoint[], tolerance: number, tScale: number): TiePoint[] {
  if (points.length <= 2) return [...points];
  // Measured along t, converted to the map's measure by its overall slope.
  const tolT = tolerance * tScale;
  const out: TiePoint[] = [points[0]!];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let good = anchor + 1;
    for (let j = anchor + 2; j < points.length && j - anchor <= 256; j++) {
      const a = points[anchor]!;
      const b = points[j]!;
      let fits = true;
      for (let k = anchor + 1; k < j; k++) {
        const p = points[k]!;
        const onLine = a.t + ((b.t - a.t) * (p.m - a.m)) / (b.m - a.m);
        if (Math.abs(onLine - p.t) > tolT) {
          fits = false;
          break;
        }
      }
      if (!fits) break;
      good = j;
    }
    out.push(points[good]!);
    anchor = good;
  }
  return out;
}

export interface RefineOptions {
  /** Map of the edition that stays as it is (its measure is the other side of each pair). */
  readonly fixed: SyncMap;
  /** The edition's current (chapter-level) map, kept where the alignment is not trusted. */
  readonly fallback: SyncMap;
  /** Extent of the edition being refined. */
  readonly total: number;
  /** How far a simplified tie point may move a sentence, in the refined edition's measure. */
  readonly tolerance: number;
  /**
   * How far into the edition its first sentence may start for what comes before it (a recording's
   * announcement of the book) to be at that sentence's place, not where the fallback puts the
   * edition's start (the story's start, a title page): FR154. Unset, the fallback's place stays.
   */
  readonly opening?: number;
}

/**
 * A refined sync map from pairs of places that say the same words: `x` in the edition being
 * refined, `y` in the fixed one. Inside `trusted` stretches of `x` the pairs decide; elsewhere
 * the fallback map's tie points stay.
 */
export function refineSyncMap(
  pairs: readonly { readonly x: number; readonly y: number }[],
  trusted: readonly TextSpan[],
  options: RefineOptions,
): SyncMap {
  const { fixed, fallback, total, tolerance, opening } = options;
  const inside = (x: number) => trusted.some((r) => x >= r.start && x <= r.end);
  const candidates: TiePoint[] = pairs
    .filter((p) => inside(p.x))
    .map((p) => ({ m: p.x, t: mToT(fixed, p.y) }))
    .sort((a, b) => a.m - b.m);
  const kept = candidates.filter((p, i) => i === 0 || p.m > candidates[i - 1]!.m);
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (!first || !last) return fallback;
  const tScale = (last.t - first.t) / Math.max(1, last.m - first.m);
  const scale = tScale > 0 ? tScale : 1 / Math.max(1, total);
  // Each trusted stretch (a track) on its own: its first and last ties stay, so that where one
  // ends (a track's closing words, at its last sentence: closingPairs) is never smoothed over into
  // the next one's opening, however few characters lie between them.
  const ties: TiePoint[] = [];
  for (let i = 0; i < kept.length; ) {
    const stretch = trusted.find((r) => kept[i]!.m >= r.start && kept[i]!.m <= r.end)!;
    let j = i + 1;
    while (j < kept.length && kept[j]!.m <= stretch.end) j++;
    ties.push(...simplifyTiePoints(kept.slice(i, j), tolerance, scale));
    i = j;
  }
  for (const p of fallback.points) if (!inside(p.m)) ties.push(p);
  // Where a trusted stretch meets an untrusted one (or an end of the edition), the fallback's
  // value at the edge joins them: the untrusted side keeps exactly the fallback map, and an
  // introduction or closing words before the first sentence or after the last stay on the edge.
  for (const r of trusted) {
    const own = kept.filter((p) => p.m >= r.start && p.m <= r.end);
    if (own.length === 0) continue;
    const head = own[0]!;
    const tail = own[own.length - 1]!;
    if (r.start < head.m && !trusted.some((o) => o !== r && o.end === r.start)) {
      // At the edition's very start, words said before its first sentence (an announcement) are
      // at that sentence, when it comes soon enough to be the one the edition opens with.
      const opens = opening !== undefined && r.start <= fallback.points[0]!.m && head.m - r.start <= opening;
      ties.push({ m: r.start, t: opens ? head.t : Math.min(mToT(fallback, r.start), head.t) });
    }
    if (r.end > tail.m && !trusted.some((o) => o !== r && o.start === r.end)) ties.push({ m: r.end, t: Math.max(mToT(fallback, r.end), tail.t) });
  }
  return syncMapFromTiePoints(ties);
}

/**
 * Each sentence's start, and its end where a pause follows (the end is left out when it touches
 * the next start, which would otherwise be dropped as a second point at the same place).
 */
function sentencePairs(
  sentences: readonly AlignedSentence[],
  start: (s: AlignedSentence) => [number, number],
  end: (s: AlignedSentence) => [number, number],
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  sentences.forEach((s, i) => {
    const [x, y] = start(s);
    out.push({ x, y });
    const [xe, ye] = end(s);
    const next = sentences[i + 1];
    if (xe > x && (!next || xe < start(next)[0])) out.push({ x: xe, y: ye });
  });
  return out;
}

/** How long a sync map's tie points may move a sentence of the audiobook: one second. */
export const AUDIO_SYNC_TOLERANCE_MS = 1000;

/**
 * The longest a recording's opening, before the first sentence of the story it reads, may be
 * (LibriVox's preamble runs to half a minute, D93): what it says there is at that sentence (FR154).
 */
export const RECORDING_OPENING_MS = 90_000;

/** Share of a track's sentences that may land outside their chapter before the track is not trusted. */
const OUT_OF_PLACE_SHARE = 0.05;

/**
 * Keep the alignment where the chapter-level map already puts it. A sentence may move inside its
 * chapter (the chapter map is off by tens of seconds there), never to another part of the book:
 * a transcript that does not belong to the recording, or was made up, cannot move notes and places
 * across the book (D47). `exact` places a sentence by the edition the timeline rests on (its text
 * measure for a text reference, its milliseconds for an audio one), `rough` by the chapter map of
 * the edition being refined. Tracks with more than a few sentences out of place are not trusted;
 * a stray sentence elsewhere is dropped.
 */
export function withinChapters(
  alignment: ForcedAlignment,
  chapters: readonly ChapterLike[],
  exact: (s: AlignedSentence) => number,
  rough: (s: AlignedSentence) => number,
): ForcedAlignment {
  const starts = [...new Set(chapters.map((c) => c.t))].sort((a, b) => a - b);
  /** How far a sentence at t may be from its rough place: the length of the chapter it is in. */
  const reach = (t: number) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1]! <= t) i++;
    const start = starts.length > 0 && starts[0]! <= t ? starts[i]! : 0;
    const end = starts.find((x) => x > t) ?? 1;
    return Math.max(end - start, 0.01);
  };
  const outOfPlace = (s: AlignedSentence) => Math.abs(exact(s) - rough(s)) > reach(exact(s));
  const tracks = alignment.tracks.map((track, i) => {
    if (!track.aligned) return track;
    const mine = alignment.sentences.filter((s) => s.track === i);
    const bad = mine.filter(outOfPlace).length;
    return mine.length > 0 && bad / mine.length > OUT_OF_PLACE_SHARE ? { ...track, aligned: false } : track;
  });
  const sentences = alignment.sentences.filter((s) => tracks[s.track]!.aligned && !outOfPlace(s));
  return { ...alignment, tracks, sentences, stats: { ...alignment.stats, alignedSentences: sentences.length } };
}

/**
 * A track's closing words, after its last sentence (LibriVox's "End of chapter 1. Read by…"), are
 * at that sentence's end where the next track goes on from there, its first sentence no further on
 * in the text than a chapter's heading (FR160, D114): the map does not run on across them towards
 * that sentence, into the next chapter's heading, and a place in them is in the chapter the track
 * ends. Within a recording's closing moments only (RECORDING_OPENING_MS, as its opening's): a
 * longer stretch after the last sentence is reading the recogniser missed, and stays spread over
 * the text.
 */
function closingPairs(alignment: ForcedAlignment): { x: number; y: number }[] {
  const { sentences, tracks } = alignment;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < sentences.length; i++) {
    const last = sentences[i]!;
    const next = sentences[i + 1]!;
    if (next.track !== last.track + 1) continue;
    const end = tracks[last.track]!.endMs;
    if (end > last.msEnd && end - last.msEnd <= RECORDING_OPENING_MS && next.m - last.mEnd <= CHAPTER_HEARD_REACH) out.push({ x: end, y: last.mEnd });
  }
  return out;
}

/**
 * The audiobook's sync map after alignment: each sentence's start and end are where the text puts
 * them on the timeline, inside the tracks that aligned (and a track's closing words where its last
 * sentence ends, closingPairs); other tracks keep the chapter map.
 */
export function refineAudioSync(alignment: ForcedAlignment, textSync: SyncMap, audioFallback: SyncMap, totalMs: number): SyncMap {
  const pairs = [...sentencePairs(alignment.sentences, (s) => [s.ms, s.m], (s) => [s.msEnd, s.mEnd]), ...closingPairs(alignment)];
  const trusted = alignment.tracks.filter((t) => t.aligned).map((t) => ({ start: t.startMs, end: t.endMs }));
  return refineSyncMap(pairs, trusted, { fixed: textSync, fallback: audioFallback, total: totalMs, tolerance: AUDIO_SYNC_TOLERANCE_MS, opening: RECORDING_OPENING_MS });
}

/**
 * The text's sync map after alignment, for a book whose timeline the audiobook defines: each
 * sentence is where it is heard. Tolerance is in characters (about one second of reading).
 */
export function refineTextSync(alignment: ForcedAlignment, audioSync: SyncMap, textFallback: SyncMap, totalChars: number): SyncMap {
  const pairs = sentencePairs(alignment.sentences, (s) => [s.m, s.ms], (s) => [s.mEnd, s.msEnd]);
  const trusted: TextSpan[] = [];
  for (const t of alignment.tracks) {
    if (!t.aligned) continue;
    const inTrack = alignment.sentences.filter((s) => s.ms >= t.startMs && s.ms < t.endMs);
    if (inTrack.length > 0) trusted.push({ start: inTrack[0]!.m, end: inTrack[inTrack.length - 1]!.mEnd });
  }
  return refineSyncMap(pairs, trusted, { fixed: audioSync, fallback: textFallback, total: totalChars, tolerance: 15 });
}

/**
 * How far into its chapter, in characters, the first sentence a recording is lined up with may
 * start for the chapter to be heard starting with it: its heading, its subtitle, its opening line.
 */
export const CHAPTER_HEARD_REACH = 300;

/**
 * How many of a chapter's words a track must be heard saying, sentence after sentence from where
 * the chapter starts in it, for the chapter to start there (FR160): its heading and its first
 * lines. A track's closing credits can match a word or two of the next chapter's heading by chance
 * ("End of chapter 9. Recording by James K. White" was "The Trap of the White Sphinx" of The Time
 * Machine, ten seconds before the track's end), the chapter's text going on in the next track. A
 * chapter with fewer words heard needs half of them.
 */
export const CHAPTER_OWN_WORDS = 20;

/** Each of the book's chapters in the text's order: its index, where it starts in the text, and where the next one does. */
function chapterSpans(chapters: readonly ChapterLike[], textSync: SyncMap): { chapter: number; m: number; next: number }[] {
  const order = chapters.map((c, i) => ({ chapter: i, m: tToM(textSync, c.t) })).sort((a, b) => a.m - b.m || a.chapter - b.chapter);
  const out: { chapter: number; m: number; next: number }[] = [];
  let next = Infinity;
  for (let k = order.length - 1; k >= 0; k--) {
    const here = order[k]!;
    out.push({ ...here, next });
    // Several chapters at one place (a part's heading and its first chapter) end where the next place starts.
    if (k > 0 && order[k - 1]!.m < here.m) next = here.m;
  }
  return out.reverse();
}

/** The first of the sentences (in the text's order) starting at `m` or after it. */
function firstFrom(sentences: readonly AlignedSentence[], m: number): number {
  let lo = 0;
  let hi = sentences.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid]!.m < m - 1e-6) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** How a chapter of the book is heard: where it is heard to start, and what of it a track's closing words took. */
interface ChapterOpening {
  readonly chapter: number;
  /** The sentence it is heard starting with, its heading or opening line, or -1. */
  readonly start: number;
  /** Its sentences heard at the end of a track before the one heard saying its text: not its (FR160). */
  readonly stray: readonly number[];
}

/**
 * How each chapter of the book opens in a recording, by its read-along (FR152, FR160, D114): it
 * starts in the track heard saying its text, at the first sentence lined up in it there, where that
 * is its heading or opening line. Its sentences are taken track by track, and its text is the first
 * track's that say CHAPTER_OWN_WORDS of its words (or half of them, for a chapter with fewer
 * heard). What of it an earlier track says, at its end, is that track's closing words heard as the
 * chapter's heading: stray.
 */
function chapterOpenings(alignment: Pick<ForcedAlignment, 'sentences'>, chapters: readonly ChapterLike[], textSync: SyncMap): ChapterOpening[] {
  const { sentences } = alignment;
  return chapterSpans(chapters, textSync).map(({ chapter, m, next }) => {
    const from = firstFrom(sentences, m);
    let to = from;
    let heard = 0;
    while (to < sentences.length && sentences[to]!.m < next) heard += sentences[to++]!.matched;
    const needed = Math.min(CHAPTER_OWN_WORDS, Math.ceil(heard / 2));
    // Sentences come in the order they are heard: each track's of the chapter come together.
    let text = -1;
    for (let run = from; run < to && text < 0; ) {
      const track = sentences[run]!.track;
      let end = run;
      let said = 0;
      while (end < to && sentences[end]!.track === track) said += sentences[end++]!.matched;
      if (said >= needed) text = run;
      run = end;
    }
    const stray: number[] = [];
    for (let k = from; k < text; k++) stray.push(k);
    return { chapter, start: text >= 0 && sentences[text]!.m - m <= CHAPTER_HEARD_REACH ? text : -1, stray };
  });
}

/**
 * The alignment without what a recording's closing words matched of the next chapter's heading
 * (chapterOpenings, FR160): the read-along leaves those words unaligned, and the map does not run
 * to the next chapter across them, rather than tying "End of chapter 1. Read by…" to "CHAPTER II.".
 */
export function withChapterOpenings(alignment: ForcedAlignment, chapters: readonly ChapterLike[], textSync: SyncMap): ForcedAlignment {
  const stray = new Set(chapterOpenings(alignment, chapters, textSync).flatMap((o) => o.stray));
  if (stray.size === 0) return alignment;
  const sentences = alignment.sentences.filter((_, i) => !stray.has(i));
  return { ...alignment, sentences, stats: { ...alignment.stats, alignedSentences: sentences.length } };
}

/**
 * Where a recording is heard to start each chapter of the book, by its read-along (FR152): the
 * first sentence lined up in the chapter, where that is its heading or opening line, in the track
 * heard saying the chapter's text (FR160), as `[chapter (its index), track, ms into the track]`, in
 * the book's order. A chapter whose start was not heard (its track not trusted, its first lines
 * missed) is not there. `textSync` is the map of the text the sentences are placed in, which the
 * book's chapters rest on.
 */
export function chaptersHeard(alignment: Pick<ForcedAlignment, 'sentences'>, chapters: readonly ChapterLike[], textSync: SyncMap): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const { chapter, start } of chapterOpenings(alignment, chapters, textSync)) {
    const s = alignment.sentences[start];
    if (s) out.push([chapter, s.track, Math.round(s.trackMs)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * The chapter of the book each track opens with, by its read-along (FR161): the chapter its first
 * sentence lined up is in, starting there or going on from the track before; null for a track
 * with none (not trusted, or heard as nothing).
 */
export function tracksOpenWith(alignment: Pick<ForcedAlignment, 'sentences' | 'tracks'>, chapters: readonly ChapterLike[], textSync: SyncMap): (number | null)[] {
  const spans = chapterSpans(chapters, textSync);
  const out: (number | null)[] = alignment.tracks.map(() => null);
  const seen = new Set<number>();
  for (const s of alignment.sentences) {
    if (seen.has(s.track)) continue;
    seen.add(s.track);
    // The last chapter starting at its place or before it.
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid]!.m <= s.m + 1e-6) lo = mid + 1;
      else hi = mid;
    }
    out[s.track] = lo > 0 ? spans[lo - 1]!.chapter : null;
  }
  return out;
}

/** The sentence being read at a moment of a track (the last one started), or null. */
export function sentenceAt<T extends { readonly trackMs: number }>(sentences: readonly T[], trackMs: number): T | null {
  let lo = 0;
  let hi = sentences.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid]!.trackMs <= trackMs) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? sentences[lo - 1]! : null;
}
