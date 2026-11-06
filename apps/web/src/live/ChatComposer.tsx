import { type KeyboardEvent, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ComposerStore, MentionCandidate } from '@bookclub/chat-core';
import { Avatar } from '../components/People';
import { Icon } from '../components/Icon';
import type { ReplyTarget } from '../lib/chat-model';

/** How tall the composer grows with a long message before it scrolls inside itself instead. */
const MAX_COMPOSER_PX = 120;

interface Props {
  readonly store: ComposerStore<ReplyTarget>;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly placeholder: string;
  readonly sending: boolean;
  /** "Spoiler up to <your chapter>", offered in a book's channel (D150). */
  readonly spoiler: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void } | null;
  /** In a thread with nothing picked to answer, what the reply bar says instead ("Replying in the thread"). */
  readonly threadNote?: string | null;
  /** Why sending is not possible here right now, said in the composer instead of a send button. */
  readonly blocked?: string | null;
  /** A candidate's colour in the club, for their avatar in the picker. */
  readonly colorOf: (candidate: MentionCandidate) => string | undefined;
  readonly onSend: () => void;
  readonly onTyping: () => void;
}

/**
 * The chat composer (D173's one auto-growing line and paper-plane send), with @-mention
 * autocomplete (D201) and the message being answered (D200). Its state lives in chat-core's
 * composer store, outside React: this component only draws the snapshot and reports keystrokes,
 * caret moves and picks, so what is offered and what a pick writes follow the very rules the
 * server reads mentions by.
 *
 * Keyboard: with the picker open, ↑/↓ move, Enter or Tab picks, Escape closes it; never while an
 * input method is still composing a character (a Japanese or Chinese keyboard's own Enter). The
 * picker's options take no focus (mousedown is held back), so a tap on one never closes the
 * phone's keyboard.
 */
export function ChatComposer({ store, inputRef, placeholder, sending, spoiler, threadNote = null, blocked = null, colorOf, onSend, onTyping }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const listId = useId();
  const caretAfter = useRef<number | null>(null);
  // The picker shows only while the field has the focus: tapping elsewhere hides it, and coming
  // back to the name being typed brings it back (a blur is not a dismissal).
  const [focused, setFocused] = useState(false);
  const picker = focused ? state.mention : null;
  const optionId = (i: number) => `${listId}-option-${i}`;

  // A single-line composer that grows with what is typed, up to MAX_COMPOSER_PX, then scrolls.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`;
  }, [state.text, inputRef]);

  // After a pick the field's text is the store's: put the caret after the name it wrote.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || caretAfter.current === null) return;
    el.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [state.text, inputRef]);

  const pick = (index?: number) => {
    const before = store.getState().text;
    const next = store.pick(index);
    if (!next) return;
    // The text the field holds changes with the next render, and the caret is put right then; a
    // pick that changes nothing (the name was already typed out) has no render to wait for.
    if (next.text === before) inputRef.current?.setSelectionRange(next.caret, next.caret);
    else caretAfter.current = next.caret;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // An input method still composing a character owns its own Enter: `isComposing`, and Safari's
    // keyCode 229 for the Enter that ends a composition (its isComposing is already false then).
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (picker) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        store.move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        store.dismiss();
        return;
      }
    }
    if (e.key === 'Escape' && state.replyTo) {
      e.preventDefault();
      e.stopPropagation();
      store.replyTo(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const reportCaret = () => {
    const el = inputRef.current;
    // React reports a select on the very keydown that picked (Enter, with the caret moved since it
    // last looked: text pasted, dictated or put in by a phone's suggestions), after the pick wrote
    // the store and before the render that puts it in the field: what the field holds then is what
    // the pick replaced, and taking it back would undo the pick. The caret is put right with that
    // render (the layout effect above).
    if (el && el.value === store.getState().text) store.input(el.value, el.selectionEnd ?? el.value.length);
  };

  return (
    <form
      className="chat-composer"
      data-testid="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      {state.replyTo ? (
        <div className="chat-reply-bar" data-testid="chat-reply-bar">
          <Icon name="reply" size={14} />
          <span className="chat-reply-bar-text">
            Replying to <strong style={{ color: state.replyTo.authorColor }}>{state.replyTo.authorName}</strong>
            {state.replyTo.text ? <span className="chat-reply-bar-quote"> {state.replyTo.text}</span> : null}
          </span>
          <button type="button" className="icon-btn" aria-label="Stop replying" data-testid="chat-reply-cancel" onClick={() => store.replyTo(null)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : threadNote ? (
        <div className="chat-reply-bar is-thread" data-testid="chat-thread-note">
          <Icon name="reply" size={14} />
          <span className="chat-reply-bar-text">{threadNote}</span>
        </div>
      ) : null}
      {spoiler ? (
        <label className="chat-spoiler-toggle">
          <input type="checkbox" checked={spoiler.checked} onChange={(e) => spoiler.onChange(e.target.checked)} data-testid="chat-spoiler-toggle" />
          {spoiler.label}
        </label>
      ) : null}
      {blocked ? (
        <p className="muted small chat-blocked" data-testid="chat-blocked">
          {blocked}
        </p>
      ) : (
        <div className="chat-input-row">
          {picker ? (
            <ul className="chat-mention-picker" id={listId} role="listbox" aria-label="People you can mention" data-testid="chat-mention-picker">
              {picker.candidates.map((c, i) => (
                <li
                  key={c.target.kind === 'member' ? `m:${c.target.id}` : `a:${c.target.handle}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === picker.active}
                  className={`chat-mention-option${i === picker.active ? ' is-active' : ''}`}
                  data-testid="chat-mention-option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                >
                  <Avatar name={c.displayName} color={colorOf(c) ?? 'var(--surface-3)'} size={22} />
                  <span className="chat-mention-name">{c.displayName}</span>
                  {c.target.kind === 'agent' ? <span className="chat-mention-handle">@{c.handle ?? c.target.handle}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={inputRef}
            value={state.text}
            onChange={(e) => {
              store.input(e.target.value, e.target.selectionEnd ?? e.target.value.length);
              onTyping();
            }}
            onSelect={reportCaret}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={placeholder}
            rows={1}
            aria-label="Write a message"
            aria-autocomplete="list"
            aria-controls={picker ? listId : undefined}
            aria-activedescendant={picker ? optionId(picker.active) : undefined}
            data-testid="chat-input"
          />
          <button type="submit" className="btn btn-primary chat-send" disabled={!state.text.trim() || sending} aria-label="Send" data-testid="chat-send">
            <Icon name="send" size={18} />
          </button>
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {picker ? `${picker.candidates.length} ${picker.candidates.length === 1 ? 'person' : 'people'} to mention. Up and down to choose, Enter to pick.` : ''}
      </p>
    </form>
  );
}
