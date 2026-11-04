import { useEffect, useState } from 'react';
import { voiceRoomName } from '@bookclub/shared';
import { Avatar } from '../components/People';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { useClubPresence, useVoicePresence } from '../lib/realtime';
import { joinVoice, leaveVoice, setDeafened, setMuted, setPushToTalkHeld, setPushToTalkMode, useVoiceSession } from './voiceStore';

/**
 * The club's voice channel (D153-D154): join/leave, mute, deafen, push-to-talk, and who is in it
 * with a speaking ring — reusing `Avatar` and the club's live presence subscription, not the
 * pixel-tuned `ClubBar`/`PresenceList` markup, so voice ships without touching either (it is shown
 * beside them instead; see docs/DECISIONS.md D153).
 */
export function VoiceBar({ clubId }: { clubId: string }) {
  const toast = useToast();
  const session = useVoiceSession();
  const inThisClub = session?.clubId === clubId && session.roomKind === 'club';
  const [joining, setJoining] = useState(false);
  // The club must be subscribed over the hub for 'voice:update' (and 'party:state') to reach this tab.
  useClubPresence(clubId);
  const roomName = voiceRoomName(clubId, 'club');
  const roster = useVoicePresence(roomName)?.participants ?? [];

  useEffect(() => {
    if (!session?.pushToTalk) return;
    const onKey =
      (down: boolean) =>
      (e: KeyboardEvent): void => {
        if (e.code !== 'Space' || e.repeat) return;
        const active = document.activeElement;
        if (active && ['INPUT', 'TEXTAREA'].includes(active.tagName)) return;
        e.preventDefault();
        void setPushToTalkHeld(down);
      };
    const onDown = onKey(true);
    const onUp = onKey(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [session?.pushToTalk]);

  const join = async () => {
    setJoining(true);
    try {
      await joinVoice(clubId, 'club');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not join voice.', 'error');
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="voice-bar" data-testid="voice-bar" data-joined={inThisClub ? 'true' : 'false'}>
      <div className="voice-roster">
        {roster.length === 0 ? (
          <span className="muted small voice-empty">
            <Icon name="headphones" size={14} /> Voice · nobody here
          </span>
        ) : (
          roster.map((p) => (
            <span key={p.userId} className={`voice-participant${p.speaking ? ' is-speaking' : ''}`} data-testid="voice-participant" data-speaking={p.speaking} title={`${p.displayName}${p.muted ? ' (muted)' : ''}`}>
              <Avatar name={p.displayName} color={p.color} size={32} />
              {p.muted ? <Icon name="mic-off" size={12} /> : null}
            </span>
          ))
        )}
      </div>
      {inThisClub && session ? (
        <div className="voice-controls" role="group" aria-label="Voice controls">
          <button
            type="button"
            className="icon-btn"
            data-testid="voice-mute"
            aria-pressed={session.muted}
            aria-label={session.muted ? 'Unmute' : 'Mute'}
            disabled={session.pushToTalk}
            onClick={() => void setMuted(!session.muted)}
          >
            <Icon name={session.muted ? 'mic-off' : 'mic'} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="voice-deafen"
            aria-pressed={session.deafened}
            aria-label={session.deafened ? 'Undeafen' : 'Deafen'}
            onClick={() => setDeafened(!session.deafened)}
          >
            <Icon name={session.deafened ? 'volume-off' : 'volume'} />
          </button>
          <button
            type="button"
            className={`btn btn-small${session.pushToTalk ? ' is-active' : ''}`}
            data-testid="voice-ptt"
            aria-pressed={session.pushToTalk}
            onClick={() => void setPushToTalkMode(!session.pushToTalk)}
            title="Push-to-talk: hold Space to speak"
          >
            PTT
          </button>
          <button type="button" className="btn btn-ghost" data-testid="voice-leave" onClick={() => void leaveVoice()}>
            Leave voice
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-ghost voice-join" aria-label={joining ? 'Joining…' : 'Join voice'} data-testid="voice-join" onClick={() => void join()} disabled={joining}>
          <Icon name="headphones" size={16} /> <span className="voice-label">{joining ? 'Joining…' : 'Join'}</span>
        </button>
      )}
    </div>
  );
}
