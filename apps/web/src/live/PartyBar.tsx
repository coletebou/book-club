import { useState } from 'react';
import { type Edition, chapterLabel } from '@bookclub/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Avatar } from '../components/People';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { applyPartyResponse, keys, partyFence, useBook, useParty, useProgress, useSession } from '../lib/queries';
import { tOf } from '../reader/position';

/** How far behind the party's own place counts as "ahead of you, worth a warning" (D157). */
const WARN_MARGIN = 0.01;

/**
 * Listening together (D155-D158): one shared playback state per book, owned by the server. The
 * app-wide AudioProvider drives local audio and routes participant transport to the server.
 * This bar owns joining and leaving. The player keeps voice coordination (D256). D157 still applies:
 * listening in a party saves your place through the very same path as listening alone.
 */
export function PartyBar({ bookId, editionId }: { bookId: string; editionId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const session = useSession();
  const selfId = session.data?.user?.id;
  const partyQuery = useParty(bookId);
  const party = partyQuery.data ?? null;
  const book = useBook(bookId);
  const progress = useProgress(bookId);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<{ here: string; there: string } | null>(null);

  const joined = !!party && !!selfId && party.members.some((m) => m.userId === selfId);
  const isHost = !!party && party.hostId === selfId;
  const canControl = !!party && (isHost || !party.settings.hostOnlyControls);

  // Every response below is fenced: a hub end or replacement that arrives while the request is in
  // flight wins over it, so a slow start/join/control can never bring back a party that is over.
  const control = async (body: Parameters<typeof api.partyControl>[1]) => {
    setBusy(true);
    try {
      const fence = partyFence(qc, bookId);
      const next = await api.partyControl(bookId, { ...body, ...(party?.partyId ? { partyId: party.partyId } : {}) });
      applyPartyResponse(qc, bookId, fence, next);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'The party would not do that.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const actuallyJoin = async () => {
    setBusy(true);
    try {
      const fence = partyFence(qc, bookId);
      applyPartyResponse(qc, bookId, fence, await api.joinParty(bookId));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not join the party.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!party || !book.data) return;
    const myT = progress.data?.mine?.t ?? 0;
    const edition = book.data.editions.find((e: Edition) => e.id === party.editionId);
    const partyT = edition ? tOf(edition, { kind: 'audio', track: party.track, ms: Math.round(party.position * 1000) }) : 0;
    if (partyT - myT > WARN_MARGIN) {
      setWarn({ here: chapterLabel(book.data.chapters, myT), there: chapterLabel(book.data.chapters, partyT) });
      return;
    }
    await actuallyJoin();
  };

  const leave = async () => {
    setBusy(true);
    try {
      await api.leaveParty(bookId);
      qc.setQueryData<typeof party>(keys.party(bookId), (p) => p ? { ...p, members: p.members.filter((m) => m.userId !== selfId) } : null);
      await qc.invalidateQueries({ queryKey: keys.party(bookId) });
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const fence = partyFence(qc, bookId);
      applyPartyResponse(qc, bookId, fence, await api.startParty(bookId, { editionId }));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not start a listening party.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!party) {
    return (
      <div className="party-bar" data-testid="party-bar">
        <button type="button" className="btn btn-ghost btn-small" aria-label="Listen together" onClick={() => void start()} disabled={busy} data-testid="party-start">
          <Icon name="headphones" size={16} /> <span className="party-label">Listen together</span>
        </button>
      </div>
    );
  }

  const others = party.members.filter((m) => m.userId !== selfId);

  return (
    <div className="party-bar" data-testid="party-bar" data-joined={joined} data-paused-reason={party.paused?.reason ?? ''}>
      <div className="party-roster">
        {party.members.map((m) => (
          <Avatar key={m.userId} name={m.displayName} color={m.color} size={26} />
        ))}
        <span className="muted small">
          {joined ? `Listening together${others.length > 0 ? ` with ${others.map((m) => m.displayName).join(', ')}` : ''}` : `${party.members.map((m) => m.displayName).join(', ')} listening together`}
        </span>
      </div>
      {party.paused?.reason === 'interruption' ? (
        <div className="party-interrupt" role="status" data-testid="party-paused-interruption">
          <span>Paused: {party.paused.by} is talking</span>
          <button type="button" className="btn btn-small" onClick={() => void control({ action: 'resume' })} data-testid="party-resume">
            Resume
          </button>
        </div>
      ) : null}
      <div className="party-controls">
        {joined ? (
          <>
            {canControl ? (
              <button
                type="button"
                className="icon-btn"
                aria-label={party.playing ? 'Pause for everyone' : 'Play for everyone'}
                onClick={() => void control({ action: party.playing ? 'pause' : 'play' })}
                disabled={busy}
                data-testid="party-toggle"
              >
                <Icon name={party.playing ? 'pause' : 'play'} />
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost btn-small" onClick={() => void leave()} disabled={busy} data-testid="party-leave">
              Leave party
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary btn-small" onClick={() => void join()} disabled={busy} data-testid="party-join">
            Join
          </button>
        )}
      </div>
      {warn ? (
        <ConfirmDialog
          title={`The party is at ${warn.there}`}
          body={`You are at ${warn.here}. Join and skip ahead?`}
          confirm="Join anyway"
          cancel="Not yet"
          onAnswer={(yes) => {
            setWarn(null);
            if (yes) void actuallyJoin();
          }}
        />
      ) : null}
    </div>
  );
}
