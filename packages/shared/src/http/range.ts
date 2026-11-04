/**
 * `Range: bytes=…` parsing per RFC 9110 §14.
 *
 * - `bytes=0-499`, `bytes=500-` and suffix ranges `bytes=-500` are supported.
 * - Several ranges are coalesced when they overlap or touch; if more than one disjoint range
 *   remains the header is ignored and the whole representation is served (allowed by the RFC,
 *   and media elements never ask for multipart responses).
 * - A syntactically invalid header is ignored (whole representation, 200).
 * - A well-formed header with no satisfiable range yields 416.
 */
export type RangeResult =
  | { readonly type: 'none' }
  | { readonly type: 'unsatisfiable' }
  | { readonly type: 'range'; readonly start: number; readonly end: number };

const SPEC = /^\s*(\d*)\s*-\s*(\d*)\s*$/;

export function parseRangeHeader(header: string | undefined | null, size: number): RangeResult {
  if (header == null) return { type: 'none' };
  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!match) return { type: 'none' };
  const specs = match[1]!.split(',');
  const ranges: [number, number][] = [];
  for (const raw of specs) {
    const m = SPEC.exec(raw);
    if (!m) return { type: 'none' };
    const [, first, last] = m;
    if (first === '' && last === '') return { type: 'none' };
    let start: number;
    let end: number;
    if (first === '') {
      // Suffix range: the final N bytes.
      const suffix = Number(last);
      if (!Number.isSafeInteger(suffix)) return { type: 'none' };
      if (suffix === 0 || size === 0) continue;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(first);
      end = last === '' ? size - 1 : Number(last);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { type: 'none' };
      if (last !== '' && end < start) return { type: 'none' };
      if (start >= size) continue;
      end = Math.min(end, size - 1);
    }
    ranges.push([start, end]);
  }
  if (ranges.length === 0) return { type: 'unsatisfiable' };
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  if (merged.length > 1) return { type: 'none' };
  const [start, end] = merged[0]!;
  return { type: 'range', start, end };
}

export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

export function unsatisfiedRangeHeader(size: number): string {
  return `bytes */${size}`;
}
