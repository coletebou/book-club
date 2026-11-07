import {
  type MentionCandidate,
  type MentionDirectory,
  type MentionQuery,
  type MentionTarget,
  applyMention,
  mentionQueryAt,
  mentionTokenFor,
  rankMentionCandidates,
  sameTarget,
} from './mentions';
import { type ComposerAttachment } from './attachments';
import { type Store, createStore } from './store';

/**
 * The composer's state, kept outside any UI framework: what is typed, where the caret is, which
 * message is being answered, the @-mention picker, and the pictures added (attachments.ts). The UI renders the snapshot and reports
 * what the person did (`input`, `move`, `pick`, `dismiss`, `replyTo`); everything about which
 * mention is being typed, who is offered and what a pick writes is decided here, by the same
 * mention rules the server reads messages with (mentions.ts).
 */

export interface MentionPicker {
  readonly query: MentionQuery;
  readonly candidates: readonly MentionCandidate[];
  /** The highlighted candidate's index. */
  readonly active: number;
}

export interface ComposerState<R> {
  readonly text: string;
  readonly caret: number;
  /** The message being answered, as the app describes it (shown above the input), or null. */
  readonly replyTo: R | null;
  /** The open mention picker, or null. */
  readonly mention: MentionPicker | null;
  /** Pictures added, in the order they were picked. */
  readonly attachments: readonly ComposerAttachment[];
}

/** Whether there is something to send: words, or a picture that came through, and nothing still uploading. */
export function canSend(state: Pick<ComposerState<unknown>, 'text' | 'attachments'>): boolean {
  if (state.attachments.some((a) => a.status === 'uploading')) return false;
  return state.text.trim().length > 0 || state.attachments.some((a) => a.status === 'ready');
}

/** The server ids of the pictures that came through, in the order they were picked. */
export function readyAttachmentIds(state: Pick<ComposerState<unknown>, 'attachments'>): string[] {
  return state.attachments.flatMap((a) => (a.status === 'ready' && a.id ? [a.id] : []));
}

export interface ComposerStore<R> extends Store<ComposerState<R>> {
  /** The text or the caret changed: typing, a paste, a tap or arrow key moving the caret. */
  readonly input: (text: string, caret: number) => void;
  /** Move the picker's highlight (-1 up, +1 down), wrapping at either end. */
  readonly move: (delta: number) => void;
  /** Pick the highlighted candidate (or the one at `index`): the field's new text and caret, or null with no picker open. */
  readonly pick: (index?: number) => { text: string; caret: number } | null;
  /** Close the picker for the name being typed (Escape); it stays closed while that name is typed on. */
  readonly dismiss: () => void;
  /** Start answering a message, or stop (null). */
  readonly replyTo: (target: R | null) => void;
  /**
   * Add pictures (a pick, a paste, a drop), each in a slot of its own in the order given, as many as
   * still fit under `max`: their keys, to report each upload's outcome by. Those past the limit are
   * not added (the returned list is shorter).
   */
  readonly addAttachments: (files: readonly { readonly name: string; readonly preview?: string | null }[], max?: number) => string[];
  /** An upload came through: its server id. */
  readonly attachmentReady: (key: string, id: string) => void;
  /** An upload did not: why. */
  readonly attachmentFailed: (key: string, error: string) => void;
  /** Take a picture out: the one taken (for the app to free its preview and discard its upload), or null. */
  readonly removeAttachment: (key: string) => ComposerAttachment | null;
  /** After a send: no text, no reply, no picker, no pictures. */
  readonly clear: () => void;
  /** Rank the open picker again (who can be mentioned changed). */
  readonly refresh: () => void;
}

export interface ComposerOptions {
  /** Who can be mentioned right now (read on every keystroke, so it can change). */
  readonly directory: () => MentionDirectory;
  /** Who is writing: never offered themselves. */
  readonly self?: () => MentionTarget | null;
  /** How many candidates the picker shows at most (default 6). */
  readonly limit?: number;
}

export function createComposerStore<R>(options: ComposerOptions): ComposerStore<R> {
  const store = createStore<ComposerState<R>>({ text: '', caret: 0, replyTo: null, mention: null, attachments: [] });
  let nextKey = 1;
  const patch = (key: string, change: Partial<ComposerAttachment>) =>
    store.set((s) => (s.attachments.some((a) => a.key === key) ? { ...s, attachments: s.attachments.map((a) => (a.key === key ? { ...a, ...change } : a)) } : s));
  /**
   * The mention the person just completed or dismissed: its picker stays closed while what is
   * typed there still starts with what it held then (so it does not reopen on the space after a
   * pick), and opens again once they edit back into it or type a new `@`.
   */
  let quiet: { readonly start: number; readonly prefix: string } | null = null;

  const pickerFor = (text: string, caret: number, previous: MentionPicker | null): MentionPicker | null => {
    if (quiet && text[quiet.start] !== '@') quiet = null;
    const query = mentionQueryAt(text, caret);
    if (!query) return null;
    if (quiet && query.start === quiet.start && query.query.startsWith(quiet.prefix)) return null;
    quiet = null;
    const candidates = rankMentionCandidates(query.query, options.directory().candidates, { limit: options.limit ?? 6, exclude: options.self?.() ?? null });
    if (candidates.length === 0) return null;
    // Keep the highlight on the same person while the list narrows around them.
    const was = previous && previous.query.start === query.start ? previous.candidates[previous.active] : undefined;
    const kept = was ? candidates.findIndex((c) => sameTarget(c.target, was.target)) : -1;
    return { query, candidates, active: kept === -1 ? 0 : kept };
  };

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    input: (text, caret) => store.set((s) => (s.text === text && s.caret === caret ? s : { ...s, text, caret, mention: pickerFor(text, caret, s.mention) })),
    move: (delta) =>
      store.set((s) => {
        if (!s.mention) return s;
        const n = s.mention.candidates.length;
        return { ...s, mention: { ...s.mention, active: (((s.mention.active + delta) % n) + n) % n } };
      }),
    pick: (index) => {
      const s = store.getState();
      const picker = s.mention;
      const candidate = picker?.candidates[index ?? picker.active];
      if (!picker || !candidate) return null;
      const directory = options.directory();
      const next = applyMention(s.text, picker.query, candidate, directory);
      quiet = { start: picker.query.start, prefix: mentionTokenFor(candidate, directory) };
      store.set({ ...s, text: next.text, caret: next.caret, mention: null });
      return next;
    },
    dismiss: () => {
      const s = store.getState();
      if (!s.mention) return;
      quiet = { start: s.mention.query.start, prefix: s.mention.query.query };
      store.set({ ...s, mention: null });
    },
    replyTo: (target) => store.set((s) => (s.replyTo === target ? s : { ...s, replyTo: target })),
    addAttachments: (files, max = Number.POSITIVE_INFINITY) => {
      const room = Math.max(0, max - store.getState().attachments.length);
      const added: ComposerAttachment[] = files.slice(0, room).map((f) => ({ key: `a${nextKey++}`, name: f.name, status: 'uploading', id: null, preview: f.preview ?? null, error: null }));
      if (added.length > 0) store.set((s) => ({ ...s, attachments: [...s.attachments, ...added] }));
      return added.map((a) => a.key);
    },
    attachmentReady: (key, id) => patch(key, { status: 'ready', id, error: null }),
    attachmentFailed: (key, error) => patch(key, { status: 'failed', error }),
    removeAttachment: (key) => {
      const taken = store.getState().attachments.find((a) => a.key === key) ?? null;
      if (taken) store.set((s) => ({ ...s, attachments: s.attachments.filter((a) => a.key !== key) }));
      return taken;
    },
    clear: () => {
      quiet = null;
      store.set({ text: '', caret: 0, replyTo: null, mention: null, attachments: [] });
    },
    refresh: () => store.set((s) => ({ ...s, mention: pickerFor(s.text, s.caret, s.mention) })),
  };
}
