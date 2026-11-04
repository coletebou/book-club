import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { type BookProgress, type CommentView, type HiddenComment, LIMITS, formatWhen } from '@bookclub/shared';
import { api, newClientId } from '../lib/api';
import { askToDelete } from '../lib/confirm';
import { fromFurtherOn, notAsFar, notAsFarLine } from '../lib/further';
import { keys, mergeComment, removeComment } from '../lib/queries';
import { Icon } from './Icon';
import { type MediaAttachment, NoteMediaComposer, discardAllMedia, mediaBusy, mediaIdsOf } from './NoteMediaComposer';
import { NoteMedia } from './NoteMediaView';
import { Avatar } from './People';
import { useToast } from './Toasts';

/**
 * What an answer you cannot read yet says instead of its words (D69): who, and where they had read
 * to when they wrote it, if that is what it waits for ("Cleo replied from Chapter 9", as the bell says).
 */
export function heldReply(r: Pick<HiddenComment, 'authorName' | 'horizon'>): string {
  return `${r.authorName} replied${r.horizon ? ` from ${r.horizon}` : ''} · it opens when you get there`;
}

/**
 * The conversation under a note (D48): friends' answers, oldest first, and a way to answer. Only
 * for a note you can read. An answer opens once you have read its note's place and as far as its
 * writer had read when they wrote it (D69); until then it says where that was, never the words.
 * `actions`: small icon buttons for the note itself (Delete, Go to passage), shown beside Reply
 * rather than stacked above it (Cole did not want the big stacked text buttons, fidelity feedback).
 */
export function Replies({
  note,
  replies,
  selfId,
  canModerate,
  actions,
}: {
  note: CommentView;
  replies: readonly CommentView[];
  selfId: string | undefined;
  canModerate: boolean;
  actions?: ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [clientId, setClientId] = useState(newClientId);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  if (note.hidden) return null;
  // Read well past the note: the answer waits for friends to read as far (D69), unless it is
  // only about the note's passage, which its writer may say. Asked only while some friend has not
  // read as far, and saying who: with everyone as far, the answer would wait for nobody.
  const members = qc.getQueryData<BookProgress>(keys.progress(note.bookId))?.members ?? [];
  const mine = members.find((m) => m.userId === selfId);
  const behind = mine && fromFurtherOn(mine.furthest, note.t) ? notAsFar(members, selfId, mine.furthest) : [];
  const fromFurther = behind.length > 0;
  const mediaIds = mediaIdsOf(attachments);
  const busy = mediaBusy(attachments);
  const canSend = (text.trim().length > 0 || mediaIds.length > 0) && !busy;
  const close = () => {
    discardAllMedia(attachments);
    setAttachments([]);
    setOpen(false);
  };
  const send = async (aboutHere = false) => {
    if (!canSend) return;
    setSending(true);
    try {
      const created = await api.reply(note.id, { text: text.trim() || undefined, mediaIds, clientId, ...(fromFurther && aboutHere ? { aboutHere: true } : {}) });
      mergeComment(qc, note.bookId, created);
      setText('');
      setAttachments([]);
      setClientId(newClientId());
      setOpen(false);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not send the reply.', 'error');
    } finally {
      setSending(false);
    }
  };
  const remove = async (c: CommentView) => {
    if (!(await askToDelete(c, selfId))) return;
    try {
      await api.deleteComment(c.id);
      removeComment(qc, note.bookId, c.id);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not delete the reply.', 'error');
    }
  };
  return (
    <div className="replies" data-testid="replies">
      {replies.length > 0 ? (
        <ol className="reply-list" aria-label={`${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}>
          {replies.map((r) => (
            <li key={r.id} className="reply" data-testid="reply" data-comment={r.id}>
              <Avatar name={r.authorName} color={r.color} size={22} />
              <div>
                <span className="reply-meta">
                  <strong>{r.userId === selfId ? 'You' : r.authorName}</strong>{' '}
                  <time className="faint small" dateTime={r.createdAt}>
                    {formatWhen(r.createdAt)}
                  </time>
                </span>
                {r.hidden ? (
                  <>
                    <p className="reply-text note-locked small muted" data-testid="reply-held">
                      <Icon name="lock" size={14} />
                      <span>
                        {r.reaction ? `${r.reaction} ` : ''}
                        {heldReply(r)}
                      </span>
                    </p>
                    <NoteMedia comment={r} />
                  </>
                ) : (
                  <>
                    {r.text ? (
                      <p className="reply-text">
                        {r.reaction ? `${r.reaction} ` : ''}
                        {r.text}
                      </p>
                    ) : r.reaction ? (
                      <p className="reply-text">{r.reaction}</p>
                    ) : null}
                    <NoteMedia comment={r} />
                  </>
                )}
                {r.userId === selfId || canModerate ? (
                  <button type="button" className="btn btn-ghost btn-small btn-danger" onClick={() => void remove(r)}>
                    Delete
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {note.deleted ? null : open ? (
        <form
          className="reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className="visually-hidden" htmlFor={`reply-${note.id}`}>
            Reply to {note.userId === selfId ? 'your note' : `${note.authorName}’s note`}
          </label>
          <textarea id={`reply-${note.id}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.commentText} rows={2} placeholder="Reply… (text, voice, a photo or a video)" data-testid="reply-text" autoFocus />
          <NoteMediaComposer bookId={note.bookId} attachments={attachments} onChange={setAttachments} disabled={sending} />
          {/* Read well past the note, with friends not as far: whether they read the answer now or
              once they get as far is chosen as it is sent (D69). */}
          {fromFurther ? (
            <p className="reply-about-here small muted" data-testid="reply-from-further">
              {notAsFarLine(behind)}: your answer waits until they have, unless it is only about this passage.
            </p>
          ) : null}
          <span className="row">
            <button type="submit" className="btn btn-small btn-primary" disabled={!canSend || sending} data-testid="reply-send">
              Send
            </button>
            {fromFurther ? (
              <button type="button" className="btn btn-small" disabled={!canSend || sending} onClick={() => void send(true)} data-testid="reply-send-about-here">
                Send, only about this passage
              </button>
            ) : null}
            <button type="button" className="btn btn-small btn-ghost" onClick={close}>
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <div className="note-row">
          {actions}
          <button type="button" className="icon-btn note-action-btn reply-open" aria-label="Reply" title="Reply" onClick={() => setOpen(true)} data-testid="reply-open">
            <Icon name="reply" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
