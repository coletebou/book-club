import { describe, expect, it } from 'vitest';
import { MEMBER_PALETTE, REACTIONS, REACTION_LABELS, hashCode, memberColor } from './constants';
import { formatBytes, formatDuration, formatNames, formatPercent, formatWhen } from './format';

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [65_000, '1:05'],
    [3_725_000, '1:02:05'],
    [-5, '0:00'],
    [59_999, '0:59'],
  ])('%d ms → %s', (ms, out) => {
    expect(formatDuration(ms)).toBe(out);
  });
});

describe('formatPercent', () => {
  it('never claims 100% before the end', () => {
    expect(formatPercent(0.999)).toBe('99%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.155)).toBe('15%');
    // A place carried between two formats' maps, a hair short of 8 %, is 8 % too.
    expect(formatPercent(0.079999)).toBe('8%');
    expect(formatPercent(0.0799)).toBe('7%');
    expect(formatPercent(0.0795)).toBe('7%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });
});

describe('formatNames', () => {
  it('joins names readably', () => {
    expect(formatNames([])).toBe('');
    expect(formatNames(['Ana'])).toBe('Ana');
    expect(formatNames(['Ana', 'Ben'])).toBe('Ana and Ben');
    expect(formatNames(['Ana', 'Ben', 'Cleo'])).toBe('Ana, Ben and 1 other');
    expect(formatNames(['Ana', 'Ben', 'Cleo', 'Dev'])).toBe('Ana, Ben and 2 others');
  });
});

describe('formatBytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(50 * 1024 ** 2)).toBe('50 MB');
  });
});

describe('member colours', () => {
  it('are deterministic and from the v1 palette', () => {
    expect(memberColor('user-1')).toBe(memberColor('user-1'));
    expect(MEMBER_PALETTE).toContain(memberColor('anyone'));
    expect(hashCode('')).toBe(0);
  });

  it('reactions are the v1 set with labels', () => {
    expect(REACTIONS).toEqual(['😱', '😢', '😡', '😂', '❤️', '🤯']);
    for (const r of REACTIONS) expect(REACTION_LABELS[r]).toMatch(/\w/);
  });
});

describe('formatWhen', () => {
  const now = Date.parse('2026-10-23T18:00:00Z');
  it.each([
    ['2026-10-23T17:59:30Z', 'just now'],
    ['2026-10-23T17:55:00Z', '5 min ago'],
    ['2026-10-23T15:00:00Z', '3 h ago'],
    ['2026-10-22T12:00:00Z', 'yesterday'],
    ['2026-10-19T12:00:00Z', '4 days ago'],
    ['2026-03-12T12:00:00Z', '12 Mar'],
    ['2025-12-31T12:00:00Z', '31 Dec 2025'],
    ['2026-10-23T18:05:00Z', 'just now'],
    ['not a date', ''],
  ])('%s → %s', (iso, expected) => {
    expect(formatWhen(iso, now)).toBe(expected);
  });
});
