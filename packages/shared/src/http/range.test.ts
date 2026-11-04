import { describe, expect, it } from 'vitest';
import { contentRangeHeader, parseRangeHeader, unsatisfiedRangeHeader } from './range';

const SIZE = 1000;

describe('parseRangeHeader', () => {
  it('no header means the whole file', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ type: 'none' });
    expect(parseRangeHeader(null, SIZE)).toEqual({ type: 'none' });
  });

  it('closed range', () => {
    expect(parseRangeHeader('bytes=0-499', SIZE)).toEqual({ type: 'range', start: 0, end: 499 });
  });

  it('open-ended range (what <audio> sends first)', () => {
    expect(parseRangeHeader('bytes=0-', SIZE)).toEqual({ type: 'range', start: 0, end: 999 });
    expect(parseRangeHeader('bytes=729449-', 960581)).toEqual({ type: 'range', start: 729449, end: 960580 });
  });

  it('suffix range', () => {
    expect(parseRangeHeader('bytes=-100', SIZE)).toEqual({ type: 'range', start: 900, end: 999 });
    expect(parseRangeHeader('bytes=-5000', SIZE)).toEqual({ type: 'range', start: 0, end: 999 });
  });

  it('end beyond the file is clamped', () => {
    expect(parseRangeHeader('bytes=900-5000', SIZE)).toEqual({ type: 'range', start: 900, end: 999 });
  });

  it('start beyond the file is unsatisfiable', () => {
    expect(parseRangeHeader('bytes=1000-', SIZE)).toEqual({ type: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ type: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ type: 'unsatisfiable' });
  });

  it('coalesces overlapping ranges and ignores disjoint multi-ranges', () => {
    expect(parseRangeHeader('bytes=0-10, 5-20, 21-30', SIZE)).toEqual({ type: 'range', start: 0, end: 30 });
    expect(parseRangeHeader('bytes=0-10, 500-600', SIZE)).toEqual({ type: 'none' });
  });

  it.each(['items=0-1', 'bytes=abc', 'bytes=5-1', 'bytes=-', 'bytes=1-2-3', 'bytes=99999999999999999999-'])(
    'ignores malformed header %s',
    (header) => {
      expect(parseRangeHeader(header, SIZE)).toEqual({ type: 'none' });
    },
  );

  it('is case-insensitive about the unit and tolerant of spaces', () => {
    expect(parseRangeHeader('Bytes = 1 - 2', SIZE)).toEqual({ type: 'range', start: 1, end: 2 });
  });
});

describe('Content-Range helpers', () => {
  it('formats satisfied and unsatisfied ranges', () => {
    expect(contentRangeHeader(0, 499, 1000)).toBe('bytes 0-499/1000');
    expect(unsatisfiedRangeHeader(1000)).toBe('bytes */1000');
  });
});
