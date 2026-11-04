import { describe, expect, it } from 'vitest';
import { type ChunkAtom, chunkAtoms, estimateTokens } from './chunker';

/** A paragraph of `words` four-letter words, each a distinct token (`estimateTokens` ~ chars/4). */
function paragraph(words: number, seed: string): string {
  return Array.from({ length: words }, (_, i) => `${seed}${i}`).join(' ');
}

function atomsFrom(paragraphs: readonly string[]): ChunkAtom[] {
  let m = 0;
  return paragraphs.map((text) => {
    const atom: ChunkAtom = { text, m, mEnd: m + text.length };
    m = atom.mEnd + 2; // a blank line between paragraphs, as in a real section
    return atom;
  });
}

describe('estimateTokens', () => {
  it('is roughly chars/4, at least one token for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('chunkAtoms', () => {
  it('returns nothing for no atoms', () => {
    expect(chunkAtoms([])).toEqual([]);
  });

  it('keeps a short source as one chunk', () => {
    const atoms = atomsFrom([paragraph(20, 'w')]);
    const chunks = chunkAtoms(atoms, { targetTokens: 400, maxTokens: 500, overlapTokens: 90 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.m).toBe(0);
    expect(chunks[0]!.text).toContain('w0');
  });

  it('cuts a long source into windows around the target size, each within the max', () => {
    // Ten paragraphs of ~100 tokens each: 1000 tokens of source, target 400, max 500.
    const paragraphs = Array.from({ length: 10 }, (_, i) => paragraph(100, `p${i}_`));
    const atoms = atomsFrom(paragraphs);
    const chunks = chunkAtoms(atoms, { targetTokens: 400, maxTokens: 500, overlapTokens: 90 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(500);
    // Covers the whole source: the first chunk starts at the source's start, the last ends at its end.
    expect(chunks[0]!.m).toBe(0);
    expect(chunks[chunks.length - 1]!.mEnd).toBe(atoms[atoms.length - 1]!.mEnd);
  });

  it('overlaps consecutive windows: the end of one shares text with the start of the next', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => paragraph(100, `p${i}_`));
    const atoms = atomsFrom(paragraphs);
    const chunks = chunkAtoms(atoms, { targetTokens: 400, maxTokens: 500, overlapTokens: 90 });
    for (let i = 1; i < chunks.length; i++) {
      // The next window's start lies strictly before the previous window's end: real overlap.
      expect(chunks[i]!.m).toBeLessThan(chunks[i - 1]!.mEnd);
    }
  });

  it('never produces a chunk over maxTokens even from one huge atom', () => {
    const huge: ChunkAtom = { text: paragraph(2000, 'huge'), m: 0, mEnd: 20000 };
    const chunks = chunkAtoms([huge], { targetTokens: 400, maxTokens: 500, overlapTokens: 90 });
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(500);
    expect(chunks[0]!.m).toBe(0);
    expect(chunks[chunks.length - 1]!.mEnd).toBe(20000);
  });

  it('does not emit a trailing near-empty chunk when the source ends exactly on a window boundary', () => {
    // Exactly 400 tokens (target), nothing left over.
    const atoms = atomsFrom([paragraph(400, 'x')]);
    const chunks = chunkAtoms(atoms, { targetTokens: 400, maxTokens: 500, overlapTokens: 90 });
    expect(chunks).toHaveLength(1);
  });

  it('preserves reading order: chunk starts are non-decreasing', () => {
    const paragraphs = Array.from({ length: 15 }, (_, i) => paragraph(80, `s${i}_`));
    const atoms = atomsFrom(paragraphs);
    const chunks = chunkAtoms(atoms);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.m).toBeGreaterThanOrEqual(chunks[i - 1]!.m);
  });
});
