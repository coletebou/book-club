import { readFile } from 'node:fs/promises';
import { bodyTextWithBreaks } from '@bookclub/epub';
import { type ChunkAtom, type Publication, isBookList, readingContents, unitStarts } from '@bookclub/shared';
import { PRINTED_FILE, parsePrinted } from '../ingest/pdf';
import { type AppContext } from '../context';
import { type EditionRow, editionFiles, editionTimeline } from '../repos/books';
import { TRANSCRIPT_ATOMS_LIMITS, runInWorker } from '../services/aligner';

type PublicationManifest = Pick<Publication, 'sections'> & Partial<Pick<Publication, 'story' | 'toc' | 'backMatter'>>;

interface TextSpan {
  start: number;
  end: number;
}

interface AtomRun extends TextSpan {
  atoms: ChunkAtom[];
}

/** Separate reading runs at chapter starts and across printed contents, keeping native offsets. */
function epubReadingRuns(manifest: PublicationManifest, starts: readonly number[], marked: TextSpan[], markedSections: Set<number>): AtomRun[] {
  const total = starts.at(-1) ?? 0;
  const story = manifest.story && manifest.story.end > manifest.story.start ? manifest.story : { start: 0, end: total };
  const at = (entry: Publication['toc'][number]) => (starts[entry.section] ?? total) + entry.offset;
  const printedList = (entry: Publication['toc'][number]) => isBookList(entry.chapterTitle ?? entry.title);
  const toc = [...(manifest.toc ?? [])].sort((a, b) => at(a) - at(b) || Number(printedList(b)) - Number(printedList(a)));
  const { listed } = readingContents({ ...manifest, story, toc });
  const reading = new Set(listed);
  const entries = toc.map((entry, index) => ({ entry, index, m: at(entry) }))
    .filter(({ entry, m }) => entry.chapter !== false && m < story.end);
  // D294: marked navigation gives exact offsets. A printed list inferred from the TOC ends
  // in its own document, even when the next entry points at a fragment inside a later one.
  const inferred = entries.flatMap(({ entry, index, m }, i) => {
    if (reading.has(index) || markedSections.has(entry.section) || !printedList(entry)) return [];
    const start = Math.max(m, story.start);
    const end = Math.min(entries[i + 1]?.m ?? story.end, starts[entry.section + 1] ?? total);
    return start < end ? [{ start, end }] : [];
  });
  const unread = [...marked, ...inferred];
  const backStart = manifest.backMatter?.start ?? total;
  if (story.end < backStart) unread.push({ start: story.end, end: backStart });
  if (manifest.backMatter && manifest.backMatter.end < total) unread.push({ start: manifest.backMatter.end, end: total });
  unread.sort((a, b) => a.start - b.start);
  const edges = new Set([story.end, total]);
  for (const index of listed) edges.add(at(toc[index]!));
  for (const span of unread) {
    edges.add(span.start);
    edges.add(span.end);
  }
  const runs: AtomRun[] = [];
  let start = story.start;
  let skip = 0;
  for (const end of [...edges].sort((a, b) => a - b)) {
    if (end <= start || end > total) continue;
    while (unread[skip] && unread[skip]!.end <= start) skip++;
    if (!unread[skip] || unread[skip]!.start >= end) runs.push({ start, end, atoms: [] });
    start = end;
  }
  return runs;
}

/** EPUB blocks clipped to their reading runs, in the edition's original text measure. */
async function epubAtomRuns(ctx: AppContext, edition: EditionRow): Promise<ChunkAtom[][]> {
  const manifestFile = ctx.storage.pubFile(edition.id, '.publication.json');
  if (!manifestFile) return [];
  let manifest: PublicationManifest;
  try {
    manifest = JSON.parse(await readUtf8(manifestFile)) as PublicationManifest;
  } catch {
    return [];
  }
  const timeline = editionTimeline(edition);
  if (!timeline) return [];
  const starts = unitStarts(timeline.geometry);
  const atoms: ChunkAtom[] = [];
  const marked: TextSpan[] = [];
  const markedSections = new Set<number>();
  for (const section of manifest.sections) {
    const base = starts[section.index];
    if (base === undefined) continue;
    const file = ctx.storage.pubFile(edition.id, section.href);
    if (!file) continue;
    let xhtml: string;
    try {
      xhtml = await readUtf8(file);
    } catch {
      continue;
    }
    const { text, breaks, printedNavigation } = bodyTextWithBreaks(xhtml, { printedNavigation: true });
    if (printedNavigation?.length) {
      markedSections.add(section.index);
      for (const { start, end } of printedNavigation) marked.push({ start: base + start, end: base + end });
    }
    let from = 0;
    for (const to of breaks) {
      const piece = text.slice(from, to);
      if (piece.trim().length > 0) atoms.push({ text: piece, m: base + from, mEnd: base + to });
      from = to;
    }
  }
  const runs = epubReadingRuns(manifest, starts, marked, markedSections);
  let runIndex = 0;
  for (const atom of atoms) {
    while (runs[runIndex] && runs[runIndex]!.end <= atom.m) runIndex++;
    for (let i = runIndex; i < runs.length && runs[i]!.start < atom.mEnd; i++) {
      const run = runs[i]!;
      const m = Math.max(atom.m, run.start);
      const mEnd = Math.min(atom.mEnd, run.end);
      if (m === atom.m && mEnd === atom.mEnd) {
        run.atoms.push(atom);
        continue;
      }
      const text = atom.text.slice(m - atom.m, mEnd - atom.m);
      if (text.trim().length > 0) run.atoms.push({ text, m, mEnd });
    }
  }
  return runs.map(({ atoms }) => atoms);
}

/** Atoms of a PDF edition: one per printed line (D75's own printed-text extraction, reused here). */
export async function pdfAtoms(ctx: AppContext, edition: EditionRow): Promise<ChunkAtom[]> {
  const file = ctx.storage.pubFile(edition.id, PRINTED_FILE);
  if (!file) return [];
  let json: string;
  try {
    json = await readUtf8(file);
  } catch {
    return [];
  }
  const pages = parsePrinted(json);
  if (!pages) return [];
  const atoms: ChunkAtom[] = [];
  pages.forEach((lines, page) => {
    lines.forEach((line) => {
      if (line.text.trim().length === 0) return;
      atoms.push({ text: line.text, m: page + line.top, mEnd: page + line.bottom });
    });
  });
  return atoms;
}

/**
 * Atoms of an audio edition from its own speech-recognition transcript, when one exists (D160:
 * "where they exist"). The transcript is read, parsed and made into atoms in a worker thread (the
 * align worker's `transcript-atoms` task, with its own connection to the database): a 16-hour
 * audiobook's transcript is megabytes of JSON and hundreds of thousands of words, and on the
 * server's thread reading, parsing and walking it held every other request for a third of a second.
 */
export async function audioAtoms(ctx: AppContext, edition: EditionRow): Promise<ChunkAtom[]> {
  const tracks = editionFiles(ctx.db, edition.id)
    .filter((f) => f.role === 'track')
    .map((f) => ({ blobId: f.blob_id, idx: f.idx }));
  const timeline = editionTimeline(edition);
  const starts = timeline ? unitStarts(timeline.geometry) : [];
  const { atoms } = await runInWorker({ kind: 'transcript-atoms', database: ctx.storage.dbFile, editionId: edition.id, tracks, starts }, TRANSCRIPT_ATOMS_LIMITS);
  return atoms;
}

/** Each run is chunked separately so overlap stays within the same reading passage. */
export async function atomRunsForEdition(ctx: AppContext, edition: EditionRow): Promise<ChunkAtom[][]> {
  switch (edition.kind) {
    case 'epub':
      return epubAtomRuns(ctx, edition);
    case 'pdf':
      return [await pdfAtoms(ctx, edition)];
    case 'audio':
      return [await audioAtoms(ctx, edition)];
  }
}

function readUtf8(file: string): Promise<string> {
  return readFile(file, 'utf8');
}
