import { describe, expect, it } from 'vitest';
import { topVoted } from './next-book';

describe('topVoted (D214)', () => {
  it('is empty with nothing nominated', () => {
    expect(topVoted([])).toEqual([]);
  });

  it('is the single most-voted nomination', () => {
    expect(topVoted([{ id: 'a', votes: 1 }, { id: 'b', votes: 3 }, { id: 'c', votes: 2 }])).toEqual(['b']);
  });

  it('is every nomination tied for the most votes, in order, zero votes each included', () => {
    expect(topVoted([{ id: 'a', votes: 2 }, { id: 'b', votes: 1 }, { id: 'c', votes: 2 }])).toEqual(['a', 'c']);
    expect(topVoted([{ id: 'a', votes: 0 }, { id: 'b', votes: 0 }])).toEqual(['a', 'b']);
  });
});
