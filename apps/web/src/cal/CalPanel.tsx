import { formatWhen } from '@bookclub/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useAudioState } from '../player/AudioProvider';
import { usePauseAudiobookWhile } from '../player/pauseWhile';
import { type CalContentPart, type CalConversationSummary, type CalMessage, calApi, streamCalMessage } from '../lib/cal-api';
import { CalSettingsModal } from './CalSettings';
import { type ReplyVoice, useCalVoice } from './useCalVoice';
import './cal.css';

interface CalPanelProps {
  readonly clubId: string;
  /** The book this panel was opened from (the reader's "ask about this passage", a club page); null elsewhere. */
  readonly bookId?: string | null;
  readonly onClose: () => void;
}

function citationLink(part: Extract<CalContentPart, { type: 'citation' }>) {
  return `/books/${part.bookId}/read?at=${part.t}`;
}

function MessageBubble({ message }: { message: CalMessage }) {
  const text = message.content.find((p): p is Extract<CalContentPart, { type: 'text' }> => p.type === 'text');
  const citations = message.content.filter((p): p is Extract<CalContentPart, { type: 'citation' }> => p.type === 'citation');
  return (
    <div className={`cal-msg cal-msg-${message.role}`} data-testid={`cal-message-${message.role}`}>
      <p>{text?.text}</p>
      {citations.length > 0 && (
        <ol className="cal-citations">
          {citations.map((c, i) => (
            <li key={c.chunkId}>
              <Link to={citationLink(c)} data-testid="cal-citation-link">
                [{i + 1}] {c.bookTitle}
                {c.chapterTitle ? `, ${c.chapterTitle}` : ''}
              </Link>
              <span className="cal-quote">“{c.quote}”</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** A thread's name in the list: its first question (the server titles it, D183), or a stand-in for an older untitled one. */
function threadName(thread: CalConversationSummary): string {
  return thread.title || 'Untitled chat';
}

/**
 * Every earlier chat with Cal in this club, most recent first (D183): tap one to carry on in it,
 * or start a new one. Only the asker's own threads are ever listed (the server's list is theirs
 * alone). A thread can be deleted from here, after the app's own confirmation.
 */
function ThreadList({
  threads,
  currentId,
  disabled,
  onOpen,
  onNew,
  onDelete,
}: {
  readonly threads: readonly CalConversationSummary[] | null;
  readonly currentId: string | null;
  readonly disabled: boolean;
  readonly onOpen: (id: string) => void;
  readonly onNew: () => void;
  readonly onDelete: (thread: CalConversationSummary) => void;
}) {
  return (
    <div className="cal-threads" data-testid="cal-threads">
      <button type="button" className="btn btn-small cal-thread-new" data-testid="cal-thread-new" onClick={onNew} disabled={disabled}>
        <Icon name="compose" size={16} /> New chat
      </button>
      {threads === null ? (
        <p className="cal-hint">Loading your chats…</p>
      ) : threads.length === 0 ? (
        <p className="cal-hint">No chats with Cal yet. Your first question starts one.</p>
      ) : (
        <ul className="cal-thread-list" aria-label="Your chats with Cal">
          {threads.map((t) => (
            <li key={t.id} className={t.id === currentId ? 'is-current' : undefined}>
              <button
                type="button"
                className="cal-thread"
                data-testid="cal-thread"
                aria-current={t.id === currentId ? 'true' : undefined}
                disabled={disabled}
                onClick={() => onOpen(t.id)}
              >
                <span className="cal-thread-title">{threadName(t)}</span>
                <span className="cal-thread-meta">
                  <time dateTime={t.updatedAt}>{formatWhen(t.updatedAt)}</time>
                  {t.bookTitle ? <span className="cal-thread-book"> · {t.bookTitle}</span> : null}
                </span>
              </button>
              <button type="button" className="icon-btn" aria-label={`Delete “${threadName(t)}”`} data-testid="cal-thread-delete" disabled={disabled} onClick={() => onDelete(t)}>
                <Icon name="trash" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Cal's panel (D160, D176, D183): chat only, plus the threads to keep it in. Its header carries
 * "Your chats" (the thread list, in place of the chat), "New chat", and the gear for his settings,
 * where the spoiler scope lives — nothing about spoilers is asked in the chat itself (D183).
 *
 * A new chat is only a draft until its first question: the thread is created then (with the book
 * the panel was opened from, if any), so the list never fills with empty ones.
 */
/**
 * Said while Cal answers in a narrator's voice (D223), so no one takes a voice made to match a
 * narrator for the narrator themself: only a clone they agreed to is called theirs.
 */
export function replyVoiceLine(v: Extract<ReplyVoice, { kind: 'narrator' }>): string {
  const name = v.narrator.trim();
  if (v.source === 'clone') return name ? `Cal is answering in ${name}’s voice, with their permission.` : 'Cal is answering in the narrator’s voice, with their permission.';
  if (v.source === 'narration') return 'Cal is answering in the voice that reads this audiobook.';
  return name ? `Cal is answering in a voice made to sound like ${name}, the narrator. It isn’t ${name}.` : 'Cal is answering in a voice made to sound like the narrator.';
}

/** A narrator's reply plays at the listener's own speed for the book, times the server's correction for the narrator's pace (D223); Cal's own at 1. */
export function narratorReplyRate(v: ReplyVoice, listenerSpeed: number): number {
  return v.kind === 'narrator' ? listenerSpeed * (v.rate ?? 1) : 1;
}

export function CalPanel({ clubId, bookId, onClose }: CalPanelProps) {
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null);
  const [threads, setThreads] = useState<CalConversationSummary[] | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const [view, setView] = useState<'chat' | 'threads'>('chat');
  const [messages, setMessages] = useState<CalMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [wholeSeries, setWholeSeries] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState<CalConversationSummary | null>(null);
  const streamingText = useRef('');
  const [streamed, setStreamed] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The thread whose history is being shown or fetched: a slow fetch for one tapped earlier never overwrites the one tapped since. */
  const shownThread = useRef<string | null>(null);
  /** A new chat's thread while it is being created: a send and a mic tap (or two taps) at once share it, rather than make two threads. */
  const creating = useRef<Promise<string> | null>(null);
  /** The thread the last voice turn was spoken in: its transcript and error belong to that thread only. */
  const [voiceThread, setVoiceThread] = useState<string | null>(null);
  // D223: a reply in the narrator's voice plays at the speed the listener hears that audiobook at,
  // so stepping out of the narration keeps its pace; Cal's own voice plays as spoken.
  const audio = useAudioState();
  const threadBookId = threads?.find((c) => c.id === conversationId)?.bookId ?? bookId ?? null;
  const listenerSpeed = useRef(1);
  listenerSpeed.current = threadBookId && audio.book?.id === threadBookId ? audio.speed : 1;
  const replyRate = useCallback((v: ReplyVoice) => narratorReplyRate(v, listenerSpeed.current), []);
  const voice = useCalVoice(clubId, conversationId, undefined, { replyRate });
  /** A reply is on its way, typed or spoken, into the thread shown: it stays fixed (no switching, new chat or delete) until the reply is in. */
  const busy = sending || voice.busy;
  // D169: Cal talking pauses the audiobook, and a solo player stays paused after. It is a local
  // hold, not a shared Pause: in a listening party, sync waits until his reply has finished, then
  // rejoins the party's clock (otherwise sync would restart the book over him within a second).
  usePauseAudiobookWhile(voice.speaking || voice.replying, { resumeAlone: false });

  useEffect(() => {
    void calApi.status(clubId).then(setStatus, () => setStatus({ enabled: false }));
    void calApi.settings().then((s) => setWholeSeries(s.wholeSeries));
  }, [clubId]);

  const refreshThreads = useCallback(async () => {
    const list = await calApi.conversations(clubId).catch(() => null);
    if (list) setThreads(list);
    return list;
  }, [clubId]);

  const openThread = useCallback(async (id: string) => {
    shownThread.current = id;
    creating.current = null;
    setConversationId(id);
    setView('chat');
    setMessages([]);
    setStreamed('');
    setLoadingThread(true);
    try {
      const detail = await calApi.conversation(id);
      if (shownThread.current === id) setMessages(detail.messages);
    } catch {
      if (shownThread.current === id) setMessages([{ id: `error-${Date.now()}`, role: 'assistant', content: [{ type: 'text', text: 'That chat could not be opened. Try again in a moment.' }], wholeSeries: false, createdAt: new Date().toISOString() }]);
    } finally {
      if (shownThread.current === id) setLoadingThread(false);
    }
  }, []);

  const startNewChat = useCallback(() => {
    shownThread.current = null;
    creating.current = null;
    setConversationId(null);
    setMessages([]);
    setStreamed('');
    setLoadingThread(false);
    setView('chat');
    // After the chat view (and its input) is back on screen.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // On opening: carry on in the latest thread about the book the panel was opened from (or the
  // latest of all, opened from anywhere else); with none, a new chat waits for its first question.
  useEffect(() => {
    if (!status?.enabled || picked) return;
    setPicked(true);
    void (async () => {
      const list = await refreshThreads();
      const existing = list ? (bookId ? list.find((c) => c.bookId === bookId) : list[0]) : undefined;
      if (existing) await openThread(existing.id);
    })();
  }, [status, picked, bookId, refreshThreads, openThread]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamed]);

  /** The thread to send into: the one shown, or (in a new chat) one created now, about the book the panel was opened from. */
  const ensureConversation = (): Promise<string> => {
    if (conversationId) return Promise.resolve(conversationId);
    if (creating.current) return creating.current;
    const pending = calApi.createConversation(clubId, { bookId: bookId ?? null }).then(
      (created) => {
        // Only if this new chat is still the one shown (New chat or another thread may have been tapped since).
        if (creating.current === pending) {
          shownThread.current = created.id;
          setConversationId(created.id);
        }
        return created.id;
      },
      (err: unknown) => {
        if (creating.current === pending) creating.current = null;
        throw err;
      },
    );
    creating.current = pending;
    return pending;
  };

  const showError = (text: string) =>
    setMessages((m) => [...m, { id: `error-${Date.now()}`, role: 'assistant', content: [{ type: 'text', text }], wholeSeries: false, createdAt: new Date().toISOString() }]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || loadingThread) return;
    setDraft('');
    setSending(true);
    setMessages((m) => [...m, { id: `pending-${Date.now()}`, role: 'user', content: [{ type: 'text', text }], wholeSeries, createdAt: new Date().toISOString() }]);
    streamingText.current = '';
    setStreamed('');
    let threadId: string;
    try {
      threadId = await ensureConversation();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Cal could not start a new chat. Try again in a moment.');
      setSending(false);
      return;
    }
    await streamCalMessage(threadId, text, {
      onDelta: (delta) => {
        streamingText.current += delta;
        setStreamed(streamingText.current);
      },
      onDone: (message) => {
        setMessages((m) => [...m, message]);
        setStreamed('');
        setSending(false);
        // Its new title (a first question) and its place at the top of the list.
        void refreshThreads();
      },
      onError: (message) => {
        showError(message);
        setStreamed('');
        setSending(false);
        void refreshThreads();
      },
    });
  };

  const talk = async () => {
    if (voice.recording) return voice.stop();
    if (voice.speaking) return voice.bargeIn();
    try {
      const threadId = await ensureConversation();
      setVoiceThread(threadId);
      await voice.start(threadId);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Cal could not start a new chat. Try again in a moment.');
    }
  };

  const confirmDelete = async (yes: boolean) => {
    const thread = deleting;
    setDeleting(null);
    if (!yes || !thread) return;
    try {
      await calApi.deleteConversation(thread.id);
    } catch {
      // Whatever happened, the list below says what is really still there.
    }
    if (thread.id === conversationId) startNewChat();
    setView('threads');
    await refreshThreads();
  };

  if (status && !status.enabled) {
    return (
      <Modal title="Cal" onClose={onClose}>
        <p className="cal-disabled">Cal isn't set up on this server yet. Ask whoever runs it to add an Anthropic API key.</p>
      </Modal>
    );
  }

  const current = threads?.find((t) => t.id === conversationId) ?? null;
  const showingThreads = view === 'threads';

  return (
    <Modal
      title="Ask Cal"
      onClose={onClose}
      wide
      className="cal-modal"
      headerExtra={
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label="Your chats with Cal"
            aria-pressed={showingThreads}
            data-testid="cal-threads-open"
            onClick={() => {
              if (showingThreads) return setView('chat');
              setView('threads');
              void refreshThreads();
            }}
          >
            <Icon name="history" size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label="New chat" data-testid="cal-new-chat" disabled={busy} onClick={startNewChat}>
            <Icon name="compose" size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label="Cal's settings" data-testid="cal-settings-open" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={18} />
          </button>
        </>
      }
    >
      {showingThreads ? (
        <ThreadList
          threads={threads}
          currentId={conversationId}
          disabled={busy}
          onOpen={(id) => void openThread(id)}
          onNew={startNewChat}
          onDelete={setDeleting}
        />
      ) : (
        <div className="cal-chat">
          <p className="cal-thread-current" data-testid="cal-thread-current">
            {current ? threadName(current) : 'New chat'}
          </p>
          <div className="cal-messages" ref={listRef}>
            {loadingThread && <p className="cal-hint">Opening this chat…</p>}
            {!loadingThread && messages.length === 0 && !streamed && (
              <p className="cal-hint" data-testid="cal-hint">
                Ask Cal anything — about the club's books (he'll search them and cite his sources) or anything else.{' '}
                {wholeSeries
                  ? 'Your settings let him use the whole series, so he may say what happens later in it.'
                  : "He won't spoil anything past where you've read. To let him use the whole series, open his settings (the gear above)."}
              </p>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {streamed && (
              <div className="cal-msg cal-msg-assistant cal-msg-streaming">
                <p>{streamed}</p>
              </div>
            )}
            {voiceThread === conversationId && voice.transcript && <p className="cal-hint">You said: “{voice.transcript}”</p>}
            {voiceThread === conversationId && (voice.speaking || voice.replying) && voice.replyVoice?.kind === 'narrator' && (
              <p className="cal-hint" data-testid="cal-reply-voice">
                {replyVoiceLine(voice.replyVoice)}
              </p>
            )}
            {voiceThread === conversationId && voice.error && <p className="cal-error">{voice.error}</p>}
          </div>
          <form
            className="cal-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={inputRef}
              data-testid="cal-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask Cal…"
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {voice.supported && (
              <button
                type="button"
                className={`icon-btn cal-mic${voice.recording ? ' is-recording' : ''}`}
                aria-label={voice.recording ? 'Stop talking to Cal' : 'Talk to Cal'}
                // Never off while recording or Cal is talking: this same button is how either is stopped.
                disabled={loadingThread || (sending && !voice.recording && !voice.speaking)}
                onClick={() => void talk()}
              >
                <Icon name="mic" size={18} />
              </button>
            )}
            <button type="submit" className="icon-btn" aria-label="Send" data-testid="cal-send" disabled={sending || loadingThread || !draft.trim()}>
              <Icon name="send" size={18} />
            </button>
          </form>
        </div>
      )}
      {settingsOpen ? (
        <CalSettingsModal clubId={clubId} wholeSeries={wholeSeries} onWholeSeriesChange={setWholeSeries} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete this chat?"
          body={`“${threadName(deleting)}” and everything in it go for good. Your other chats with Cal stay.`}
          confirm="Delete"
          cancel="Keep"
          danger
          onAnswer={(yes) => void confirmDelete(yes)}
        />
      ) : null}
    </Modal>
  );
}
