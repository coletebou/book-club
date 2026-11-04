/**
 * Cal's chunker: cuts a source's text (a book edition, or something fed to Cal's shelf) into
 * paragraph/sentence windows of roughly TARGET_TOKENS tokens, overlapping by OVERLAP_TOKENS, for
 * embedding and full-text indexing (apps/server/src/cal/indexer.ts). Pure and format-agnostic: it
 * works on "atoms" (the smallest unit a caller can place on its source's own linear measure — an
 * EPUB paragraph, a PDF printed line, an audiobook read-along sentence), not on any one format,
 * so the same code chunks all three (D160).
 */

/** The smallest text unit a caller can place on its source's own measure (characters, pages, ms). */
export interface ChunkAtom {
  readonly text: string;
  /** Where this atom starts, in the source's own measure. Atoms are given in non-decreasing order. */
  readonly m: number;
  /** Where this atom ends; `mEnd >= m`. */
  readonly mEnd: number;
}

export interface TextChunk {
  readonly text: string;
  readonly m: number;
  readonly mEnd: number;
  readonly tokenCount: number;
}

export interface ChunkOptions {
  /** Aim to close a window once it holds about this many tokens. */
  readonly targetTokens?: number;
  /** Never let one window grow past this many tokens (a huge atom is split to fit, see below). */
  readonly maxTokens?: number;
  /** Carry roughly this many trailing tokens of a closed window into the next one. */
  readonly overlapTokens?: number;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  targetTokens: 420,
  maxTokens: 500,
  overlapTokens: 90,
};

/**
 * A token-count estimate good enough for chunk sizing: about 4 characters per token (the common
 * heuristic for English prose; Cal's embedding and chat providers each count tokens exactly when
 * it matters for cost, see apps/server/src/cal/cost.ts).
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : Math.max(1, Math.ceil(trimmed.length / 4));
}

/** Join atom texts with a paragraph break, the way the chunks will be read back to Cal. */
function joinText(atoms: readonly ChunkAtom[]): string {
  return atoms
    .map((a) => a.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/**
 * An atom too large to fit in one window on its own (a long paragraph, a chapter's worth of
 * read-along sentences folded into one atom by a caller) is cut at word boundaries into pieces of
 * at most `maxTokens`, each piece's `m`/`mEnd` interpolated linearly over the atom's own span —
 * approximate, but the atom is already the finest position a caller can place text at.
 */
function splitLongAtom(atom: ChunkAtom, maxTokens: number): ChunkAtom[] {
  const text = atom.text.trim();
  if (text.length === 0) return [];
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [{ ...atom, text }];
  const words = text.split(/(\s+)/);
  const pieces: { text: string; start: number; end: number }[] = [];
  let cur = '';
  let curStart = 0;
  let consumed = 0;
  for (const w of words) {
    if (cur.length + w.length > maxChars && cur.trim().length > 0) {
      pieces.push({ text: cur, start: curStart, end: consumed });
      cur = '';
      curStart = consumed;
    }
    cur += w;
    consumed += w.length;
  }
  if (cur.trim().length > 0) pieces.push({ text: cur, start: curStart, end: consumed });
  const span = atom.mEnd - atom.m;
  const total = text.length;
  return pieces.map((p) => ({
    text: p.text.trim(),
    m: atom.m + (total === 0 ? 0 : (span * p.start) / total),
    mEnd: atom.m + (total === 0 ? 0 : (span * p.end) / total),
  }));
}

/**
 * Cut a source's atoms into overlapping chunks. Windows close once they reach `targetTokens` (or
 * when the atoms run out), never exceed `maxTokens` (an oversized atom is split, see
 * {@link splitLongAtom}), and the next window opens with the trailing ~`overlapTokens` of the one
 * just closed, so a passage near a window boundary is not orphaned from its context either side.
 */
export function chunkAtoms(atoms: readonly ChunkAtom[], options: ChunkOptions = {}): TextChunk[] {
  const { targetTokens, maxTokens, overlapTokens } = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const flat = atoms.flatMap((a) => splitLongAtom(a, maxTokens)).filter((a) => a.text.length > 0);
  const chunks: TextChunk[] = [];
  let window: ChunkAtom[] = [];
  let tokens = 0;

  const closeWindow = () => {
    if (window.length === 0) return;
    const text = joinText(window);
    chunks.push({ text, m: window[0]!.m, mEnd: window[window.length - 1]!.mEnd, tokenCount: estimateTokens(text) });
  };

  const overlapTail = (): ChunkAtom[] => {
    const tail: ChunkAtom[] = [];
    let carried = 0;
    for (let i = window.length - 1; i >= 0 && carried < overlapTokens; i--) {
      tail.unshift(window[i]!);
      carried += estimateTokens(window[i]!.text);
    }
    return tail;
  };

  // Whether `window` holds any atom added since the last closeWindow() beyond the carried
  // overlap tail: a window that is only the tail (nothing new accumulated after the last close,
  // because the source ran out exactly on a boundary) must not be closed again as a near-empty
  // duplicate of the chunk it was carried from.
  let freshSinceClose = false;

  for (const atom of flat) {
    const atomTokens = estimateTokens(atom.text);
    if (tokens > 0 && tokens + atomTokens > maxTokens) {
      closeWindow();
      window = overlapTail();
      tokens = window.reduce((s, a) => s + estimateTokens(a.text), 0);
      // The carried-forward overlap alone, plus this atom, would still overflow (a large atom
      // right after a large one): drop the overlap rather than exceed maxTokens.
      if (tokens + atomTokens > maxTokens) {
        window = [];
        tokens = 0;
      }
    }
    window.push(atom);
    tokens += atomTokens;
    freshSinceClose = true;
    if (tokens >= targetTokens) {
      closeWindow();
      window = overlapTail();
      tokens = window.reduce((s, a) => s + estimateTokens(a.text), 0);
      freshSinceClose = false;
    }
  }
  // What is left (shorter than the target, at the very end of the source) is still a chunk: the
  // last page of a book is as searchable as every page before it.
  if (freshSinceClose) closeWindow();
  return chunks;
}
