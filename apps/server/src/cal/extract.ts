import { readFile } from 'node:fs/promises';
import { bodyTextWithBreaks } from '@bookclub/epub';
import { type ChunkAtom, unitStarts } from '@bookclub/shared';
import { PRINTED_FILE, parsePrinted } from '../ingest/pdf';
import { type AppContext } from '../context';
import { type EditionRow, editionFiles, editionTimeline } from '../repos/books';
import { TRANSCRIPT_ATOMS_LIMITS, runInWorker } from '../services/aligner';

interface Section {
  readonly index: number;
  readonly href: string;
}

interface PublicationManifest {
  readonly sections: readonly Section[];
}

/** Atoms of an EPUB edition: one per block (paragraph, heading, list item…), from its normalised sections. */
export async function epubAtoms(ctx: AppContext, edition: EditionRow): Promise<ChunkAtom[]> {
  const manifestFile = ctx.storage.pubFile(edition.id, '.publication.json');
  if (!manifestFile) return [];
  let manifest: PublicationManifest;
  try {
    manifest = JSON.parse(await readUtf8(manifestFile)) as PublicationManifest;
  } catch {
    return [];
  }
  const timeline = editionTimeline(edition);
  const starts = timeline ? unitStarts(timeline.geometry) : [];
  const atoms: ChunkAtom[] = [];
  for (const section of manifest.sections) {
    const file = ctx.storage.pubFile(edition.id, section.href);
    if (!file) continue;
    let xhtml: string;
    try {
      xhtml = await readUtf8(file);
    } catch {
      continue;
    }
    const { text, breaks } = bodyTextWithBreaks(xhtml);
    const base = starts[section.index] ?? 0;
    let from = 0;
    for (const to of breaks) {
      const piece = text.slice(from, to);
      if (piece.trim().length > 0) atoms.push({ text: piece, m: base + from, mEnd: base + to });
      from = to;
    }
  }
  return atoms;
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

/** Atoms of a ready edition, by its kind; empty when the edition has no indexable text yet. */
export async function atomsForEdition(ctx: AppContext, edition: EditionRow): Promise<ChunkAtom[]> {
  switch (edition.kind) {
    case 'epub':
      return epubAtoms(ctx, edition);
    case 'pdf':
      return pdfAtoms(ctx, edition);
    case 'audio':
      return audioAtoms(ctx, edition);
  }
}

function readUtf8(file: string): Promise<string> {
  return readFile(file, 'utf8');
}
