import type { CommentView, HiddenComment, Span } from '@bookclub/shared';
import { isNoteSafetyTarget } from '../components/MemberSafetyActions';
import { hasNoteMediaControls } from '../components/NoteMediaView';
import { canDeleteReply } from '../components/Thread';
import { type Closed, reactionOnly, whyClosed } from '../lib/further';

export function canReadFromNote(note: HiddenComment, why: Closed): boolean {
  return why !== 'held' && !reactionOnly(note);
}

interface TabStopContext {
  readonly selfId: string | undefined;
  readonly hasClub: boolean;
  readonly canModerate: boolean;
  readonly readHere: boolean;
  readonly read: readonly Span[] | undefined;
}

/** Controls in a sheet row, including the replies that remain under a deleted note. */
export function noteSheetHasTabStop(note: CommentView, replies: readonly CommentView[], context: TabStopContext): boolean {
  const { selfId, hasClub, canModerate, readHere, read } = context;
  const canUseSafety = (item: CommentView) => hasClub && isNoteSafetyTarget(item, selfId);
  if (note.hidden) return canUseSafety(note) || (readHere && canReadFromNote(note, whyClosed(note, read)));
  if (!note.deleted || hasNoteMediaControls(note)) return true;
  return replies.some((reply) => canDeleteReply(reply, selfId, canModerate) || canUseSafety(reply) || hasNoteMediaControls(reply));
}
