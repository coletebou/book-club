import { useEffect } from 'react';
import { useAudioMaybe } from './AudioProvider';

/**
 * While recording a voice note, or playing one back, the audiobook pauses, and resumes after
 * (D140): through the one player's own controller (AudioProvider's `useAudio`), never a second
 * `<audio>` element of its own. It is a local hold, not a command: in a listening party it never
 * sends a shared Pause, and party sync does not restart the audiobook over the note; when the hold
 * ends, the player rejoins the party's clock where everyone is by then. Alone, it resumes only what
 * a hold paused: playing on top of a friend who had already paused does not start it for them, and
 * `resumeAlone: false` (Cal speaking) leaves a solo player paused afterwards, as before.
 * `useAudioMaybe` (not `useAudio`): a note's media composer or player can render outside the
 * app-wide `AudioProvider` (a unit test, say) with nothing to pause; this is then a no-op.
 */
export function usePauseAudiobookWhile(active: boolean, options?: { resumeAlone?: boolean }): void {
  const audio = useAudioMaybe();
  const resumeAlone = options?.resumeAlone;
  useEffect(() => {
    if (!audio || !active) return;
    // Released when `active` ends or the component unmounts mid-note.
    return audio.hold({ resumeAlone });
    // Only `active`'s edges matter: a new controller identity must not end and retake the hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
