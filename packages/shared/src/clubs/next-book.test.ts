import { describe, expect, it } from 'vitest';
import { pickWinner, topVoted } from './next-book';

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

describe('pickWinner (D214)', () => {
  it('is null with no nominations', () => {
    expect(pickWinner([])).toBeNull();
  });

  it('picks the single most-voted nomination outright, no choice needed', () => {
    expect(pickWinner([{ id: 'a', votes: 1 }, { id: 'b', votes: 3 }])).toBe('b');
  });

  it('a tie is null until the closer chooses among the tied', () => {
    const tied = [{ id: 'a', votes: 2 }, { id: 'b', votes: 2 }, { id: 'c', votes: 1 }];
    expect(pickWinner(tied)).toBeNull();
    expect(pickWinner(tied, 'a')).toBe('a');
    expect(pickWinner(tied, 'b')).toBe('b');
  });

  it('a choice that is not among the tied does not win', () => {
    const tied = [{ id: 'a', votes: 2 }, { id: 'b', votes: 2 }];
    expect(pickWinner(tied, 'c')).toBeNull();
    expect(pickWinner(tied, undefined)).toBeNull();
  });
});
