import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { intToRoman } from '../text/titles';
import { sentenceSpans, textWords } from '../text/words';
import { chapterIndexAt } from './chapters';
import {
  type AlignedSentence,
  AUDIO_SYNC_TOLERANCE_MS,
  type ForcedAlignment,
  type ForcedInput,
  MAX_HEARD_BETWEEN,
  type TextSection,
  type TranscriptTrack,
  type TranscriptWord,
  chaptersHeard,
  forceAlign,
  matchWords,
  refineAudioSync,
  refineTextSync,
  sentenceAt,
  simplifyTiePoints,
  tracksOpenWith,
  withChapterOpenings,
  withinChapters,
} from './forced';
import { assertValidSyncMap, linearSyncMap, mToT, syncMapFromTiePoints, tToM } from './syncmap';

/** Deterministic noise (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCABULARY = (
  'alice rabbit queen hatter dormouse tea garden door key bottle cake little large small curious ' +
  'tired sister bank book pictures conversations daisy chain pleasure trouble getting up picking ' +
  'white pink eyes ran close remarkable nor way hear say dear late thought afterwards occurred ' +
  'wondered seemed quite natural actually took watch waistcoat pocket looked hurried started feet ' +
  'flashed across mind never before seen either burning curiosity field after fortunately just time ' +
  'see pop down large hole under hedge another moment went how world get out again'
).split(' ');

/** A made-up book: chapters of sentences, as section texts with paragraph breaks. */
function makeBook(seed: number, chapters: number, sentencesPerChapter: number): TextSection[] {
  const rnd = random(seed);
  const sections: TextSection[] = [];
  for (let c = 0; c < chapters; c++) {
    let text = `CHAPTER ${['I', 'II', 'III', 'IV', 'V', 'VI'][c]}.\n`;
    const breaks = [0, text.length - 1];
    for (let s = 0; s < sentencesPerChapter; s++) {
      if (s % 4 === 0) breaks.push(text.length);
      const n = 6 + Math.floor(rnd() * 14);
      const words = Array.from({ length: n }, () => VOCABULARY[Math.floor(rnd() * VOCABULARY.length)]!);
      words[0] = words[0]![0]!.toUpperCase() + words[0]!.slice(1);
      text += `${words.join(' ')}${rnd() < 0.2 ? '?' : '.'} `;
      if (s % 4 === 3) {
        breaks.push(text.length - 1);
        text += '\n';
      }
    }
    sections.push({ text, breaks });
  }
  return sections;
}

interface Truth {
  /** True start time (cumulative ms) of every sentence, by its text start. */
  readonly sentenceMs: Map<number, number>;
  readonly tracks: TranscriptTrack[];
}

/**
 * What a recogniser would hear if a narrator read the book, one track per chapter: an
 * introduction, every word at a known time (with pauses after sentences), some words missed or
 * misheard, and a closing line. Returns the transcript and the true time of every sentence.
 */
function narrate(sections: readonly TextSection[], seed: number, noise: { drop: number; swap: number }): Truth {
  const rnd = random(seed);
  const sentenceMs = new Map<number, number>();
  const tracks: TranscriptTrack[] = [];
  let base = 0;
  let offset = 0;
  for (const section of sections) {
    const words: TranscriptWord[] = [];
    let at = 1500;
    for (const w of 'this is a recording in the public domain read by a volunteer'.split(' ')) {
      words.push([at, at + 250, w, 0.9]);
      at += 300;
    }
    at += 800;
    const sentences = sentenceSpans(section.text, section.breaks);
    for (const s of sentences) {
      sentenceMs.set(base + s.start, offset + at);
      for (const w of textWords(section.text.slice(s.start, s.end))) {
        const duration = 200 + Math.floor(rnd() * 250);
        const r = rnd();
        if (r >= noise.drop) words.push([at, at + duration, r < noise.drop + noise.swap ? 'mumble' : w.norm, 0.8]);
        at += duration + 60;
      }
      at += 500;
    }
    for (const w of 'end of chapter'.split(' ')) {
      words.push([at, at + 250, w, 0.9]);
      at += 300;
    }
    const durationMs = at + 2000;
    tracks.push({ durationMs, words });
    base += section.text.length;
    offset += durationMs;
  }
  return { sentenceMs, tracks };
}

function bookInput(sections: TextSection[], tracks: TranscriptTrack[]): ForcedInput {
  const total = sections.reduce((n, s) => n + s.text.length, 0);
  return { sections, tracks, story: { start: 0, end: total } };
}

describe('matchWords', () => {
  it('pairs identical sequences one to one', () => {
    const a = 'the quick brown fox jumps over the lazy dog again and again'.split(' ');
    expect([...matchWords(a, a)]).toEqual(a.map((_, i) => i));
  });

  it('pairs the words both sides share, around insertions, omissions and misheard words', () => {
    const a = 'alice was beginning to get very tired of sitting by her sister on the bank'.split(' ');
    const b = 'chapter one alice was beginning to get vary tired sitting by her sister on the bank thank you'.split(' ');
    const m = matchWords(a, b);
    const pairs = [...m].map((j, i) => (j >= 0 ? `${a[i]}=${b[j]}` : null)).filter(Boolean);
    expect(pairs).toEqual([
      'alice=alice', 'was=was', 'beginning=beginning', 'to=to', 'get=get', 'very=vary', 'tired=tired',
      'sitting=sitting', 'by=by', 'her=her', 'sister=sister', 'on=on', 'the=the', 'bank=bank',
    ]);
  });

  it('keeps pairs in order on both sides, even with repeated phrases', () => {
    const rnd = random(7);
    const a = Array.from({ length: 3000 }, () => VOCABULARY[Math.floor(rnd() * 40)]!);
    const b = a.flatMap((w, i) => (i % 97 === 0 ? ['um', w] : i % 53 === 0 ? [] : [w]));
    const m = matchWords(a, b);
    let last = -1;
    let matched = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i]! < 0) continue;
      expect(m[i]!).toBeGreaterThan(last);
      expect(b[m[i]!]).toBe(a[i]);
      last = m[i]!;
      matched++;
    }
    expect(matched / a.length).toBeGreaterThan(0.95);
  });

  it('matches nothing to speech that is not in the text', () => {
    const a = 'down the rabbit hole she went and never once considered how in the world she was to get out'.split(' ');
    const b = Array.from({ length: 600 }, (_, i) => `noise${i % 50}`);
    expect([...matchWords(a, b)].every((j) => j === -1)).toBe(true);
  });
});

describe('forceAlign', () => {
  const sections = makeBook(11, 4, 60);
  const truth = narrate(sections, 5, { drop: 0.05, swap: 0.05 });
  const result = forceAlign(bookInput(sections, truth.tracks));

  it('times every sentence within a word of when it is read', () => {
    expect(result.stats.alignedSentences).toBe(result.stats.sentences);
    for (const s of result.sentences) {
      const ms = truth.sentenceMs.get(s.m);
      expect(ms).toBeDefined();
      expect(Math.abs(s.ms - ms!)).toBeLessThanOrEqual(500);
    }
  });

  it('reports sentences in reading order with increasing times, inside their tracks', () => {
    for (let i = 1; i < result.sentences.length; i++) {
      const a = result.sentences[i - 1]!;
      const b = result.sentences[i]!;
      expect(b.m).toBeGreaterThan(a.m);
      expect(b.ms).toBeGreaterThan(a.ms);
      expect(a.msEnd).toBeLessThanOrEqual(b.ms);
    }
    for (const s of result.sentences) {
      const track = result.tracks[s.track]!;
      expect(s.ms).toBeGreaterThanOrEqual(track.startMs);
      expect(s.ms).toBeLessThan(track.endMs);
      expect(s.trackMs).toBeCloseTo(s.ms - track.startMs, 6);
      expect(sections[s.section]!.text.slice(s.offset, s.offset + s.length).length).toBe(s.length);
    }
  });

  it('counts what matched, per track and overall', () => {
    expect(result.tracks.every((t) => t.aligned)).toBe(true);
    expect(result.stats.matchedWords / result.stats.textWords).toBeGreaterThan(0.85);
    expect(result.tracks.reduce((n, t) => n + t.spokenWords, 0)).toBe(result.stats.spokenWords);
  });

  it('leaves out a track that does not match the text, and keeps the others', () => {
    const tracks = truth.tracks.map((t, i) =>
      i === 2 ? { durationMs: t.durationMs, words: t.words.map(([a, b], k): TranscriptWord => [a, b, `static${k % 30}`, 0.2]) } : t,
    );
    const out = forceAlign(bookInput(sections, tracks));
    expect(out.tracks.map((t) => t.aligned)).toEqual([true, true, false, true]);
    expect(out.sentences.some((s) => s.track === 2)).toBe(false);
    expect(out.sentences.filter((s) => s.track === 3).length).toBeGreaterThan(50);
  });

  it('only aligns the story range', () => {
    const story = { start: sections[0]!.text.length, end: sections[0]!.text.length + sections[1]!.text.length };
    const out = forceAlign({ sections, tracks: truth.tracks, story });
    expect(out.sentences.length).toBeGreaterThan(50);
    for (const s of out.sentences) {
      expect(s.m).toBeGreaterThanOrEqual(story.start);
      expect(s.mEnd).toBeLessThanOrEqual(story.end);
    }
  });

  it('splits a recognised token that holds several words, sharing its time', () => {
    const text: TextSection = { text: 'CHAPTER IV. The year was 1865 and the rabbit hole was deep, very deep indeed, deeper than any well. She fell for a long time.', breaks: [] };
    const words: TranscriptWord[] = [];
    let at = 0;
    for (const w of ['Chapter', '4.', 'The', 'year', 'was', '1865', 'and', 'the', 'rabbit-hole', 'was', 'deep,', 'very', 'deep', 'indeed,', 'deeper', 'than', 'any', 'well.', 'She', 'fell', 'for', 'a', 'long', 'time.']) {
      words.push([at, at + 300, w]);
      at += 350;
    }
    const out = forceAlign({ sections: [text], story: { start: 0, end: text.text.length }, tracks: [{ durationMs: at + 1000, words }] });
    expect(out.stats.matchedWords).toBe(out.stats.textWords);
    // A heading's numeral ends a sentence (only a single capital is taken for an initial).
    expect(out.sentences.map((s) => text.text.slice(s.offset, s.offset + s.length))).toEqual([
      'CHAPTER IV.',
      'The year was 1865 and the rabbit hole was deep, very deep indeed, deeper than any well.',
      'She fell for a long time.',
    ]);
    expect(out.sentences[1]!.ms).toBe(2 * 350);
    expect(out.sentences[2]!.ms).toBe(18 * 350);
  });
});

describe('refineAudioSync and refineTextSync', () => {
  const sections = makeBook(23, 4, 50);
  const truth = narrate(sections, 9, { drop: 0.04, swap: 0.04 });
  const input = bookInput(sections, truth.tracks);
  const alignment = forceAlign(input);
  const totalChars = input.story.end;
  const totalMs = truth.tracks.reduce((n, t) => n + t.durationMs, 0);
  const textSync = linearSyncMap(0, totalChars);
  // The chapter-level map: each track starts its chapter, linear inside.
  const chapterStartsT: number[] = [];
  const trackStarts: number[] = [];
  let m = 0;
  let ms = 0;
  sections.forEach((s, i) => {
    chapterStartsT.push(mToT(textSync, m));
    trackStarts.push(ms);
    m += s.text.length;
    ms += truth.tracks[i]!.durationMs;
  });
  const chapterMap = syncMapFromTiePoints([...trackStarts.map((x, i) => ({ m: x, t: chapterStartsT[i]! })), { m: totalMs, t: 1 }]);

  it('puts every sentence of the audiobook where the text has it, to within the tolerance', () => {
    const refined = refineAudioSync(alignment, textSync, chapterMap, totalMs);
    assertValidSyncMap(refined);
    const tolT = (AUDIO_SYNC_TOLERANCE_MS + 500) / totalMs;
    let chapterWorst = 0;
    for (const [sentenceM, trueMs] of truth.sentenceMs) {
      const want = mToT(textSync, sentenceM);
      expect(Math.abs(mToT(refined, trueMs) - want)).toBeLessThan(tolT);
      chapterWorst = Math.max(chapterWorst, Math.abs(mToT(chapterMap, trueMs) - want));
    }
    // The chapter-level map, which it replaces, was much further off.
    expect(chapterWorst).toBeGreaterThan(tolT * 3);
    // And it needs far fewer tie points than there are sentences.
    expect(refined.points.length).toBeLessThan(truth.sentenceMs.size * 2);
  });

  it('keeps the chapter map in a track that did not align', () => {
    const tracks = truth.tracks.map((t, i) =>
      i === 1 ? { durationMs: t.durationMs, words: t.words.map(([a, b], k): TranscriptWord => [a, b, `static${k % 30}`]) } : t,
    );
    const broken = forceAlign(bookInput(sections, tracks));
    const refined = refineAudioSync(broken, textSync, chapterMap, totalMs);
    assertValidSyncMap(refined);
    const inside = trackStarts[1]! + (trackStarts[2]! - trackStarts[1]!) / 2;
    expect(mToT(refined, inside)).toBeCloseTo(mToT(chapterMap, inside), 6);
  });

  const chapters = chapterStartsT.map((t, i) => ({ title: `Chapter ${i + 1}`, t }));
  const exact = (s: AlignedSentence) => mToT(textSync, s.m);
  const rough = (s: AlignedSentence) => mToT(chapterMap, s.ms);

  it('keeps an honest alignment whole: every sentence stays inside its chapter', () => {
    const kept = withinChapters(alignment, chapters, exact, rough);
    expect(kept.tracks.map((t) => t.aligned)).toEqual(alignment.tracks.map((t) => t.aligned));
    expect(kept.sentences).toHaveLength(alignment.sentences.length);
  });

  it('does not trust a transcript that hears the whole book in the last minutes of the recording', () => {
    // Every word "spoken" in the final 100 seconds: it matches the text perfectly, at the wrong time.
    const all = truth.tracks.flatMap((t) => t.words);
    const last = truth.tracks.length - 1;
    const end = truth.tracks[last]!.durationMs;
    const crafted = truth.tracks.map((t, i): TranscriptTrack =>
      i === last ? { durationMs: t.durationMs, words: all.map(([, , w], k): TranscriptWord => [end - 100_000 + (k * 100_000) / all.length, end - 100_000 + ((k + 0.5) * 100_000) / all.length, w]) } : { durationMs: t.durationMs, words: [] },
    );
    const fooled = forceAlign(bookInput(sections, crafted));
    expect(fooled.sentences.length).toBeGreaterThan(0);
    const kept = withinChapters(fooled, chapters, exact, rough);
    expect(kept.tracks.every((t) => !t.aligned)).toBe(true);
    expect(kept.sentences).toEqual([]);
    // So the chapter map stays: nobody's notes move.
    const refined = refineAudioSync(kept, textSync, chapterMap, totalMs);
    expect(mToT(refined, totalMs - 50_000)).toBeCloseTo(mToT(chapterMap, totalMs - 50_000), 6);
  });

  it('refines the text instead when the audiobook defines the timeline', () => {
    const audioSync = linearSyncMap(0, totalMs);
    const textChapterMap = syncMapFromTiePoints([
      ...sections.map((_, i) => ({ m: sections.slice(0, i).reduce((n, s) => n + s.text.length, 0), t: trackStarts[i]! / totalMs })),
      { m: totalChars, t: 1 },
    ]);
    const refined = refineTextSync(alignment, audioSync, textChapterMap, totalChars);
    assertValidSyncMap(refined);
    for (const [sentenceM, trueMs] of truth.sentenceMs) {
      expect(Math.abs(mToT(refined, sentenceM) - trueMs / totalMs)).toBeLessThan((AUDIO_SYNC_TOLERANCE_MS + 1000) / totalMs);
    }
  });

  it('maps a reader’s sentence back to the moment it is read', () => {
    const refined = refineAudioSync(alignment, textSync, chapterMap, totalMs);
    const [sentenceM, trueMs] = [...truth.sentenceMs][77]!;
    expect(Math.abs(tToM(refined, mToT(textSync, sentenceM)) - trueMs)).toBeLessThan(AUDIO_SYNC_TOLERANCE_MS + 500);
  });

  it('falls back to the chapter map when nothing aligned', () => {
    const silent = forceAlign(bookInput(sections, truth.tracks.map((t) => ({ durationMs: t.durationMs, words: [] }))));
    expect(silent.sentences).toEqual([]);
    expect(refineAudioSync(silent, textSync, chapterMap, totalMs)).toBe(chapterMap);
  });
});

describe('a recording lined up with the story only, never its front matter (FR154)', () => {
  // Gutenberg's Jekyll and Hyde as its story range holds it: a title page and the book's own
  // contents (every chapter's heading), then the chapters, each opening with its heading.
  const headings = ['STORY OF THE DOOR', 'SEARCH FOR MR. HYDE', 'HENRY JEKYLL’S FULL STATEMENT OF THE CASE'];
  const front = `The Strange Case Of Dr. Jekyll And Mr. Hyde\nby Robert Louis Stevenson\nContents\n${headings.join('\n')}\n`;
  const frontBreaks = [0, ...[...front.matchAll(/\n/g)].map((m) => m.index)];
  const chapters = makeBook(31, 3, 40).map((section, c) => {
    // Each chapter's heading is its title, as Gutenberg's Jekyll sets it.
    const text = section.text.replace(/^CHAPTER [IV]+\./, headings[c]!);
    const shift = text.length - section.text.length;
    return { text, breaks: [0, headings[c]!.length, ...section.breaks.slice(2).map((b) => b + shift)] };
  });
  const sections: TextSection[] = [{ text: front, breaks: frontBreaks }, ...chapters];
  // LibriVox's preamble, before each chapter: what the recording is, and the book's title and author.
  const preamble = (c: number) =>
    `chapter ${['one', 'two', 'three'][c]} of the strange case of doctor jekyll and mister hyde this is a librivox recording all librivox recordings are in the public domain the strange case of dr jekyll and mr hyde by robert louis stevenson`.split(' ');
  const tracks: TranscriptTrack[] = chapters.map((section, c) => {
    const words: TranscriptWord[] = [];
    let at = 0;
    for (const w of [...preamble(c), ...textWords(section.text).map((x) => x.norm)]) {
      words.push([at, at + 280, w]);
      at += 330;
    }
    return { durationMs: at + 2000, words };
  });
  const total = sections.reduce((n, x) => n + x.text.length, 0);
  const story = { start: 0, end: total };
  const unread = [{ start: 0, end: front.length }];
  const where = (s: AlignedSentence) => sections[s.section]!.text.slice(s.offset, s.offset + s.length);

  it('leaves the title page and the contents alone: each track starts with its chapter’s heading', () => {
    const aligned = forceAlign({ sections, story, unread, tracks });
    expect(aligned.sentences.some((s) => s.section === 0)).toBe(false);
    expect(aligned.tracks.every((t) => t.aligned)).toBe(true);
    for (let c = 0; c < 3; c++) expect(where(aligned.sentences.find((s) => s.track === c)!)).toBe(headings[c]);
    // The read-along's first sentence comes after the preamble, at the heading.
    const first = aligned.sentences[0]!;
    expect(first.trackMs).toBeGreaterThan(preamble(0).length * 330 - 1000);
    // In whatever order the stretches come (a book's contents need not list in reading order).
    const split = forceAlign({ sections, story, unread: [{ start: 60, end: front.length }, { start: 0, end: 60 }], tracks });
    expect(split.sentences).toEqual(aligned.sentences);
  });

  it('heard against the front matter too, the preamble lands on the title page (as it did)', () => {
    const aligned = forceAlign({ sections, story, tracks });
    expect(aligned.sentences.some((s) => s.section === 0 && s.track === 0)).toBe(true);
  });

  it('puts the recording’s opening words at its first sentence, not on the title page, and keeps its later tracks’ edges', () => {
    const aligned = forceAlign({ sections, story, unread, tracks });
    const textSync = linearSyncMap(0, total);
    const totalMs = tracks.reduce((n, t) => n + t.durationMs, 0);
    // No chapter matched (a straight line), as LibriVox's numbered files face Jekyll's titled chapters.
    const straight = linearSyncMap(0, totalMs);
    const refined = refineAudioSync(aligned, textSync, straight, totalMs);
    assertValidSyncMap(refined);
    const heading = mToT(textSync, front.length);
    expect(mToT(refined, 0)).toBeCloseTo(heading, 9);
    expect(mToT(refined, 10_000)).toBeCloseTo(heading, 9);
    // From the story's first sentence on, the map follows the narrator.
    expect(mToT(refined, aligned.sentences[0]!.ms + 60_000)).toBeGreaterThan(heading);
    // An opening longer than a recording's announcement keeps the fallback's start.
    const late = aligned.sentences.map((s) => ({ ...s, ms: s.ms + 120_000, msEnd: s.msEnd + 120_000, trackMs: s.trackMs + 120_000 }));
    const lateMap = refineAudioSync({ ...aligned, sentences: late, tracks: aligned.tracks.map((t, i) => (i === 0 ? { ...t, endMs: t.endMs + 120_000 } : { ...t, startMs: t.startMs + 120_000, endMs: t.endMs + 120_000 })) }, textSync, linearSyncMap(0, totalMs + 120_000), totalMs + 120_000);
    expect(mToT(lateMap, 0)).toBe(0);
  });
});

describe('where a recording is heard to start each chapter (FR152)', () => {
  // Four chapters on two tracks, two each, as LibriVox's "Chapters 01 to 02" files hold them.
  const sections = makeBook(41, 4, 30);
  // Every heading heard (a heading missed is the second test's).
  const truth = narrate(sections, 13, { drop: 0, swap: 0 });
  const joined = (a: TranscriptTrack, b: TranscriptTrack): TranscriptTrack => ({
    durationMs: a.durationMs + b.durationMs,
    words: [...a.words, ...b.words.map(([x, y, w, p]): TranscriptWord => [x + a.durationMs, y + a.durationMs, w, p])],
  });
  const tracks = [joined(truth.tracks[0]!, truth.tracks[1]!), joined(truth.tracks[2]!, truth.tracks[3]!)];
  const total = sections.reduce((n, x) => n + x.text.length, 0);
  const textSync = linearSyncMap(0, total);
  const starts = sections.map((_, i) => sections.slice(0, i).reduce((n, x) => n + x.text.length, 0));
  const chapters = starts.map((m, i) => ({ title: `CHAPTER ${i + 1}`, t: mToT(textSync, m) }));
  const aligned = forceAlign({ sections, story: { start: 0, end: total }, tracks });

  it('is the moment its heading is heard, in the track it is heard in', () => {
    const heard = chaptersHeard(aligned, chapters, textSync);
    expect(heard.map(([c, track]) => [c, track])).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
    // Each within a word of when it is read, in its track's own time.
    const trackOf = [0, 0, truth.tracks[0]!.durationMs + truth.tracks[1]!.durationMs, 0];
    heard.forEach(([c, , ms]) => {
      const inTrack = truth.sentenceMs.get(starts[c]!)! - (c >= 2 ? trackOf[2]! : 0);
      expect(Math.abs(ms - inTrack)).toBeLessThanOrEqual(500);
    });
  });

  it('is not known for a chapter whose opening was not heard', () => {
    // The second track heard nothing: chapters 3 and 4 have no start heard.
    const deaf = forceAlign({ sections, story: { start: 0, end: total }, tracks: [tracks[0]!, { durationMs: tracks[1]!.durationMs, words: [] }] });
    expect(chaptersHeard(deaf, chapters, textSync).map(([c]) => c)).toEqual([0, 1]);
    // Nor where its first sentence lined up lies further into it than its heading and opening line.
    const late = { sentences: aligned.sentences.filter((s) => s.section !== 1 || s.offset > 400) };
    expect(chaptersHeard(late, chapters, textSync).map(([c]) => c)).toEqual([0, 2, 3]);
  });
});

/** A book's text as sections whose every line is a block (a heading, its name, a paragraph). */
function linesAsBlocks(text: string): TextSection {
  return { text, breaks: [...text.matchAll(/\n/g)].map((m) => m.index) };
}

/** Words said one after another, a third of a second each, from `at` ms. */
function said(words: readonly string[], at: number): TranscriptWord[] {
  return words.map((w, i): TranscriptWord => [at + i * 330, at + i * 330 + 280, w]);
}

/** A book of chapters a section each, `chapters` its chapter starts on a straight timeline, and the chapter map of tracks one chapter each. */
function bookOf(sections: readonly TextSection[], tracks: readonly TranscriptTrack[]) {
  const total = sections.reduce((n, s) => n + s.text.length, 0);
  const textSync = linearSyncMap(0, total);
  const sectionStarts = sections.map((_, i) => sections.slice(0, i).reduce((n, s) => n + s.text.length, 0));
  const chapters = sectionStarts.map((m, i) => ({ title: `CHAPTER ${intToRoman(i + 1).toUpperCase()}.`, t: mToT(textSync, m) }));
  const trackStarts = tracks.map((_, i) => tracks.slice(0, i).reduce((n, t) => n + t.durationMs, 0));
  const totalMs = tracks.reduce((n, t) => n + t.durationMs, 0);
  const chapterMap = syncMapFromTiePoints([...trackStarts.map((m, i) => ({ m, t: chapters[i]!.t })), { m: totalMs, t: 1 }]);
  /** Lined up as the server lines it up: placed inside the chapter map's chapters, then the chapters' openings (FR160). */
  const lineUp = (alignment: ForcedAlignment) =>
    withChapterOpenings(
      withinChapters(alignment, chapters, (s) => mToT(textSync, s.m), (s) => mToT(chapterMap, s.ms)),
      chapters,
      textSync,
    );
  const text = (s: AlignedSentence) => sections[s.section]!.text.slice(s.offset, s.offset + s.length);
  return { total, textSync, sectionStarts, chapters, trackStarts, totalMs, chapterMap, lineUp, text, story: { start: 0, end: total } };
}

describe('the LibriVox Alice: its closing words are not the next chapter’s heading (FR160)', () => {
  // What the recogniser heard in the demo's LibriVox recording (twelve tracks, a chapter each), and
  // the book's text: Gutenberg's, a section a chapter as the EPUB has it, its heading and name on
  // lines of their own.
  const transcript = JSON.parse(readFileSync(new URL('../../../../fixtures/align/librivox-alice.transcript.json', import.meta.url), 'utf8')) as { tracks: TranscriptTrack[] };
  const raw = readFileSync(new URL('../../../../fixtures/text/alice-gutenberg-11.txt', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const end = lines.findIndex((l) => l.startsWith('*** END OF THE PROJECT GUTENBERG EBOOK'));
  const starts = lines.flatMap((l, i) => (/^CHAPTER [IVXLC]+\.$/.test(l) ? [i] : []));
  const sections = starts.map((start, c) => {
    const paragraphs = lines.slice(start + 2, starts[c + 1] ?? end).join('\n').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').replace(/_/g, '').trim()).filter((p) => p.length > 0);
    return linesAsBlocks(`\n${lines[start]!.trim()}\n${lines[start + 1]!.trim()}\n\n${paragraphs.join('\n\n')}\n`);
  });
  const tracks = transcript.tracks.map(({ durationMs, words }) => ({ durationMs, words }));
  const book = bookOf(sections, tracks);
  const { chapters, textSync, trackStarts } = book;
  const found = forceAlign({ sections, story: book.story, tracks });
  const aligned = book.lineUp(found);

  it('heard "End of chapter 1. Read by… 2005" at the first track’s end and "2." to open the second: "CHAPTER II." is said by neither', () => {
    // The words the reviewer's read-along had heading the second chapter (the check that this can fail).
    expect(tracks[0]!.words.filter(([at]) => at >= 632_500).map(([, , w]) => w).slice(0, 4)).toEqual(['of', 'chapter', '1.', 'Read']);
    expect(tracks[1]!.words[0]![2]).toBe('2.');
    expect(found.sentences.some((s) => s.track === 0 && s.section === 1)).toBe(false);
    expect(found.sentences.some((s) => book.text(s) === 'CHAPTER II.')).toBe(false);
  });

  it('hears each chapter start in its own track, in its opening: no chapter twice', () => {
    const heard = chaptersHeard(aligned, chapters, textSync);
    expect(heard.map(([c, track]) => [c, track])).toEqual(chapters.map((_, c) => [c, c]));
    for (const [, , ms] of heard) expect(ms).toBeLessThan(60_000);
    expect(tracksOpenWith(aligned, chapters, textSync)).toEqual(chapters.map((_, c) => c));
  });

  it('leaves the credits unaligned: the first track’s read-along ends with chapter I’s last sentence', () => {
    const first = aligned.sentences.filter((s) => s.track === 0);
    expect(book.text(first[first.length - 1]!)).toBe('So she set to work, and very soon finished off the cake.');
    expect(aligned.sentences.some((s) => s.track === 0 && s.section === 1)).toBe(false);
    const two = aligned.sentences.find((s) => s.section === 1)!;
    expect([book.text(two), two.track]).toEqual(['The Pool of Tears', 1]);
    // A sentence of chapter III heard to its end in its track, its last word ("story") matched in the
    // next one's preamble ("Miette’s bedtime story"): timed in its own track, all of it.
    const close = aligned.sentences.filter((s) => s.track === 2).at(-1)!;
    expect(book.text(close)).toMatch(/^In a little while, however, she again heard/);
    expect(close.msEnd).toBeLessThanOrEqual(trackStarts[3]!);
  });

  it('keeps every track’s closing words in the chapter it ends, and each chapter’s start in its own track, on the map', () => {
    const refined = refineAudioSync(aligned, textSync, book.chapterMap, book.totalMs);
    assertValidSyncMap(refined);
    for (let k = 1; k < tracks.length; k++) {
      const end = trackStarts[k]!;
      const last = aligned.sentences.filter((s) => s.track === k - 1).at(-1)!;
      for (const ms of [last.msEnd + 100, (last.msEnd + end) / 2, end - 100]) expect(chapterIndexAt(chapters, mToT(refined, ms)), `track ${k - 1} at ${ms - trackStarts[k - 1]!}`).toBe(k - 1);
      // Listening from a chapter's start plays its own track, not the credits before it.
      expect(tToM(refined, chapters[k]!.t)).toBeGreaterThanOrEqual(end);
    }
  });

  it('drops a heading the track before’s credits were heard as, as before: the chapter starts in the track saying its text', () => {
    // The read-along of round 18: "CHAPTER II." at 633,300 ms of the first track, "chapter" and "two" heard.
    const heading = sections[1]!.text.indexOf('CHAPTER II.');
    const m = book.sectionStarts[1]! + heading;
    const phantom: AlignedSentence = { m, mEnd: m + 11, section: 1, offset: heading, length: 11, ms: 633_300, msEnd: 634_160, track: 0, trackMs: 633_300, words: 2, matched: 2 };
    const before = { ...aligned, sentences: [...aligned.sentences.filter((s) => s.m < m), phantom, ...aligned.sentences.filter((s) => s.m > m)] };
    const two = aligned.sentences.find((s) => s.section === 1)!;
    expect(chaptersHeard(before, chapters, textSync)[1]).toEqual([1, 1, Math.round(two.trackMs)]);
    expect(withChapterOpenings(before, chapters, textSync).sentences).toEqual(aligned.sentences);
  });
});

describe('a track’s closing words heard as the next chapter’s heading (FR160)', () => {
  /** A book of three chapters, and the words read of each: its heading and text, or only its text. */
  const book = makeBook(43, 3, 30).map((s) => linesAsBlocks(s.text));
  const body = (c: number) => textWords(book[c]!.text).filter((w) => w.start > book[c]!.text.indexOf('\n')).map((w) => w.norm);
  const track = (words: readonly string[]): TranscriptTrack => ({ durationMs: 1000 + words.length * 330 + 2000, words: said(words, 1000) });

  it('as the LibriVox Alice: "End of chapter 1. Read by… 2005", then "2." or nothing: the heading is said by neither', () => {
    const closing = 'end of chapter one read by krista mcquillan tokyo japan november fifteen two thousand five'.split(' ');
    const words = book.flatMap((s) => textWords(s.text).map((w) => w.norm));
    const chapterTwo = words.findIndex((w, i) => w === 'chapter' && words[i + 1] === 'two');
    // The second track opening with the heading heard as "2." (in two tracks), or with its text (in
    // the credits, eleven words apart).
    for (const opening of [['two'], []]) {
      const tracks = [track(['chapter', 'one', ...body(0), ...closing]), track([...opening, ...body(1)]), track(['chapter', 'three', ...body(2)])];
      // The words its heading is matched with: "chapter" and "two", one in the first track's credits
      // (the check that this can fail).
      const heard = tracks.flatMap((t) => t.words.map(([, , w]) => w));
      const match = matchWords(words, heard);
      expect([heard[match[chapterTwo]!], heard[match[chapterTwo + 1]!]]).toEqual(['chapter', 'two']);
      expect(match[chapterTwo]!).toBeLessThan(tracks[0]!.words.length);
      expect(match[chapterTwo + 1]! - match[chapterTwo]! - 1).toBeGreaterThan(MAX_HEARD_BETWEEN);
      const { chapters, textSync, text, story } = bookOf(book, tracks);
      const found = forceAlign({ sections: book, story, tracks });
      expect(found.sentences.some((s) => s.section === 1 && s.track === 0), `opening ${opening.join(' ')}`).toBe(false);
      expect(found.sentences.some((s) => text(s) === 'CHAPTER II.')).toBe(false);
      expect(chaptersHeard(found, chapters, textSync).map(([c, t]) => [c, t])).toEqual([[0, 0], [1, 1], [2, 2]]);
    }
  });

  it('as LibriVox’s Time Machine: "End of chapter nine. Read by the White family." heard as "The Trap of the White Sphinx"', () => {
    // The book's second chapter opens "XIII." and its name, which its narrator never reads: he says
    // the recording's own count, "chapter ten".
    const named = book.map((s, c) => (c === 1 ? linesAsBlocks(s.text.replace('CHAPTER II.\n', 'XIII.\nThe Trap of the White Sphinx\n')) : s));
    const closing = 'end of chapter nine read by the white family'.split(' ');
    const tracks = [track(['chapter', 'one', ...body(0), ...closing]), track(['chapter', 'ten', ...body(1)]), track(['chapter', 'eleven', ...body(2)])];
    const { chapters, textSync, lineUp, text, story } = bookOf(named, tracks);
    const found = forceAlign({ sections: named, story, tracks });
    // Its name heard a moment before the first track ends (the check that this can fail).
    const name = found.sentences.find((s) => text(s) === 'The Trap of the White Sphinx');
    expect(name?.track).toBe(0);
    expect(chaptersHeard(found, chapters, textSync).map(([c, t]) => [c, t])).toEqual([[0, 0], [1, 1], [2, 2]]);
    // Lined up, its chapter's text is heard in the next track: the name in the credits is none of it.
    const aligned = lineUp(found);
    expect(aligned.sentences.some((s) => s.section === 1 && s.track === 0)).toBe(false);
    expect(aligned.sentences.filter((s) => s.track === 0).at(-1)!.section).toBe(0);
    const heard = chaptersHeard(aligned, chapters, textSync);
    const opening = aligned.sentences.find((s) => s.section === 1)!;
    expect(heard[1]).toEqual([1, 1, Math.round(opening.trackMs)]);
    expect(opening.trackMs).toBeLessThan(2000);
  });

  it('keeps a chapter starting at a track’s end with its first lines there: what is said of it there is its', () => {
    // The first track reads the second chapter's heading and first paragraph, the second the rest.
    const second = textWords(book[1]!.text).map((w) => w.norm);
    const cut = 60;
    const tracks = [track([...textWords(book[0]!.text).map((w) => w.norm), ...second.slice(0, cut)]), track([...second.slice(cut)]), track(textWords(book[2]!.text).map((w) => w.norm))];
    const { chapters, textSync, lineUp, story } = bookOf(book, tracks);
    const aligned = lineUp(forceAlign({ sections: book, story, tracks }));
    expect(chaptersHeard(aligned, chapters, textSync).map(([c, t]) => [c, t])).toEqual([[0, 0], [1, 0], [2, 2]]);
    expect(aligned.sentences.filter((s) => s.section === 1 && s.track === 0).length).toBeGreaterThan(2);
    // The second track goes on with the chapter: it opens with it, as the first opens with its own.
    expect(tracksOpenWith(aligned, chapters, textSync)).toEqual([0, 1, 2]);
  });

  it('opens a track heard as nothing with no chapter', () => {
    const tracks = [track(textWords(book[0]!.text).map((w) => w.norm)), { durationMs: 60_000, words: [] }, track(textWords(book[2]!.text).map((w) => w.norm))];
    const { chapters, textSync, lineUp, story } = bookOf(book, tracks);
    expect(tracksOpenWith(lineUp(forceAlign({ sections: book, story, tracks })), chapters, textSync)).toEqual([0, null, 2]);
  });

  it('moves a track’s closing words with its last sentence only when the next track goes on from there, and only for a moment', () => {
    const closing = 'end of chapter one read by a volunteer'.split(' ');
    const tracks = [track([...textWords(book[0]!.text).map((w) => w.norm), ...closing]), track(textWords(book[1]!.text).map((w) => w.norm)), track(textWords(book[2]!.text).map((w) => w.norm))];
    const b = bookOf(book, tracks);
    const aligned = b.lineUp(forceAlign({ sections: book, story: b.story, tracks }));
    const refined = refineAudioSync(aligned, b.textSync, b.chapterMap, b.totalMs);
    const last = aligned.sentences.filter((s) => s.track === 0).at(-1)!;
    expect(mToT(refined, b.trackStarts[1]! - 10)).toBeCloseTo(mToT(b.textSync, last.mEnd), 12);
    // Two minutes of the track after its last sentence lined up are reading the recogniser missed:
    // spread over the text up to the next track's first sentence, as before.
    const long = tracks.map((t, i) => (i === 0 ? { ...t, durationMs: t.durationMs + 120_000 } : t));
    const l = bookOf(book, long);
    const alignedLong = l.lineUp(forceAlign({ sections: book, story: l.story, tracks: long }));
    const refinedLong = refineAudioSync(alignedLong, l.textSync, l.chapterMap, l.totalMs);
    expect(mToT(refinedLong, l.trackStarts[1]! - 10)).toBeGreaterThan(mToT(l.textSync, last.mEnd) + 1e-6);
  });
});

describe('simplifyTiePoints', () => {
  it('drops points on a straight line and keeps the corners', () => {
    const points = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((m) => ({ m, t: m < 4 ? m / 10 : 0.4 + (m - 4) / 40 }));
    const out = simplifyTiePoints(points, 0.01, 1);
    expect(out.map((p) => p.m)).toEqual([0, 4, 8]);
  });

  it('keeps every point another point would be too far from', () => {
    const rnd = random(3);
    const points = Array.from({ length: 400 }, (_, i) => ({ m: i * 1000, t: (i + rnd() * 0.8) / 400 }));
    points.sort((a, b) => a.m - b.m);
    for (let i = 1; i < points.length; i++) if (points[i]!.t < points[i - 1]!.t) points[i] = { ...points[i]!, t: points[i - 1]!.t };
    const tScale = 1 / 400_000;
    const out = simplifyTiePoints(points, 500, tScale);
    const map = { points: out };
    for (const p of points) expect(Math.abs(mToT(map, p.m) - p.t)).toBeLessThanOrEqual(500 * tScale + 1e-12);
    expect(out.length).toBeLessThan(points.length);
  });

  it('returns short lists as they are', () => {
    expect(simplifyTiePoints([{ m: 0, t: 0 }, { m: 1, t: 1 }], 1, 1)).toEqual([{ m: 0, t: 0 }, { m: 1, t: 1 }]);
  });
});

describe('sentenceAt', () => {
  const list = [{ trackMs: 1000 }, { trackMs: 4000 }, { trackMs: 9000 }];
  it('finds the sentence being read', () => {
    expect(sentenceAt(list, 0)).toBeNull();
    expect(sentenceAt(list, 1000)).toBe(list[0]);
    expect(sentenceAt(list, 3999)).toBe(list[0]);
    expect(sentenceAt(list, 4000)).toBe(list[1]);
    expect(sentenceAt(list, 60_000)).toBe(list[2]);
    expect(sentenceAt([], 10)).toBeNull();
  });
});
