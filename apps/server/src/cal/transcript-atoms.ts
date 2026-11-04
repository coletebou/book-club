import { type ChunkAtom } from '@bookclub/shared';
import { type TranscriptTrackRow } from '../repos/readalong';

/**
 * An audiobook's transcript as atoms for Cal's chunker (D160), each placed on the edition's own
 * measure: a track's start plus the word's time. Words are grouped into sentence-sized atoms by
 * sentence-ending punctuation, since a transcript has no paragraph breaks of its own; a long
 * silence (3 s+) also ends one, in case the recogniser never emits one (music, a chapter change
 * with no terminal punctuation heard). Pure, so that it runs in a worker thread (the align worker's
 * `transcript-atoms` task): a 16-hour audiobook is hundreds of thousands of words.
 */
export function transcriptAtoms(tracks: readonly TranscriptTrackRow[], trackIndex: ReadonlyMap<string, number>, starts: readonly number[]): ChunkAtom[] {
  const atoms: ChunkAtom[] = [];
  for (const track of tracks) {
    const idx = trackIndex.get(track.blobId);
    if (idx === undefined) continue;
    const base = starts[idx] ?? 0;
    let words: { text: string; startMs: number; endMs: number }[] = [];
    let lastEnd = 0;
    const flush = () => {
      if (words.length === 0) return;
      const text = words.map((w) => w.text).join(' ');
      atoms.push({ text, m: base + words[0]!.startMs, mEnd: base + words[words.length - 1]!.endMs });
      words = [];
    };
    for (const [startMs, endMs, word] of track.words) {
      if (words.length > 0 && startMs - lastEnd > 3000) flush();
      words.push({ text: word, startMs, endMs });
      lastEnd = endMs;
      if (/[.!?]["')\]]?$/.test(word)) flush();
    }
    flush();
  }
  return atoms;
}
