import { describe, expect, it } from 'vitest';
import { formatEta } from './BookPage';

describe('formatEta', () => {
  it('rounds under a minute to seconds', () => {
    expect(formatEta(1_200)).toBe('about 1 sec left');
    expect(formatEta(45_000)).toBe('about 45 sec left');
  });

  it('rounds minutes under an hour', () => {
    expect(formatEta(90_000)).toBe('about 2 min left');
    expect(formatEta(10 * 60_000)).toBe('about 10 min left');
  });

  it('shows hours, with leftover minutes when needed', () => {
    expect(formatEta(60 * 60_000)).toBe('about 1 h left');
    expect(formatEta(90 * 60_000)).toBe('about 1 h 30 min left');
  });
});
