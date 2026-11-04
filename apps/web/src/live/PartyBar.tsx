import { useEffect, useState } from 'react';
import { type Edition, chapterLabel } from '@bookclub/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Avatar } from '../components/People';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { applyPartyResponse, keys, partyFence, useBook, useParty, useProgress, useSession } from '../lib/queries';
import { realtime } from '../lib/realtime';
import { tOf } from '../reader/position';
import { useAudio } from '../player/AudioProvider';
import { currentVoice, useVoiceSession } from './voiceStore';

/** How far behind the party's own place counts as "ahead of you, worth a warning" (D157). */
const WARN_MARGIN = 0.01;
/** The audiobook's volume while someone in voice is heard speaking (D155's ducking). */
const DUCK_VOLUME = 0.25;

/**
 * Listening together (D155-D158): one shared playback state per book, owned by the server. The
 * app-wide AudioProvider drives local audio and routes participant transport to the server.
 * This bar owns joining/leaving and voice, not a competing local sync loop. D157 still applies:
 * listening in a party saves your place through the very same path as listening alone.
 */
export function PartyBar({ bookId, clubId, editionId }: { bookId: string; clubId: string; editionId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const session = useSession();
  const selfId = session.data?.user?.id;
  const partyQuery = useParty(bookId);
  const party = partyQuery.data ?? null;
  const book = useBook(bookId);
  const progress = useProgress(bookId);
  const audio = useAudio();
  // Reactive: PartyBar can mount (and already be `joined`, as the host) before voice is ever
  // joined — this component's own voice-ducking and speaking-report effects below need to
  // re-attach the moment a voice session actually appears, not just when `joined` first does.
  const voiceSession = useVoiceSession();
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<{ here: string; there: string } | null>(null);

  const joined = !!party && !!selfId && party.members.some((m) => m.userId === selfId);
  const isHost = !!party && party.hostId === selfId;
  const canControl = !!party && (isHost || !party.settings.hostOnlyControls);

  // Ducking (D155): the audiobook is local, never published to the voice room, so it cannot
  // trigger this itself; it ducks only when the room's *other* participants are heard speaking.
  // The room's current active speakers are checked up front for the same reason as below.
  useEffect(() => {
    if (!joined) return;
    const voice = currentVoice();
    if (!voice || voice.clubId !== clubId) return;
    const el = audio.element;
    const apply = (speaking: boolean) => {
      if (el) el.volume = speaking ? DUCK_VOLUME : 1;
    };
    apply(voice.handle.room.activeSpeakers.some((p) => p.identity !== voice.handle.room.localParticipant.identity));
    return voice.handle.onRemoteSpeaking(apply);
    // `voiceSession` isn't read directly (currentVoice() is re-fetched above instead, since the
    // handle itself is what matters, not the plain object identity) but it is what changes the
    // instant voice is joined or left, which is exactly when this effect must re-attach.
  }, [joined, clubId, audio, voiceSession]);

  // Auto-pause on interruption (D158): report this device's own mic, and only its own, over the
  // hub whenever LiveKit says it crossed the speaking threshold. LiveKit's event fires only on a
  // *transition* (false→true, true→false): someone who joined voice and was already mid-sentence
  // before this component ever mounted (voice is joined from the club page; a party can start
  // later, on the book's listen page) would otherwise never be reported at all, since there is no
  // further transition left to notify a newly-registered listener about. The current state is
  // sent once up front to cover exactly that.
  useEffect(() => {
    if (!joined) return;
    const voice = currentVoice();
    if (!voice || voice.clubId !== clubId) return;
    realtime()?.sendPartySpeaking(clubId, bookId, voice.handle.room.localParticipant.isSpeaking);
    return voice.handle.onLocalSpeaking((speaking) => realtime()?.sendPartySpeaking(clubId, bookId, speaking));
    // See the ducking effect above: `voiceSession` must be a dependency so this re-attaches (and
    // reports the then-current state) the moment voice is actually joined, even when `joined`
    // (party membership) was already true before that, as it is for the host who just started it.
  }, [joined, clubId, bookId, voiceSession]);

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
