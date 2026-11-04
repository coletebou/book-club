import { useQueryClient } from '@tanstack/react-query';
import { type Chapter, type CommentView, type HiddenComment, REACTION_LABELS, type Span, chapterLabel, formatPercent, formatWhen } from '@bookclub/shared';
import { Avatar } from './People';
import { Icon } from './Icon';
import { NoteMedia } from './NoteMediaView';
import { Replies } from './Thread';
import { askToDelete } from '../lib/confirm';
import { nearButClosed, reactionAlone, reactionOnly, readRangesOf, whyClosed } from '../lib/further';
import { NO_REPLIES } from '../lib/threads';

/**
 * What a note closed to you says on the book page instead of its words (D63, D69). A reaction with
 * no words says whose and which it is, and that there are no words: there is nothing more to see.
 */
function closedText(c: HiddenComment, read: readonly Span[] | undefined): string {
  const why = whyClosed(c, read);
  if (reactionOnly(c)) return reactionAlone(c, why);
  switch (why) {
    case 'held':
      return `${c.authorName} wrote this from ${c.horizon}: it opens when you get there.`;
    case 'near':
      return nearButClosed(c, 'sentence');
    default:
      return c.deleted ? 'This note was deleted.' : 'A note waits here. You will see it when you get there.';
  }
}

/**
 * The book's discussion in reading order. What you have read shows in full; what lies ahead of
 * you is a spoiler-free marker: who, the emoji, and roughly where, never the words.
 */
export function Discussion({
  comments,
  replies = NO_REPLIES,
  chapters,
  selfId,
  canModerate,
  onOpen,
  onDelete,
}: {
  comments: readonly CommentView[];
  /** The conversation under each note (D48). */
  replies?: ReadonlyMap<string, CommentView[]>;
  chapters: readonly Chapter[];
  selfId: string | undefined;
  canModerate: boolean;
  onOpen?: (comment: CommentView) => void;
  onDelete?: (comment: CommentView) => void;
}) {
  // Your reading, as the server last said it: a note whose place you have read waits only until
  // you are surely past it (D63), and says so.
  const qc = useQueryClient();
  const read = readRangesOf(qc, comments[0]?.bookId ?? '');
  if (comments.length === 0) {
    return <p className="muted">No notes yet. Select a passage while reading, or tap the note button, to leave the first.</p>;
  }
  return (
    <ol className="discussion" aria-label="Notes in reading order">
      {comments.map((c) => (
        <li key={c.id} id={`note-${c.id}`} className={`note${c.hidden ? ' note-hidden' : ''}`} data-testid="note" data-hidden={c.hidden ? 'true' : 'false'} data-comment={c.id}>
          <Avatar name={c.authorName} color={c.color} size={30} />
          <div className="note-body">
            <div className="note-meta">
              <strong>{c.userId === selfId ? 'You' : c.authorName}</strong>
              {c.reaction ? (
                <span className="note-reaction" role="img" aria-label={REACTION_LABELS[c.reaction]}>
                  {c.reaction}
                </span>
              ) : null}
              <span className="faint small">{chapterLabel(chapters, c.t) || formatPercent(c.t)}</span>
              <time className="faint small" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>
                {formatWhen(c.createdAt)}
              </time>
            </div>
            {c.hidden ? (
              <>
                <p className="note-locked small muted" data-closed={whyClosed(c, read)}>
                  {reactionOnly(c) ? null : <Icon name="lock" size={14} />} {closedText(c, read)}
                </p>
                <NoteMedia comment={c} />
              </>
            ) : (
              <>
                {c.deleted ? <p className="muted small">This note was deleted.</p> : null}
                {c.quote ? <blockquote className="note-quote">{c.quote}</blockquote> : null}
                {c.text ? <p className="note-text">{c.text}</p> : null}
                <NoteMedia comment={c} />
                <div className="note-actions">
                  {onOpen ? (
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => onOpen(c)}>
                      Go to passage
                    </button>
                  ) : null}
                  {onDelete && (c.userId === selfId || canModerate) && !c.deleted ? (
                    <button type="button" className="btn btn-ghost btn-small btn-danger" onClick={() => void askToDelete(c, selfId).then((yes) => yes && onDelete(c))}>
                      Delete
                    </button>
                  ) : null}
                </div>
                <Replies note={c} replies={replies.get(c.id) ?? []} selfId={selfId} canModerate={canModerate} />
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
