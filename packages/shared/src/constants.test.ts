import { describe, expect, it } from 'vitest';
import { MEMBER_PALETTE } from './constants';

/** Hue in degrees of a #RRGGBB colour. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('MEMBER_PALETTE', () => {
  it('keeps v1’s eight colours, all different', () => {
    expect(new Set(MEMBER_PALETTE).size).toBe(8);
    expect([...MEMBER_PALETTE].sort()).toEqual(['#45B7D1', '#4ECDC4', '#96CEB4', '#98D8C8', '#DDA0DD', '#FF6B6B', '#FF8C42', '#FFEAA7']);
  });

  it('gives a fifth friend a colour of their own too, not the blue that reads as teal beside it', () => {
    const fifth = hue(MEMBER_PALETTE[4]);
    for (const other of MEMBER_PALETTE.slice(0, 4).map(hue)) {
      expect(Math.min(Math.abs(fifth - other), 360 - Math.abs(fifth - other))).toBeGreaterThanOrEqual(20);
    }
  });

  it('gives the first four friends of a club colours far apart on the colour wheel', () => {
    const first = MEMBER_PALETTE.slice(0, 4).map(hue);
    for (let i = 0; i < first.length; i++) {
      for (let j = i + 1; j < first.length; j++) {
        const apart = Math.min(Math.abs(first[i]! - first[j]!), 360 - Math.abs(first[i]! - first[j]!));
        expect(apart, `${MEMBER_PALETTE[i]} and ${MEMBER_PALETTE[j]}`).toBeGreaterThanOrEqual(45);
      }
    }
  });
});
