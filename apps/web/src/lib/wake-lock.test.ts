import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdScreenOn } from './wake-lock';

/** A browser's screen wake lock: each lock it grants, which the page lets go or the browser takes back when the page is hidden. */
class FakeWakeLock {
  readonly granted: { released: boolean; release: () => Promise<void> }[] = [];
  refuse = false;
  /** Locks asked for and not answered yet. */
  readonly pending: (() => void)[] = [];
  answerAtOnce = true;
  request(type: string) {
    expect(type).toBe('screen');
    return new Promise((resolve, reject) => {
      const answer = () => {
        if (this.refuse) return reject(new DOMException('Not allowed', 'NotAllowedError'));
        const sentinel = {
          released: false,
          release: () => {
            sentinel.released = true;
            return Promise.resolve();
          },
        };
        this.granted.push(sentinel);
        resolve(sentinel);
      };
      if (this.answerAtOnce) answer();
      else this.pending.push(answer);
    });
  }
  /** The page is hidden: the browser takes every lock back. */
  hide() {
    for (const s of this.granted) s.released = true;
  }
  get held() {
    return this.granted.filter((s) => !s.released).length;
  }
}

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('holdScreenOn (the screen kept on during an upload, fidelity review round 17)', () => {
  let lock: FakeWakeLock;

  beforeEach(() => {
    lock = new FakeWakeLock();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: lock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'wakeLock');
  });

  it('holds a screen lock until it is let go', async () => {
    const letGo = holdScreenOn();
    await settle();
    expect(lock.granted).toHaveLength(1);
    expect(lock.held).toBe(1);
    letGo();
    await settle();
    expect(lock.held).toBe(0);
    // Let go twice: nothing more.
    letGo();
    expect(lock.granted).toHaveLength(1);
  });

  it('asks again each time the page is seen again (the browser lets it go when the page is hidden), and not after it is let go', async () => {
    const letGo = holdScreenOn();
    await settle();
    lock.hide();
    setVisibility('hidden');
    await settle();
    expect(lock.granted).toHaveLength(1);
    setVisibility('visible');
    await settle();
    expect(lock.granted).toHaveLength(2);
    expect(lock.held).toBe(1);
    // Seen again while it holds a lock: no second one.
    setVisibility('visible');
    await settle();
    expect(lock.granted).toHaveLength(2);
    letGo();
    lock.hide();
    setVisibility('visible');
    await settle();
    expect(lock.granted).toHaveLength(2);
    expect(lock.held).toBe(0);
  });

  it('waits for the page to be seen when it starts hidden', async () => {
    visibility = 'hidden';
    const letGo = holdScreenOn();
    await settle();
    expect(lock.granted).toHaveLength(0);
    setVisibility('visible');
    await settle();
    expect(lock.held).toBe(1);
    letGo();
  });

  it('lets a lock granted after it was let go go at once', async () => {
    lock.answerAtOnce = false;
    const letGo = holdScreenOn();
    letGo();
    lock.pending.shift()!();
    await settle();
    expect(lock.granted).toHaveLength(1);
    expect(lock.held).toBe(0);
  });

  it('asks only once at a time, and asks again after a refusal once the page is seen again', async () => {
    lock.answerAtOnce = false;
    const letGo = holdScreenOn();
    setVisibility('visible');
    expect(lock.pending).toHaveLength(1);
    lock.refuse = true;
    lock.pending.shift()!();
    await settle();
    expect(lock.granted).toHaveLength(0);
    lock.refuse = false;
    lock.answerAtOnce = true;
    setVisibility('visible');
    await settle();
    expect(lock.held).toBe(1);
    letGo();
  });

  it('does nothing in a browser without wake locks', () => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    expect('wakeLock' in navigator).toBe(false);
    const letGo = holdScreenOn();
    setVisibility('visible');
    expect(() => letGo()).not.toThrow();
  });
});
