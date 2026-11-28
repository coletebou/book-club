import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type MentionCandidate, canSend, createComposerStore, groupRuns, imageFilesFrom, readyAttachmentIds, threadOf } from '@coletebou/chat-core';
import { type BookSummary, type ChatAttachmentView, type ChatMessageView, type ServerMessage, LIMITS, chapterLabel } from '@bookclub/shared';
import { Icon } from '../components/Icon';
import { openCal } from '../cal/calStore';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { draftStorageKey, readStoredDraft, writeStoredDraft } from '../lib/composer-drafts';
import { useBrowserOnline } from '../lib/online';
import { type ReplyTarget, directoryOf, memberTarget, possibleAgentHandles, replyTargetOf, sentOutsideTo } from '../lib/chat-model';
import { useMemberBlocksGeneration } from '../lib/moderation';
import { moderationGeneration } from '../lib/moderation-cache';
import { keys, loadOlderChat, removeChatMessage, toThreadCache, useBook, useChat, useChatAgents, useChatThread, useClub } from '../lib/queries';
import { realtime, useChatTyping } from '../lib/realtime';
import { revealRenderedChatMessage, useChatListScroll } from './chat-scroll';
import { type ChatChannelListHandle, ChatChannelList } from './ChatChannelList';
import { ChatComposer } from './ChatComposer';
import { ChatLightbox } from './ChatImages';
import { type ChatEditing, type ChatMessageActions, type ChatMessagePlacement, ChatMessageItem } from './ChatMessageItem';

/** How long a message jumped to glows, so the eye finds it (D200). */
const HIGHLIGHT_MS = 2200;

// The reader's sheet can be reopened while a draft is on the way. Share the pending send
// with the next composer in this tab and tell it when the submitted text can be cleared.
const pendingDrafts = new Set<string>();
const draftEvents = new EventTarget();
function subscribePendingDrafts(listener: () => void) {
  draftEvents.addEventListener('pending', listener);
  return () => draftEvents.removeEventListener('pending', listener);
}

function names(list: readonly string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * Live text chat (D150-D152, D173): one stream per club, each message optionally tagged to a book, with
 * the chips as channels (D199): General shows the untagged messages, a book's chip only that book's,
 * and what you send goes to the channel you are looking at. An optional spoiler fence ("up to <chapter>")
 * gated the same way a note is. Delivery is the existing hub (lib/realtime.ts merges `chat:new`/
 * `chat:updated`/`chat:deleted` into this query's cache); typing and read cursors are the only parts that
 * go straight over the socket. Shared by the standalone `/clubs/:clubId/chat` page and the sheet opened
 * over the reader/player (ChatSheet.tsx).
 *
 * Replies (D200) are a messaging app's: inline in the stream, each with a quote of what it answers;
 * tapping a quote goes to that message, in place when it is on screen, else in its thread, which
 * also opens from a root's "N replies" and reads on its own, with the composer answering in it.
 * @-mentions (D201) are offered as you type, highlighted as the server read them, and a message
 * that mentions you is marked. `focusMessageId` (a link from the bell) opens the message's channel
 * and goes to it.
 */
export function ChatPanel({ clubId, books, selfId, focusMessageId = null }: { clubId: string; books: readonly BookSummary[]; selfId: string | undefined; focusMessageId?: string | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const club = useClub(clubId);
  const [bookId, setBookId] = useState('');
  // Members type club-wide; an agent works in the channel it answers in (D204): both are shown here.
  const typingAnywhere = useChatTyping(clubId, null);
  const typingHere = useChatTyping(clubId, bookId || 'general');
  // The channel being looked at (D199) is the one a message is sent to: General, or a book's.
  const channel = bookId || 'general';
  const chat = useChat(clubId, channel);
  const [spoiler, setSpoiler] = useState(false);
  const [editing, setEditing] = useState<ChatEditing | null>(null);
  const [sending, setSending] = useState(false);
  /** Which message's reactions-and-actions popover is open (one at a time, D173's overflow menu). */
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  /** The thread open on its own (D200), by its root. */
  const [thread, setThread] = useState<string | null>(null);
  const threadQuery = useChatThread(thread);
  const [highlight, setHighlight] = useState<string | null>(null);
  /** A message to go to once the list that should hold it has rendered. */
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  /** A message a link asked for (`focusMessageId`), until its channel has loaded. */
  const [focusTarget, setFocusTarget] = useState<{ id: string; rootId: string; channel: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** A message's pictures open full size (D203). */
  const [lightbox, setLightbox] = useState<{ images: readonly ChatAttachmentView[]; index: number; authorName: string } | null>(null);
  const blocksGeneration = useMemberBlocksGeneration();
  const seenBlocks = useRef(blocksGeneration);
  /** Something is being dragged over the panel that a drop would add as pictures. */
  const [dragging, setDragging] = useState(false);
  const online = useBrowserOnline();
  const channelList = useRef<ChatChannelListHandle>(null);
  const threadListRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Who can be mentioned (D201, D204): the club's members and its agents, read by the composer on every keystroke.
  const members = club.data?.members;
  const agentList = useChatAgents(clubId);
  const agents = agentList.data?.agents;
  // Until the club's agents are known nothing is offered: a pick written without them could read
  // back on the server as an agent (`@Cal` for a Cal Smith, D204).
  const agentsKnown = agentList.isSuccess || agentList.isError;
  const directory = useMemo(() => directoryOf(agentsKnown ? (members ?? []) : [], agents ?? []), [members, agents, agentsKnown]);
  const directoryRef = useRef(directory);
  const selfRef = useRef(selfId);
  const [composer] = useState(() =>
    createComposerStore<ReplyTarget>({ directory: () => directoryRef.current, self: () => (selfRef.current ? memberTarget(selfRef.current) : null) }),
  );
  const draftScope = JSON.stringify([clubId, selfId, channel, thread]);
  const draftKey = draftStorageKey('chat', selfId, clubId, channel, thread);
  const activeDraftScope = useRef<string | null>(null);
  const draftPending = useSyncExternalStore(subscribePendingDrafts, () => !!draftKey && pendingDrafts.has(draftKey));
  useLayoutEffect(() => {
    let text = readStoredDraft(draftKey);
    composer.input(text, text.length);
    activeDraftScope.current = draftScope;
    const unsubscribe = composer.subscribe(() => {
      const next = composer.getState().text;
      if (next === text) return;
      if (next || readStoredDraft(draftKey) === text) writeStoredDraft(draftKey, next);
      text = next;
    });
    const clearSubmitted = (key: string | null, submitted: string | null) => {
      if (key === draftKey && submitted && composer.getState().text === submitted) composer.input('', 0);
    };
    const onSent = (event: Event) => {
      const { key, text } = (event as CustomEvent<{ key: string; text: string }>).detail;
      clearSubmitted(key, text);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.newValue === null) clearSubmitted(event.key, event.oldValue);
    };
    draftEvents.addEventListener('sent', onSent);
    window.addEventListener('storage', onStorage);
    return () => {
      activeDraftScope.current = null;
      window.removeEventListener('storage', onStorage);
      draftEvents.removeEventListener('sent', onSent);
      unsubscribe();
    };
  }, [composer, draftKey, draftScope]);
  useLayoutEffect(() => {
    if (seenBlocks.current === blocksGeneration) return;
    seenBlocks.current = blocksGeneration;
    // These surfaces hold their own copy even after the underlying queries have refreshed.
    setLightbox(null);
    composer.replyTo(null);
  }, [blocksGeneration, composer]);
  const replyingTo = useSyncExternalStore(composer.subscribe, () => composer.getState().replyTo);
  useEffect(() => {
    directoryRef.current = directory;
    selfRef.current = selfId;
    composer.refresh();
  }, [directory, selfId, composer]);
  const colorOf = useCallback((c: MentionCandidate) => (c.target.kind === 'member' ? members?.find((m) => m.userId === (c.target as { id: string }).id)?.color : undefined), [members]);
  const agentOf = useCallback((c: MentionCandidate) => (c.target.kind === 'agent' ? agents?.find((a) => a.handle === (c.target as { handle: string }).handle) : undefined), [agents]);
  const aboutOf = useCallback((c: MentionCandidate) => agentOf(c)?.about, [agentOf]);
  // A list kept from before agents had marks (the service worker's copy) has none.
  const avatarOf = useCallback((c: MentionCandidate) => agentOf(c)?.avatar ?? null, [agentOf]);

  // An agent will not answer what you asked (D204: its limit, its budget, a failure): said to you alone.
  useEffect(() => {
    const onNotice = (e: Event) => {
      const notice = (e as CustomEvent<Extract<ServerMessage, { type: 'chat:notice' }>>).detail;
      if (notice.clubId !== clubId) return;
      if (notice.calConsentRequired) openCal(clubId, notice.bookId);
      else toast.show(notice.text, 'error');
    };
    window.addEventListener('bc-chat-notice', onNotice);
    return () => window.removeEventListener('bc-chat-notice', onNotice);
  }, [clubId, toast]);

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

  const messages = useMemo(() => chat.data?.messages ?? [], [chat.data?.messages]);
  // Newest message at the end of the list (bottom of the screen): api.chat returns newest-first.
  const oldestFirst = useMemo(() => [...messages].reverse(), [messages]);
  const threadMessages = useMemo(() => (thread && threadQuery.data ? threadOf(threadQuery.data.messages, thread) : []), [thread, threadQuery.data]);
  const threadRuns = useMemo(() => groupRuns(threadMessages, (m) => m.author.userId), [threadMessages]);
  const threadRoot = threadMessages[0];

  useChatListScroll(threadListRef, threadMessages, thread ?? '');

  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  /** Scroll to a message in a list and make it glow: false when that list does not show it. */
  const reveal = useCallback((id: string, inThread: boolean) => {
    const found = inThread ? revealRenderedChatMessage(id, threadListRef.current) : channelList.current?.reveal(id);
    if (!found) return false;
    setHighlight(id);
    return true;
  }, []);

  useEffect(() => {
    if (!pendingJump) return;
    if (reveal(pendingJump, !!thread)) setPendingJump(null);
  }, [pendingJump, reveal, thread, threadRuns, oldestFirst]);

  const openThread = useCallback(
    (rootId: string, focus?: string) => {
      setThread(rootId);
      setOpenMenu(null);
      composer.replyTo(null);
      setPendingJump(focus ?? null);
    },
    [composer],
  );

  const closeThread = () => {
    const from = thread;
    setThread(null);
    composer.replyTo(null);
    // Back in the channel, at the thread's first message if it is there.
    setPendingJump(from);
  };

  const switchChannel = (id: string) => {
    setBookId(id);
    setThread(null);
    composer.replyTo(null);
  };

  // A link straight to a message (the bell's mention, D201): its thread says which channel it is in.
  useEffect(() => {
    if (!focusMessageId) return;
    let cancelled = false;
    const blocksAtLoad = moderationGeneration;
    api
      .chatThread(focusMessageId)
      .then((t) => {
        if (cancelled || blocksAtLoad !== moderationGeneration) return;
        qc.setQueryData(keys.chatThread(t.root.id), toThreadCache(t));
        setBookId(t.channel === 'general' ? '' : t.channel);
        setThread(null);
        composer.replyTo(null);
        setFocusTarget({ id: focusMessageId, rootId: t.root.id, channel: t.channel });
      })
      .catch(() => {
        if (!cancelled && blocksAtLoad === moderationGeneration) toast.show('That message is gone.', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [focusMessageId, qc, toast, composer]);

  // Once that channel has loaded: go to the message in place if it is there, else in its thread.
  useEffect(() => {
    if (!focusTarget || focusTarget.channel !== channel || !chat.data) return;
    if (chat.data.messages.some((m) => m.id === focusTarget.id)) setPendingJump(focusTarget.id);
    else openThread(focusTarget.rootId, focusTarget.id);
    setFocusTarget(null);
  }, [focusTarget, channel, chat.data, openThread]);

  const loadOlder = async () => {
    setLoadingOlder(true);
    try {
      await loadOlderChat(qc, clubId, channel);
    } catch {
      toast.show('Could not load earlier messages.', 'error');
    } finally {
      setLoadingOlder(false);
    }
  };

  /**
   * In a thread with nothing picked to answer, a reply answers its first message, or, if that one
   * is deleted (a placeholder) or still behind its fence, the newest message there that is
   * neither (D200). With none, there is nothing yet to answer.
   */
  const threadTarget = useMemo(() => [...threadMessages].reverse().find((m) => !m.hidden && !m.deleted) ?? null, [threadMessages]);

  // A follow-up in a thread an agent has just answered goes to that answer (D204), so that it asks
  // the agent again: put in the reply bar once, as a pick of one's own would be, and as easily set
  // aside; never over a pick or words already there.
  const offeredFollowUp = useRef<string | null>(null);
  useEffect(() => {
    const answer = threadTarget;
    if (!thread || !answer?.author.agent || answer.mine || offeredFollowUp.current === answer.id) return;
    const state = composer.getState();
    if (state.replyTo || state.text.trim() !== '') return;
    offeredFollowUp.current = answer.id;
    composer.replyTo(replyTargetOf(answer));
  }, [thread, threadTarget, composer]);
  const defaultParent = thread ? (threadRoot && !threadRoot.hidden && !threadRoot.deleted ? threadRoot : threadTarget) : null;
  const blocked = thread && threadMessages.length > 0 && !defaultParent && !replyingTo ? "You can reply here once you've read as far as this thread's messages." : null;

  // A message that will be sent to an agent of another service says so before it goes (D205): one
  // naming it, or one answering its message (picked, or the thread's own when nothing is), as the
  // server will read it. In a thread under such an agent's own message, that is every reply; and
  // until the club's agents are known, the message answered still says whether an agent wrote it.
  const draft = useSyncExternalStore(composer.subscribe, () => composer.getState().text);
  const answeringAgent = replyingTo ? replyingTo.authorAgent : (defaultParent?.author.agent ?? null);
  const answeringName = replyingTo ? replyingTo.authorName : (defaultParent?.author.displayName ?? '');
  // Read with every member, as the server reads it (the picker's own directory waits for the agents).
  const draftDirectory = useMemo(() => directoryOf(members ?? [], agents ?? []), [members, agents]);
  const outsideTo = useMemo(
    () => sentOutsideTo(draft, draftDirectory, defaultParent || replyingTo ? { agent: answeringAgent, name: answeringName } : null, agents ?? null),
    [draft, draftDirectory, defaultParent, replyingTo, answeringAgent, answeringName, agents],
  );
  // Until the club's agents are known, a draft that may name one (`@lux` typed by hand) waits:
  // whether it leaves Book Club cannot be said yet, and the server would know.
  const unconfirmed = useMemo(() => (agents ? [] : possibleAgentHandles(draft, members ?? [])), [agents, draft, members]);
  const held =
    unconfirmed.length > 0
      ? `Waiting to learn whether ${names(unconfirmed.map((h) => `@${h}`))} ${unconfirmed.length === 1 ? 'is an agent' : 'are agents'} outside Book Club before this is sent`
      : null;
  // Held says why Enter does nothing yet, before anything else.
  const outside = held ?? (outsideTo.length > 0 ? `Sent to ${names(outsideTo)}, outside Book Club` : null);

  /** Free what the composer shows of its pictures (their object URLs) before they are forgotten. */
  const freePreviews = useCallback(() => {
    for (const a of composer.getState().attachments) if (a.preview) URL.revokeObjectURL(a.preview);
  }, [composer]);
  useEffect(() => freePreviews, [freePreviews]);

  /**
   * Pictures picked, pasted or dropped (D203): each in its own slot, in that order, uploaded at once;
   * one taken out before its upload finishes is taken back from the server too.
   */
  const addFiles = (files: File[]) => {
    if (!online) {
      toast.show('No connection: pictures need one. Words still send.', 'error');
      return;
    }
    const keys = composer.addAttachments(
      files.map((file) => ({ name: file.name || 'picture', preview: URL.createObjectURL(file) })),
      LIMITS.chatImagesPerMessage,
    );
    if (keys.length < files.length) {
      toast.show(`A message holds at most ${LIMITS.chatImagesPerMessage} pictures.`, 'error');
    }
    keys.forEach((key, i) => {
      const file = files[i]!;
      void api
        .uploadChatImage(clubId, file, file.name || 'picture.png')
        .then((done) => {
          const stillHere = composer.getState().attachments.some((a) => a.key === key);
          if (!stillHere) {
            if (done.status === 'ready') void api.discardChatImage(done.id).catch(() => {});
            return;
          }
          if (done.status === 'ready') composer.attachmentReady(key, done.id);
          else composer.attachmentFailed(key, done.error ?? 'That picture could not be read.');
        })
        .catch((err: unknown) => composer.attachmentFailed(key, err instanceof Error ? err.message : 'Could not upload that.'));
    });
  };

  const removeAttachment = (key: string) => {
    const taken = composer.removeAttachment(key);
    if (taken?.preview) URL.revokeObjectURL(taken.preview);
    if (taken?.id) void api.discardChatImage(taken.id).catch(() => {});
  };

  const send = async () => {
    const state = composer.getState();
    const { replyTo } = state;
    const value = state.text.trim();
    if (!canSend(state) || sending || blocked || held || (draftKey && pendingDrafts.has(draftKey))) return;
    const attachmentIds = readyAttachmentIds(state);
    if (draftKey) {
      pendingDrafts.add(draftKey);
      draftEvents.dispatchEvent(new Event('pending'));
    }
    setSending(true);
    try {
      await api.postChat(clubId, {
        text: value,
        bookId: bookId || null,
        parentId: replyTo?.id ?? defaultParent?.id ?? undefined,
        spoilerUpToT: bookId && spoiler && myChapter ? myChapter.t : undefined,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      });
      const current = composer.getState();
      const sameScope = activeDraftScope.current === draftScope;
      if (sameScope && current.text === state.text && current.attachments === state.attachments && current.replyTo === replyTo) {
        freePreviews();
        composer.clear();
      } else {
        // A send can finish after another draft is open or the member has kept typing.
        if (sameScope && current.text === state.text) composer.input('', 0);
        else if (readStoredDraft(draftKey) === state.text) writeStoredDraft(draftKey, '');
        for (const attachment of state.attachments) {
          const sent = composer.removeAttachment(attachment.key);
          if (sent?.preview) URL.revokeObjectURL(sent.preview);
        }
        if (sameScope && current.replyTo === replyTo) composer.replyTo(null);
      }
      if (draftKey && state.text) draftEvents.dispatchEvent(new CustomEvent('sent', { detail: { key: draftKey, text: state.text } }));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not send that.', 'error');
    } finally {
      setSending(false);
      if (draftKey) {
        pendingDrafts.delete(draftKey);
        draftEvents.dispatchEvent(new Event('pending'));
      }
    }
  };

  const onTyping = () => {
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

  const remove = async (m: ChatMessageView) => {
    try {
      await api.deleteChat(m.id);
      // Your own delete, reflected at once: the hub's `chat:deleted` still reaches every other tab
      // and member, but the one who just deleted it should not wait on that round trip to see it
      // gone from their own view too (unlike `chat:new`'s self-echo, a push under load can lag).
      removeChatMessage(qc, clubId, m.bookId, m.id, m.threadId ?? null);
    } catch {
      toast.show('Could not delete that message.', 'error');
    }
  };

  const actions: ChatMessageActions = {
    react: (m, emoji) => void react(m, emoji),
    reply: (m) => {
      composer.replyTo(replyTargetOf(m));
      inputRef.current?.focus();
    },
    edit: (m) => setEditing({ id: m.id, text: m.hidden ? '' : (m.text ?? '') }),
    remove: (m) => void remove(m),
    jumpTo: (quote, from) => {
      if (!reveal(quote.id, !!thread)) openThread(from.threadId ?? quote.id, quote.id);
    },
    openThread: (rootId) => openThread(rootId),
    viewImages: (m, index) => setLightbox({ images: m.hidden ? [] : m.attachments, index, authorName: m.author.displayName }),
  };

  const renderRun = (run: (typeof threadRuns)[number], inThread: boolean, placement?: ChatMessagePlacement) => (
    <ChatMessageItem
      key={run.message.id}
      run={run}
      selfId={selfId}
      menuOpen={openMenu === run.message.id}
      onMenu={(open) => setOpenMenu(open ? run.message.id : null)}
      editing={editing}
      onEditText={(text) => setEditing((cur) => (cur ? { ...cur, text } : cur))}
      onSaveEdit={() => void saveEdit()}
      onCancelEdit={() => setEditing(null)}
      highlighted={highlight === run.message.id}
      inThread={inThread}
      agents={agents}
      actions={actions}
      placement={placement}
    />
  );

  const typers = [...new Map([...typingAnywhere, ...typingHere]).values()].map((t) => t.displayName);
  const channelName = bookId ? (books.find((b) => b.id === bookId)?.title ?? 'the book') : 'General';

  return (
    <section
      className={`chat-panel${dragging ? ' is-dropping' : ''}`}
      aria-label="Club chat"
      data-testid="chat-panel"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = online ? 'copy' : 'none';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        const files = imageFilesFrom(e.dataTransfer);
        setDragging(false);
        if (files.length === 0) return;
        e.preventDefault();
        addFiles(files);
      }}
    >
      {books.length > 0 ? (
        <nav className="chat-channels" aria-label="Chat channel" data-testid="chat-channel-switcher">
          <button
            type="button"
            className={`chat-channel-chip${bookId === '' ? ' is-active' : ''}`}
            aria-pressed={bookId === ''}
            data-testid="chat-channel-chip"
            data-book-id=""
            onClick={() => switchChannel('')}
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
              onClick={() => switchChannel(b.id)}
            >
              {b.title}
            </button>
          ))}
        </nav>
      ) : null}
      {thread ? (
        <div className="chat-thread" role="region" aria-label="Thread" data-testid="chat-thread">
          <div className="chat-thread-head">
            <button type="button" className="btn btn-small btn-ghost chat-thread-back" data-testid="chat-thread-close" onClick={closeThread}>
              <Icon name="back" size={14} /> {channelName}
            </button>
            <span className="chat-thread-title">Thread</span>
          </div>
          <ul className="chat-messages" ref={threadListRef} data-testid="chat-thread-messages">
            {threadQuery.isError ? <li className="muted small">That thread is gone.</li> : null}
            {threadQuery.data?.hasMore ? <li className="muted small chat-thread-earlier">Some earlier replies are omitted.</li> : null}
            {threadRuns.map((run) => renderRun(run, true))}
          </ul>
        </div>
      ) : (
        <ChatChannelList
          key={channel}
          ref={channelList}
          messages={oldestFirst}
          hasMore={!!chat.data?.hasMore}
          loadingOlder={loadingOlder}
          loadOlder={() => void loadOlder()}
          editingId={editing?.id}
          openMenu={openMenu}
          renderMessage={(run, placement) => renderRun(run, false, placement)}
        />
      )}
      <p className="chat-typing" role="status" aria-live="polite" data-testid="chat-typing">
        {typers.length > 0 ? `${names(typers)} ${typers.length === 1 ? 'is' : 'are'} typing…` : ''}
      </p>
      <ChatComposer
        clubId={clubId}
        selfId={selfId}
        dictationScope={draftScope}
        store={composer}
        inputRef={inputRef}
        placeholder={thread ? 'Reply in the thread…' : 'Message the club…'}
        sending={sending || draftPending}
        spoiler={bookId && myChapter ? { label: `Spoiler up to ${myChapter.label}`, checked: spoiler, onChange: setSpoiler } : null}
        threadNote={thread ? 'Replying in the thread' : null}
        outside={outside}
        blocked={blocked}
        colorOf={colorOf}
        aboutOf={aboutOf}
        avatarOf={avatarOf}
        onSend={() => void send()}
        onTyping={onTyping}
        onAddFiles={addFiles}
        onRemoveAttachment={removeAttachment}
        offline={!online}
      />
      {lightbox ? (
        <ChatLightbox
          images={lightbox.images}
          index={lightbox.index}
          authorName={lightbox.authorName}
          onIndex={(index) => setLightbox((cur) => (cur ? { ...cur, index } : cur))}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </section>
  );
}
