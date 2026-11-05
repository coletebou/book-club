import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type BookSummary, type ChatMessageView, chapterLabel } from '@bookclub/shared';
import { Avatar } from '../components/People';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { keys, useBook, useChat } from '../lib/queries';
import { realtime, useChatTyping } from '../lib/realtime';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
/** Consecutive messages from the same person, this close together, read as one turn (D173):
 * the second one on need not repeat their name, avatar and the time — a messaging app's own
 * convention, not this app's invention. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** How tall the composer grows with a long message before it scrolls inside itself instead. */
const MAX_COMPOSER_PX = 120;

function names(list: readonly string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

interface GroupedMessage {
  readonly m: ChatMessageView;
  /** First of its run: shows the avatar and the name; a later one in the same run omits them. */
  readonly showHeader: boolean;
  /** Last of its run: a small, muted time caption trails it — a footer, never a heading. */
  readonly showTime: boolean;
}

/** Oldest-first messages, marked with which ones start/end a "turn" (D173: compact grouping). */
function groupMessages(ordered: readonly ChatMessageView[]): GroupedMessage[] {
  const at = (m: ChatMessageView) => new Date(m.createdAt).getTime();
  return ordered.map((m, i) => {
    const prev = ordered[i - 1];
    const next = ordered[i + 1];
    const showHeader = !prev || prev.author.userId !== m.author.userId || at(m) - at(prev) > GROUP_WINDOW_MS;
    const showTime = !next || next.author.userId !== m.author.userId || at(next) - at(m) > GROUP_WINDOW_MS;
    return { m, showHeader, showTime };
  });
}

/**
 * Live text chat (D150-D152, D173): one stream per club, each message optionally tagged to a book, with
 * the chips as channels (D199): General shows the untagged messages, a book's chip only that book's,
 * and what you send goes to the channel you are looking at. An optional spoiler fence ("up to <chapter>") gated the same way a note is. Delivery is the
 * existing hub (lib/realtime.ts merges `chat:new`/`chat:updated`/`chat:deleted` into this query's
 * cache); typing and read cursors are the only parts that go straight over the socket. Shared by
 * the standalone `/clubs/:clubId/chat` page and the sheet opened over the reader/player (ChatSheet.tsx).
 */
export function ChatPanel({ clubId, books, selfId }: { clubId: string; books: readonly BookSummary[]; selfId: string | undefined }) {
  const toast = useToast();
  const qc = useQueryClient();
  const typing = useChatTyping(clubId, null);
  const [text, setText] = useState('');
  const [bookId, setBookId] = useState('');
  // The channel being looked at (D199) is the one a message is sent to: General, or a book's.
  const chat = useChat(clubId, bookId || 'general');
  const [spoiler, setSpoiler] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  /** Which message's reactions-and-actions popover is open (one at a time, D173's overflow menu). */
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const book = useBook(bookId || undefined);
  // The default suggestion: your own furthest place in the book this message is tagged to.
  const myChapter = useMemo(() => {
    if (!book.data) return null;
    const mine = book.data.progress.find((p) => p.userId === selfId);
    return mine ? { t: mine.t, label: chapterLabel(book.data.chapters, mine.t) } : null;
  }, [book.data, selfId]);

  // Someone ahead of the club reading this book: a sensible default to suggest the fence.
  useEffect(() => {
    if (!book.data || !myChapter) return;
    const anyoneBehind = book.data.progress.some((p) => p.userId !== selfId && p.t < myChapter.t - 0.01);
    setSpoiler(anyoneBehind);
  }, [book.data, myChapter, selfId]);

  useEffect(() => {
    const items = chat.data?.messages;
    if (!items || items.length === 0) return;
    // Looking at the panel: mark the newest message read, which resets the club's unread badge.
    void api.markChatRead(clubId, items[0]!.id).then(() => qc.invalidateQueries({ queryKey: keys.chatUnread(clubId) }));
  }, [chat.data?.messages, clubId, qc]);

  // The one open popover closes on a tap outside it (its own trigger stays able to close it too).
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.chat-message-menu, .chat-message-menu-btn')) return;
      setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  // A single-line composer that grows with what is typed, up to MAX_COMPOSER_PX, then scrolls.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`;
  }, [text]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await api.postChat(clubId, { text: value, bookId: bookId || null, spoilerUpToT: bookId && spoiler && myChapter ? myChapter.t : undefined });
      setText('');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not send that.', 'error');
    } finally {
      setSending(false);
    }
  };

  const onType = (value: string) => {
    setText(value);
    if (typingTimer.current) return;
    realtime()?.sendChatTyping(clubId, null);
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null;
    }, 3000);
  };

  const react = async (m: ChatMessageView, emoji: string) => {
    const mine = !m.hidden && m.reactions.some((r) => r.emoji === emoji && r.mine);
    try {
      await (mine ? api.unreactChat(m.id, emoji) : api.reactChat(m.id, emoji));
    } catch {
      toast.show('Could not react to that.', 'error');
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const value = editing.text.trim();
    if (!value) return;
    try {
      await api.editChat(editing.id, value);
      setEditing(null);
    } catch {
      toast.show('Could not save that edit.', 'error');
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteChat(id);
    } catch {
      toast.show('Could not delete that message.', 'error');
    }
  };

  /** A tap anywhere on a bubble opens its menu too (not just the small corner button a pointer
   * can hover to find) — except a tap on something already its own control. */
  const onBubbleClick = (m: ChatMessageView) => (e: ReactMouseEvent<HTMLDivElement>) => {
    if (m.hidden || m.deleted || editing?.id === m.id) return;
    if ((e.target as HTMLElement).closest('.chat-reaction, .chat-message-menu, .chat-edit, a')) return;
    setOpenMenu((cur) => (cur === m.id ? null : m.id));
  };

  const typers = [...typing.values()].map((t) => t.displayName);
  const messages = chat.data?.messages ?? [];
  // Newest message at the end of the array (bottom of the list): api.chat returns newest-first.
  const grouped = useMemo(() => groupMessages([...(chat.data?.messages ?? [])].reverse()), [chat.data?.messages]);

  // Newest message at the bottom, scrolled into view as one arrives.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <section className="chat-panel" aria-label="Club chat" data-testid="chat-panel">
      {books.length > 0 ? (
        <nav className="chat-channels" aria-label="Chat channel" data-testid="chat-channel-switcher">
          <button
            type="button"
            className={`chat-channel-chip${bookId === '' ? ' is-active' : ''}`}
            aria-pressed={bookId === ''}
            data-testid="chat-channel-chip"
            data-book-id=""
            onClick={() => setBookId('')}
          >
            General
          </button>
          {books.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`chat-channel-chip${bookId === b.id ? ' is-active' : ''}`}
              aria-pressed={bookId === b.id}
              data-testid="chat-channel-chip"
              data-book-id={b.id}
              onClick={() => setBookId(b.id)}
            >
              {b.title}
            </button>
          ))}
        </nav>
      ) : null}
      <ul className="chat-messages" ref={listRef} data-testid="chat-messages">
        {grouped.map(({ m, showHeader, showTime }) => {
          // No book tag on a bubble: every message here is already in the channel being viewed (D199).
          const hasSub = !m.hidden && !!m.editedAt;
          return (
            <li
              key={m.id}
              className={`chat-message${m.mine ? ' is-mine' : ''}${showHeader ? '' : ' is-grouped'}`}
              data-testid="chat-message"
              data-hidden={m.hidden}
              data-message-id={m.id}
            >
              <div className="chat-message-row">
                {!m.mine ? (
                  showHeader ? <Avatar name={m.author.displayName} color={m.author.color} size={28} /> : <span className="chat-avatar-spacer" aria-hidden="true" />
                ) : null}
                {/* The click is a touch/mouse convenience only (opens the same menu the real,
                    keyboard-focusable `chat-message-menu-btn` below does) — the bubble itself
                    stays plain markup, not a second, redundant control for the same action. */}
                <div className="chat-bubble" onClick={onBubbleClick(m)}>
                  {showHeader && !m.mine ? (
                    <div className="chat-meta">
                      <strong style={{ color: m.author.color }}>{m.author.displayName}</strong>
                    </div>
                  ) : null}
                  {hasSub ? (
                    <div className="chat-meta-sub">
                      {!m.hidden && m.editedAt ? <span className="muted small">(edited)</span> : null}
                    </div>
                  ) : null}
                  {m.hidden ? (
                    <p className="chat-text chat-spoiler" data-testid="chat-spoiler-marker">
                      <Icon name="lock" size={14} /> {m.spoilerLabel}
                    </p>
                  ) : editing?.id === m.id ? (
                    <div className="chat-edit">
                      <textarea
                        value={editing.text}
                        onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        rows={2}
                        aria-label="Edit message"
                      />
                      <button type="button" className="btn btn-small" onClick={() => void saveEdit()}>
                        Save
                      </button>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <p className="chat-text">
                      {m.deleted ? <em className="muted">Message deleted</em> : m.text}
                      {!m.deleted && m.spoilerLabel ? <span className="chat-spoiler-tag"> ({m.spoilerLabel})</span> : null}
                    </p>
                  )}
                  {!m.hidden && !m.deleted && m.reactions.length > 0 ? (
                    <div className="chat-reactions">
                      {m.reactions.map((r) => (
                        <button key={r.emoji} type="button" className={`chat-reaction${r.mine ? ' is-mine' : ''}`} onClick={() => void react(m, r.emoji)}>
                          {r.emoji} {r.count}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {!m.hidden && !m.deleted ? (
                    <button
                      type="button"
                      className="icon-btn chat-message-menu-btn"
                      aria-label="React, or more"
                      aria-expanded={openMenu === m.id}
                      data-testid="chat-message-menu-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenu(openMenu === m.id ? null : m.id);
                      }}
                    >
                      <Icon name="more" size={14} />
                    </button>
                  ) : null}
                  {!m.hidden && !m.deleted && openMenu === m.id ? (
                    <div className="chat-message-menu" data-testid="chat-message-menu">
                      <div className="chat-reaction-picker-open">
                        {QUICK_REACTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="chat-reaction-add"
                            aria-label={`React ${emoji}`}
                            onClick={() => {
                              void react(m, emoji);
                              setOpenMenu(null);
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                      {m.mine ? (
                        <div className="chat-message-menu-actions">
                          <button
                            type="button"
                            className="btn btn-small btn-ghost"
                            data-testid="chat-message-edit"
                            onClick={() => {
                              setEditing({ id: m.id, text: m.text ?? '' });
                              setOpenMenu(null);
                            }}
                          >
                            <Icon name="edit" size={14} /> Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-small btn-ghost"
                            data-testid="chat-message-delete"
                            onClick={() => {
                              void remove(m.id);
                              setOpenMenu(null);
                            }}
                          >
                            <Icon name="trash" size={14} /> Delete
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
              {showTime ? <time className="chat-time muted small">{new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> : null}
            </li>
          );
        })}
        {messages.length === 0 ? <li className="muted small">No messages yet. Say hello.</li> : null}
      </ul>
      <p className="chat-typing" role="status" aria-live="polite" data-testid="chat-typing">
        {typers.length > 0 ? `${names(typers)} ${typers.length === 1 ? 'is' : 'are'} typing…` : ''}
      </p>
      <form
        className="chat-composer"
        data-testid="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {bookId && myChapter ? (
          <label className="chat-spoiler-toggle">
            <input type="checkbox" checked={spoiler} onChange={(e) => setSpoiler(e.target.checked)} data-testid="chat-spoiler-toggle" />
            Spoiler up to {myChapter.label}
          </label>
        ) : null}
        <div className="chat-input-row">
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Message the club…"
            rows={1}
            aria-label="Write a message"
            data-testid="chat-input"
          />
          <button type="submit" className="btn btn-primary chat-send" disabled={!text.trim() || sending} aria-label="Send" data-testid="chat-send">
            <Icon name="send" size={18} />
          </button>
        </div>
      </form>
    </section>
  );
}
