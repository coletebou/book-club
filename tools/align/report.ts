/**
 * Align a transcript (tools/align/transcribe.py) to an EPUB and print what matched, per track, and
 * for each chapter a track reads, the share of its words matched (the measure for a transcript of
 * some chapters only; docs/ALIGNMENT.md).
 *   apps/server/node_modules/.bin/tsx tools/align/report.ts book.epub transcript.json [sentences.json]
 * With a third argument, writes every aligned sentence (text and times) there, for spotcheck.py.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { bodyTextWithBreaks, buildPublication } from '../../packages/epub/src/index.ts';
import {
  type TranscriptTrack,
  alignUnitsToChapters,
  forceAlign,
  linearSyncMap,
  mToT,
  prettifyTrackTitle,
  syncMapFromAlignment,
  tToM,
  textWords,
} from '../../packages/shared/src/index.ts';

const [epubPath, transcriptPath, outPath] = process.argv.slice(2);
if (!epubPath || !transcriptPath) {
  console.error('usage: report.ts book.epub transcript.json [sentences.json]');
  process.exit(2);
}
const pub = buildPublication(new Uint8Array(readFileSync(epubPath)));
const decoder = new TextDecoder();
const sections = pub.sections.map((s) => bodyTextWithBreaks(decoder.decode(pub.files.get(s.path))));
const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as { tracks: (TranscriptTrack & { file: string })[] };
const began = performance.now();
const result = forceAlign({ sections, story: pub.story, tracks: transcript.tracks });
const took = performance.now() - began;
const { stats } = result;
console.log(`text words ${stats.textWords}, heard ${stats.spokenWords}, matched ${stats.matchedWords} (${((100 * stats.matchedWords) / stats.textWords).toFixed(1)} % of the text)`);
console.log(`sentences ${stats.sentences}, aligned ${stats.alignedSentences} (${((100 * stats.alignedSentences) / stats.sentences).toFixed(1)} %), in ${took.toFixed(0)} ms`);
result.tracks.forEach((t, i) => {
  const n = result.sentences.filter((s) => s.track === i).length;
  console.log(`  track ${String(i + 1).padStart(2)} ${transcript.tracks[i]!.file}: heard ${t.spokenWords}, matched ${t.matchedWords} (${((100 * t.matchedWords) / Math.max(1, t.spokenWords)).toFixed(0)} %), ${t.aligned ? 'aligned' : 'NOT aligned'}, ${n} sentences`);
});
// The chapter-level map the app uses without alignment, computed by the app's own code: the
// EPUB defines the timeline (linear over its story) and its chapters, and the tracks are matched
// to those chapters (pipeline.ts placeOnTimeline).
const textSync = linearSyncMap(pub.story.start, pub.story.end);
const sectionStarts: number[] = [];
let at = 0;
for (const s of pub.sections) {
  sectionStarts.push(at);
  at += s.textLength;
}
const chapters: { title: string; t: number }[] = [];
const chapterStarts: number[] = [];
let lastM = -1;
for (const e of pub.toc) {
  const m = sectionStarts[e.section]! + e.offset;
  if (m < pub.story.start || m >= pub.story.end) continue;
  const chapter = { title: e.title, t: mToT(textSync, m) };
  if (m === lastM) chapters[chapters.length - 1] = chapter;
  else {
    chapters.push(chapter);
    chapterStarts.push(m);
  }
  lastM = m;
}
{
  // Each chapter's words, counted as forceAlign counts the text's; a track reads the chapter its
  // middle aligned sentence is in.
  const chapterAt = (m: number) => {
    let c = -1;
    while (c + 1 < chapterStarts.length && chapterStarts[c + 1]! <= m) c++;
    return c;
  };
  const chapterWords = chapterStarts.map(() => 0);
  let base = 0;
  for (const s of sections) {
    for (const w of textWords(s.text, base)) {
      const c = w.start >= pub.story.start && w.end <= pub.story.end ? chapterAt(w.start) : -1;
      if (c >= 0) chapterWords[c]!++;
    }
    base += s.text.length;
  }
  let words = 0;
  let matched = 0;
  result.tracks.forEach((t, i) => {
    const mine = result.sentences.filter((s) => s.track === i);
    const c = mine.length > 0 ? chapterAt(mine[Math.floor(mine.length / 2)]!.m) : -1;
    if (c < 0) return;
    words += chapterWords[c]!;
    matched += t.matchedWords;
    console.log(`  track ${String(i + 1).padStart(2)} reads ${chapters[c]!.title}: matched ${t.matchedWords} of its ${chapterWords[c]} words (${((100 * t.matchedWords) / chapterWords[c]!).toFixed(1)} %)`);
  });
  if (words > 0) console.log(`the chapters heard: ${words} words, of which matched ${matched} (${((100 * matched) / words).toFixed(1)} %)`);
}
const trackStarts: number[] = [];
let ms = 0;
for (const t of transcript.tracks) {
  trackStarts.push(ms);
  ms += t.durationMs;
}
const units = transcript.tracks.map((t, i) => ({ title: prettifyTrackTitle(undefined, t.file), m: trackStarts[i]! }));
const alignment = alignUnitsToChapters(chapters, units, { start: 0, end: ms });
const chapterMap = syncMapFromAlignment(chapters, units, alignment, { start: 0, end: ms });
const baselineMs = (track: number, m: number) => tToM(chapterMap, mToT(textSync, m)) - trackStarts[track]!;
{
  const errors = result.sentences.map((s) => Math.abs(baselineMs(s.track, s.m) - s.trackMs) / 1000).sort((a, b) => a - b);
  const q = (p: number) => errors[Math.min(errors.length - 1, Math.floor(p * errors.length))]!.toFixed(1);
  console.log(`chapter-level map (${alignment.method}, ${alignment.pairs.length} tracks paired) against the alignment: median ${q(0.5)} s, p90 ${q(0.9)} s, p95 ${q(0.95)} s, max ${errors[errors.length - 1]!.toFixed(1)} s`);
}
if (outPath) {
  const out = result.sentences.map((s) => ({
    track: s.track,
    file: transcript.tracks[s.track]!.file,
    startMs: Math.round(s.trackMs),
    endMs: Math.round(s.msEnd - (s.ms - s.trackMs)),
    words: s.words,
    matched: s.matched,
    baselineMs: Math.round(baselineMs(s.track, s.m)),
    text: sections[s.section]!.text.slice(s.offset, s.offset + s.length).replace(/\s+/g, ' '),
  }));
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`wrote ${out.length} sentences to ${outPath}`);
}
