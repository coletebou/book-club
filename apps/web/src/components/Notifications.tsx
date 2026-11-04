import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type BookDetail, type NotificationList, type NotificationView, type SessionInfo, formatWhen } from '@bookclub/shared';
import { type AnswerOpen, answerOpenText } from '../lib/answer-open';
import { api } from '../lib/api';
import { readingHere, showNote } from '../lib/note-opener';
import { keys, useChatDnd, useNotifications } from '../lib/queries';
import { Icon } from './Icon';
import { useToast } from './Toasts';

/**
 * "Ben replied: …" / "Ana got to your note" / "Ben mentioned you in …" (D49, D152). A reply or a
 * mention you cannot read yet comes without its words, and a reply says where its writer had read
 * to if that is what it waits for (D69); a mention says the same for its own spoiler fence (D150).
 */
export function describe(n: NotificationView): string {
  if (n.kind === 'mention') {
    if (n.text) return `${n.actorName} mentioned you: “${n.text}”`;
    return n.horizon ? `${n.actorName} mentioned you from ${n.horizon} · it opens when you get there` : `${n.actorName} mentioned you`;
  }
  if (n.kind !== 'reply') {
    // Batched per friend per chapter while unread (D145): a whole chapter caught up at once says
    // so once, as "got to N of your notes," not once per note.
    const count = n.count ?? 1;
    return count > 1 ? `${n.actorName} got to ${count} of your notes` : `${n.actorName} got to your note`;
  }
  if (n.text) return `${n.actorName} replied: “${n.text}”`;
  // A reply with no words, only a voice recording, photos or a video (D140): named, never shown.
  if (n.mediaKind) return `${n.actorName} replied with ${n.mediaKind === 'voice' ? 'a voice note' : n.mediaKind === 'video' ? 'a video' : 'a photo'}`;
  return n.horizon ? `${n.actorName} replied from ${n.horizon} · it opens when you get there` : `${n.actorName} replied`;
}

/** Where a notification goes: a mention to its club's chat, a reply or reached note to its book. */
function notificationHref(n: NotificationView): string {
  return n.kind === 'mention' ? `/clubs/${n.clubId}/chat` : `/books/${n.bookId}#note-${n.noteId}`;
}

/**
 * The bell: friends answering your notes, and friends reaching them. Opening it marks everything
 * read; a new one arrives live, with a toast.
 */
export function NotificationBell() {
  const list = useNotifications();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const unread = list.data?.unread ?? 0;

  const markAllRead = () => {
    if (!unread) return;
    qc.setQueryData<NotificationList>(keys.notifications, (old) => (old ? { unread: 0, items: old.items.map((n) => ({ ...n, read: true })) } : old));
    void api.readNotifications().catch(() => void qc.invalidateQueries({ queryKey: keys.notifications }));
  };

  return (
    <span
      className="bell"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="icon-btn"
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="bell"
        data-unread={unread}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) markAllRead();
        }}
      >
        <Icon name="bell" />
        {unread ? (
          <span className="bell-count" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="bell-panel" id={panelId} role="region" aria-label="Notifications" data-testid="bell-panel">
          {list.data && list.data.items.length > 0 ? (
            <ol className="bell-list">
              {list.data.items.map((n) => (
                <li key={n.id} className={n.read ? '' : 'is-new'}>
                  {/* To the note's conversation (marking the answer in it) or, for a mention, the club's chat. */}
                  <Link to={notificationHref(n)} state={n.kind !== 'mention' && n.commentId !== n.noteId ? { comment: n.commentId } : undefined} onClick={() => setOpen(false)} data-testid="notification">
                    <span className="bell-dot" style={{ background: n.actorColor }} aria-hidden="true" />
                    <span className="bell-text">
                      <span>{describe(n)}</span>
                      <span className="faint small">
                        {n.kind === 'mention' ? n.where : `${n.bookTitle} · ${n.where}`} · {formatWhen(n.createdAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small bell-empty">Nothing yet. When a friend answers one of your notes, or gets to it, you will see it here.</p>
          )}
        </div>
      ) : null}
    </span>
  );
}

/**
 * A new notification, said wherever you are: on the club's pages, and in the reader and the
 * player too, where the evening is spent (the bell itself is in the club pages' bar). Each toast
 * shows its conversation (D89): in the reader of its book, the note's sheet; elsewhere, the note on
 * the book page, as the bell's link does.
 */
export function NotificationToasts() {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Kept warm here (mounted for every signed-in page) so `onNew`, below, can read it synchronously
  // off the cache the instant a mention arrives, with no query of its own to wait on.
  useChatDnd();
  useEffect(() => {
    const onNew = (e: Event) => {
      const n = (e as CustomEvent<NotificationView>).detail;
      if (n.kind === 'mention') {
        // Do Not Disturb (D173): still recorded (the bell already has it by now), just said
        // quietly — no toast while it is on.
        if (qc.getQueryData<{ enabled: boolean }>(keys.chatDnd)?.enabled) return;
        toast.show(`${describe(n)} · ${n.clubName ?? 'Chat'}`, { action: { label: 'Show', run: () => void navigate(`/clubs/${n.clubId}/chat`) } });
        return;
      }
      // In the reader of its book, which book goes without saying.
      toast.show(readingHere(n.bookId!) ? describe(n) : `${describe(n)} · ${n.bookTitle}`, {
        action: { label: 'Show', run: () => showNote(navigate, { bookId: n.bookId!, noteId: n.noteId!, commentId: n.commentId! }) },
      });
    };
    // An answer that waited for you to read where its writer had (D69) is open now: said to those
    // in its conversation (lib/queries.ts, mergeRevealed), naming it.
    const onOpen = (e: Event) => {
      const open = (e as CustomEvent<AnswerOpen>).detail;
      const selfId = qc.getQueryData<SessionInfo>(keys.session)?.user?.id;
      const chapters = qc.getQueryData<BookDetail>(keys.book(open.note.bookId))?.chapters ?? [];
      toast.show(answerOpenText(open, selfId, chapters), {
        action: { label: 'Show', run: () => showNote(navigate, { bookId: open.note.bookId, noteId: open.note.id, commentId: open.answer.id }) },
      });
    };
    window.addEventListener('bc-notification', onNew);
    window.addEventListener('bc-answer-open', onOpen);
    return () => {
      window.removeEventListener('bc-notification', onNew);
      window.removeEventListener('bc-answer-open', onOpen);
    };
  }, [toast, qc, navigate]);
  return null;
}
