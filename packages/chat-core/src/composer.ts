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
import { type Store, createStore } from './store';

/**
 * The composer's state, kept outside any UI framework: what is typed, where the caret is, which
 * message is being answered, and the @-mention picker. The UI renders the snapshot and reports
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
  /** After a send: no text, no reply, no picker. */
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
  const store = createStore<ComposerState<R>>({ text: '', caret: 0, replyTo: null, mention: null });
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
    clear: () => {
      quiet = null;
      store.set({ text: '', caret: 0, replyTo: null, mention: null });
    },
    refresh: () => store.set((s) => ({ ...s, mention: pickerFor(s.text, s.caret, s.mention) })),
  };
}
