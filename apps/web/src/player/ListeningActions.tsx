import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type AudioLocator, type BookDetail, type Edition, type Reaction, REACTIONS, REACTION_LABELS, formatDuration } from '@bookclub/shared';
import { useClubCalContext } from '../cal/CalLauncher';
import { openCal } from '../cal/calStore';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { api, newClientId } from '../lib/api';
import { keptForLater } from '../lib/kept';
import { mergeComment, useProgress, useSession } from '../lib/queries';
import { NoteComposer } from '../reader/panels';
import { tOf } from '../reader/position';
import { useAudio } from './AudioProvider';
import { trackLabel } from './tracks';

export function AskListeningCal({ book, compact = false }: { book: BookDetail; compact?: boolean }) {
  const { clubId, enabled } = useClubCalContext();
  const audio = useAudio();
  const toast = useToast();
  const save = useMutation({ mutationFn: () => audio.saveNow({ confirm: true }), networkMode: 'always' });
  if (!enabled || clubId !== book.clubId) return null;
  return (
    <button
      type="button"
      className={compact ? 'icon-btn dock-cal' : 'btn btn-small'}
      aria-label={compact ? 'Ask Cal about the audiobook' : undefined}
      aria-busy={save.isPending || undefined}
      aria-disabled={save.isPending || undefined}
      onClick={() => {
        if (!save.isPending) save.mutate(undefined, {
          onSuccess: () => openCal(clubId, book.id),
          onError: () => toast.show('Could not sync your listening position. Try again.', 'error'),
        });
      }}
    >
      <Icon name="sparkle" size={compact ? 20 : 16} />{compact ? null : 'Ask Cal'}
    </button>
  );
}

export function ListeningReactions({ bookId, editionId, locate }: { bookId: string; editionId: string; locate: () => AudioLocator | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const react = async (reaction: Reaction, button: HTMLButtonElement) => {
    const locator = locate();
    if (!locator) return;
    try {
      const created = await api.createComment(bookId, { editionId, locator, reaction, clientId: newClientId() });
      mergeComment(qc, bookId, created);
      if (button.isConnected && typeof button.animate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        button.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
      }
      toast.show(`${reaction} pinned at ${formatDuration(locator.ms)}.`);
    } catch (err) {
      if (keptForLater(err)) toast.show(err.message);
      else toast.show(err instanceof Error ? err.message : 'Could not save the reaction.', 'error');
    }
  };
  return (
    <div className="reaction-row" role="group" aria-label="React at this moment">
      {REACTIONS.map((reaction) => (
        <button key={reaction} type="button" className="reaction-btn" aria-label={`${REACTION_LABELS[reaction]} at this moment`} onClick={(event) => void react(reaction, event.currentTarget)}>
          {reaction}
        </button>
      ))}
    </div>
  );
}

export function ListeningNote({ book, edition, locator, recordVoice, onClose }: { book: BookDetail; edition: Edition; locator: AudioLocator; recordVoice?: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const selfId = useSession().data?.user?.id;
  const progress = useProgress(book.id).data;
  const members = progress?.members ?? book.progress;
  return (
    <NoteComposer
      bookId={book.id}
      target={{ quote: null, where: `${formatDuration(locator.ms)} in ${trackLabel(edition, book.chapters, locator.track) ?? 'this track'}`, upTo: tOf(edition, locator) }}
      chapters={book.chapters}
      furthest={Math.max(members.find((m) => m.userId === selfId)?.furthest ?? 0, progress?.mine?.furthest ?? 0)}
      members={members}
      selfId={selfId}
      recordVoice={recordVoice}
      onClose={onClose}
      onSubmit={async ({ text, reaction, clientId, aboutHere, mediaIds }) => {
        try {
          const created = await api.createComment(book.id, {
            editionId: edition.id,
            locator,
            ...(text ? { text } : {}),
            ...(reaction ? { reaction } : {}),
            ...(mediaIds.length > 0 ? { mediaIds } : {}),
            clientId,
            ...(aboutHere ? { aboutHere } : {}),
          });
          mergeComment(qc, book.id, created);
        } catch (err) {
          if (!keptForLater(err)) throw err;
          toast.show(err.message);
        }
      }}
    />
  );
}
