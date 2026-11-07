import { describe, expect, it } from 'vitest';
import { type MessagePage, type ThreadedMessage, appendOlder, groupRuns, newestFirst, oldestHeld, refreshNewest, removeMessage, threadOf, upsertMessage } from './messages';

interface Msg extends ThreadedMessage {
  readonly author: string;
  readonly text: string;
  readonly hidden?: boolean;
  readonly quote?: string | null;
}

let clock = Date.parse('2026-11-05T20:00:00.000Z');
const at = (minutes: number) => new Date(clock + minutes * 60_000).toISOString();
const msg = (id: string, minutes: number, extra: Partial<Msg> = {}): Msg => ({ id, parentId: null, threadId: null, createdAt: at(minutes), author: 'ana', text: id, replyCount: 0, ...extra });
const reply = (id: string, minutes: number, parent: Msg, extra: Partial<Msg> = {}): Msg => msg(id, minutes, { parentId: parent.id, threadId: parent.threadId ?? parent.id, quote: parent.text, ...extra });
const page = (messages: Msg[], hasMore = false): MessagePage<Msg> => ({ messages: [...messages].sort(newestFirst), hasMore });
const ids = (p: MessagePage<Msg>) => p.messages.map((m) => m.id);
const requote = (child: Msg, parent: Msg | null): Msg => ({ ...child, quote: parent && !parent.deleted ? parent.text : null });

describe('newestFirst', () => {
  it('orders by time, newest first, ties by the larger id', () => {
    const a = msg('a', 1);
    const b = msg('b', 1);
    const c = msg('c', 2);
    expect([a, c, b].sort(newestFirst).map((m) => m.id)).toEqual(['c', 'b', 'a']);
    expect(newestFirst(a, a)).toBe(0);
  });
});

describe('upsertMessage', () => {
  it('puts a new message in its place in time and leaves the page alone when nothing changed', () => {
    const start = page([msg('a', 0), msg('c', 2)]);
    expect(ids(upsertMessage(start, msg('b', 1)))).toEqual(['c', 'b', 'a']);
    expect(ids(upsertMessage(start, msg('d', 3)))).toEqual(['d', 'c', 'a']);
  });

  it('does not reach past what is held into pages not loaded yet', () => {
    const start = page([msg('b', 1), msg('c', 2)], true);
    expect(upsertMessage(start, msg('a', 0))).toBe(start);
    expect(ids(upsertMessage(page([msg('b', 1)], false), msg('a', 0)))).toEqual(['b', 'a']);
  });

  it('replaces a copy held, keeping the held one when the app says so', () => {
    const start = page([msg('a', 0, { text: 'first' })]);
    expect(upsertMessage(start, msg('a', 0, { text: 'edited' })).messages[0]!.text).toBe('edited');
    const revealed = page([msg('a', 0, { text: 'open' })]);
    const kept = upsertMessage(revealed, msg('a', 0, { text: '', hidden: true }), { keepExisting: (old, next) => !old.hidden && !!next.hidden });
    expect(kept).toBe(revealed);
  });

  it("counts a new reply on its root, and takes it off when the reply becomes a deleted placeholder", () => {
    const root = msg('root', 0);
    const one = reply('r1', 1, root);
    let p = upsertMessage(page([root]), one);
    expect(p.messages.find((m) => m.id === 'root')!.replyCount).toBe(1);
    p = upsertMessage(p, one); // the same reply again (an echo): no second count
    expect(p.messages.find((m) => m.id === 'root')!.replyCount).toBe(1);
    p = upsertMessage(p, { ...one, deleted: true, text: '' });
    expect(p.messages.find((m) => m.id === 'root')!.replyCount).toBe(0);
  });

  it('re-quotes held replies of a parent older than the page, without adding the parent', () => {
    const old = msg('old', 0, { text: 'before' });
    const child = reply('child', 5, old);
    const start = page([child], true);
    const next = upsertMessage(start, { ...old, deleted: true, text: '' }, { requote });
    expect(next.messages.map((m) => m.id)).toEqual(['child']);
    expect(next.messages[0]!.quote).toBeNull();
    expect(upsertMessage(start, msg('unrelated', 0), { requote })).toBe(start);
  });

  it('keeps a held reply count when an incoming copy carries none', () => {
    const p = upsertMessage(page([msg('root', 0, { replyCount: 4 })]), { ...msg('root', 0), replyCount: undefined });
    expect(p.messages[0]!.replyCount).toBe(4);
  });

  it('brings quotes of an edited or deleted parent up to date', () => {
    const root = msg('root', 0, { text: 'original' });
    const child = reply('child', 1, root);
    let p = page([root, child]);
    p = upsertMessage(p, { ...root, text: 'edited' }, { requote });
    expect(p.messages.find((m) => m.id === 'child')!.quote).toBe('edited');
    p = upsertMessage(p, { ...root, deleted: true, text: '' }, { requote });
    expect(p.messages.find((m) => m.id === 'child')!.quote).toBeNull();
  });
});

describe('removeMessage', () => {
  it('drops a message, counts its root one fewer, and tells replies it is gone', () => {
    const root = msg('root', 0, { replyCount: 2 });
    const one = reply('r1', 1, root);
    const two = reply('r2', 2, one);
    let p = page([root, one, two]);
    p = removeMessage(p, 'r1', { requote });
    expect(ids(p)).toEqual(['r2', 'root']);
    expect(p.messages.find((m) => m.id === 'root')!.replyCount).toBe(1);
    expect(p.messages.find((m) => m.id === 'r2')!.quote).toBeNull();
  });

  it("corrects the root's count from a threadId when the reply itself is not held", () => {
    const p = removeMessage(page([msg('root', 0, { replyCount: 1 })]), 'elsewhere', { threadId: 'root' });
    expect(p.messages[0]!.replyCount).toBe(0);
  });

  it('never counts below zero, and leaves a page alone when there is nothing to do', () => {
    const start = page([msg('root', 0, { replyCount: 0 })]);
    expect(removeMessage(start, 'x', { threadId: 'root' }).messages[0]!.replyCount).toBe(0);
    const untouched = page([msg('a', 0)]);
    expect(removeMessage(untouched, 'missing')).toBe(untouched);
  });

  it('does not count a deleted placeholder twice', () => {
    const root = msg('root', 0, { replyCount: 0 });
    const gone = reply('r1', 1, root, { deleted: true });
    expect(removeMessage(page([root, gone]), 'r1').messages[0]!.replyCount).toBe(0);
  });
});

describe('appendOlder and oldestHeld', () => {
  it('adds an older page after what is held, without duplicates, with its hasMore', () => {
    const newer = page([msg('c', 2), msg('b', 1)], true);
    const older = page([msg('b', 1), msg('a', 0)], false);
    const merged = appendOlder(newer, older);
    expect(ids(merged)).toEqual(['c', 'b', 'a']);
    expect(merged.hasMore).toBe(false);
    expect(oldestHeld(merged)!.id).toBe('a');
    expect(oldestHeld(page([]))).toBeUndefined();
  });
});

describe('refreshNewest', () => {
  it('takes the fresh page for its own span and keeps older pages held beyond it', () => {
    const held = page([msg('d', 3), msg('c', 2, { text: 'stale' }), msg('b', 1), msg('a', 0)], false);
    const fresh = page([msg('e', 4), msg('d', 3), msg('c', 2, { text: 'fresh' })], true);
    const merged = refreshNewest(held, fresh);
    expect(ids(merged)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(merged.messages.find((m) => m.id === 'c')!.text).toBe('fresh');
    expect(merged.hasMore).toBe(false);
  });

  it('is the fresh page alone when it does not reach back to what is held (no gap is ever kept)', () => {
    const held = page([msg('b', 1), msg('a', 0)], false);
    const fresh = page([msg('e', 4), msg('d', 3)], true);
    expect(refreshNewest(held, fresh)).toBe(fresh);
  });

  it('is the fresh page when it already reaches the start, or nothing older is held', () => {
    const fresh = page([msg('b', 1)], false);
    expect(refreshNewest(page([msg('a', 0)]), fresh)).toBe(fresh);
    const more = page([msg('b', 1)], true);
    expect(refreshNewest(page([msg('b', 1)], true), more)).toBe(more);
    expect(refreshNewest(undefined, more)).toBe(more);
    expect(refreshNewest(page([msg('a', 0)]), page([], true)).messages).toEqual([]);
  });
});

describe('threadOf', () => {
  it('lists a thread root first, then its replies oldest first', () => {
    const root = msg('root', 0);
    const one = reply('r1', 1, root);
    const two = reply('r2', 2, one);
    const other = msg('other', 3);
    expect(threadOf([two, other, one, root], 'root').map((m) => m.id)).toEqual(['root', 'r1', 'r2']);
  });
});

describe('groupRuns', () => {
  it('groups one person close together, breaking on a new author or a long gap', () => {
    clock = Date.parse('2026-11-05T20:00:00.000Z');
    const list = [msg('a', 0), msg('b', 1), msg('c', 2, { author: 'ben' }), msg('d', 3, { author: 'ben' }), msg('e', 20, { author: 'ben' })];
    expect(groupRuns(list, (m) => m.author).map((r) => [r.message.id, r.showHeader, r.showTime])).toEqual([
      ['a', true, false],
      ['b', false, true],
      ['c', true, false],
      ['d', false, true],
      ['e', true, true],
    ]);
  });

  it('keeps a reply in its writer’s run', () => {
    const root = msg('a', 0);
    const runs = groupRuns([root, reply('b', 1, root)], (m) => m.author);
    expect(runs.map((r) => r.showHeader)).toEqual([true, false]);
  });
});
