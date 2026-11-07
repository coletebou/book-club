import { describe, expect, it, vi } from 'vitest';
import { createComposerStore } from './composer';
import { type MentionCandidate, mentionDirectory } from './mentions';
import { createStore } from './store';

const member = (id: string, displayName: string): MentionCandidate => ({ target: { kind: 'member', id }, displayName });
const people = [member('ana', 'Ana'), member('ben', 'Ben Carter'), member('gs', 'Grant Smith'), member('gl', 'Grant Lee'), { target: { kind: 'agent', handle: 'cal' }, displayName: 'Cal', handle: 'cal' } as const];
let directory = mentionDirectory(people);

function composer() {
  return createComposerStore<{ id: string }>({ directory: () => directory, self: () => ({ kind: 'member', id: 'ana' }) });
}

/** Type `text` with the caret at its end, as each keystroke would report it. */
function type(store: ReturnType<typeof composer>, text: string) {
  store.input(text, text.length);
}

describe('createStore', () => {
  it('notifies listeners on change only, and stops after unsubscribe', () => {
    const store = createStore({ n: 0 });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set({ n: 1 });
    store.set((s) => s);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.set({ n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ n: 2 });
  });

  it('keeps notifying others when one listener throws, and still surfaces the error', async () => {
    const store = createStore(0);
    const errors: unknown[] = [];
    const onError = (err: unknown) => errors.push(err);
    process.on('uncaughtException', onError);
    try {
      const after = vi.fn();
      store.subscribe(() => {
        throw new Error('boom');
      });
      store.subscribe(after);
      store.set(1);
      expect(after).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors).toHaveLength(1);
    } finally {
      process.off('uncaughtException', onError);
    }
  });
});

describe('createComposerStore', () => {
  it('opens the picker on @, narrows it as the name is typed, and never offers yourself', () => {
    const store = composer();
    type(store, 'hi @');
    expect(store.getState().mention!.candidates.map((c) => c.displayName)).toEqual(['Ben Carter', 'Cal', 'Grant Lee', 'Grant Smith']);
    type(store, 'hi @gr');
    expect(store.getState().mention!.candidates.map((c) => c.displayName)).toEqual(['Grant Lee', 'Grant Smith']);
    type(store, 'hi @zz');
    expect(store.getState().mention).toBeNull();
  });

  it('moves the highlight with wrapping and keeps it on the same person as the list narrows', () => {
    const store = composer();
    type(store, '@');
    store.move(-1);
    expect(store.getState().mention!.active).toBe(3);
    store.move(1);
    expect(store.getState().mention!.active).toBe(0);
    store.move(3); // Grant Smith
    type(store, '@g');
    expect(store.getState().mention!.candidates[store.getState().mention!.active]!.displayName).toBe('Grant Smith');
  });

  it('writes the pick and stays closed through the space after it, until a new @', () => {
    const store = composer();
    type(store, 'hey @gr');
    store.move(1);
    expect(store.pick()).toEqual({ text: 'hey @Grant Smith ', caret: 17 });
    expect(store.getState()).toMatchObject({ text: 'hey @Grant Smith ', caret: 17, mention: null });
    type(store, 'hey @Grant Smith a');
    expect(store.getState().mention).toBeNull();
    type(store, 'hey @Grant Smith and @b');
    expect(store.getState().mention!.candidates.map((c) => c.displayName)).toEqual(['Ben Carter']);
  });

  it('opens again when the person edits back into a picked name', () => {
    const store = composer();
    type(store, '@be');
    store.pick();
    type(store, '@Be');
    expect(store.getState().mention!.candidates.map((c) => c.displayName)).toEqual(['Ben Carter']);
  });

  it('stays dismissed while the dismissed name is typed on, and reopens after deleting the @', () => {
    const store = composer();
    type(store, '@g');
    store.dismiss();
    expect(store.getState().mention).toBeNull();
    type(store, '@gr');
    expect(store.getState().mention).toBeNull();
    type(store, '');
    type(store, '@g');
    expect(store.getState().mention).not.toBeNull();
  });

  it('picks by index, and does nothing without a picker', () => {
    const store = composer();
    expect(store.pick()).toBeNull();
    store.dismiss();
    type(store, '@c');
    expect(store.pick(0)).toEqual({ text: '@cal ', caret: 5 });
  });

  it('holds the message being answered, and clears everything after a send', () => {
    const store = composer();
    const target = { id: 'm1' };
    store.replyTo(target);
    type(store, 'yes @');
    expect(store.getState().replyTo).toBe(target);
    store.clear();
    expect(store.getState()).toEqual({ text: '', caret: 0, replyTo: null, mention: null, attachments: [] });
  });

  it('ranks again when who can be mentioned changes', () => {
    const store = composer();
    type(store, '@d');
    expect(store.getState().mention).toBeNull();
    directory = mentionDirectory([...people, member('dee', 'Dee')]);
    store.refresh();
    expect(store.getState().mention!.candidates.map((c) => c.displayName)).toEqual(['Dee']);
    directory = mentionDirectory(people);
  });

  it('ignores a report of the same text and caret', () => {
    const store = composer();
    type(store, 'same');
    const before = store.getState();
    type(store, 'same');
    expect(store.getState()).toBe(before);
  });
});
