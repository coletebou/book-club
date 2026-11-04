import { describe, expect, it } from 'vitest';
import { TurnBuffer } from './turn-buffer';

function bytes(n: number): Uint8Array {
  return new Uint8Array(n);
}

describe('TurnBuffer (PR #13 security review: unbounded Cal voice turn)', () => {
  it('accepts chunks under the cap and reports the running total', () => {
    const b = new TurnBuffer(100);
    expect(b.push(bytes(40))).toBe(true);
    expect(b.push(bytes(40))).toBe(true);
    expect(b.totalBytes).toBe(80);
  });

  it('accepts a chunk that lands exactly on the cap', () => {
    const b = new TurnBuffer(100);
    expect(b.push(bytes(100))).toBe(true);
    expect(b.totalBytes).toBe(100);
  });

  it('refuses a chunk that would exceed the cap, and does not append it', () => {
    const b = new TurnBuffer(100);
    expect(b.push(bytes(90))).toBe(true);
    expect(b.push(bytes(20))).toBe(false); // would be 110
    expect(b.totalBytes).toBe(90); // the refused chunk never landed
  });

  it('never grows past the cap across unboundedly many small frames (the real attack)', () => {
    const b = new TurnBuffer(1000);
    let accepted = 0;
    for (let i = 0; i < 100_000; i++) {
      if (b.push(bytes(1))) accepted++;
      else break;
    }
    expect(accepted).toBe(1000);
    expect(b.totalBytes).toBe(1000);
    expect(b.push(bytes(1))).toBe(false);
  });

  it('take() concatenates in order and clears the buffer', () => {
    const b = new TurnBuffer(100);
    b.push(new Uint8Array([1, 2]));
    b.push(new Uint8Array([3, 4, 5]));
    expect([...b.take()]).toEqual([1, 2, 3, 4, 5]);
    expect(b.totalBytes).toBe(0);
    expect([...b.take()]).toEqual([]);
  });

  it('clear() resets so a fresh turn starts with the full cap again', () => {
    const b = new TurnBuffer(10);
    b.push(bytes(10));
    expect(b.push(bytes(1))).toBe(false);
    b.clear();
    expect(b.push(bytes(10))).toBe(true);
  });
});
