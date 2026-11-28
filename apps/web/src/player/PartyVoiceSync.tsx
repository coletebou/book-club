import { useEffect } from 'react';
import { realtime } from '../lib/realtime';
import { useVoiceSession } from '../live/voiceStore';

const DUCK_VOLUME = 0.25;

/** Keep party voice coordination attached to active playback, including with the sheet closed (D256). */
export default function PartyVoiceSync({ bookId, clubId, element }: { bookId: string; clubId: string; element: HTMLAudioElement | null }) {
  const session = useVoiceSession();
  const handle = session?.clubId === clubId ? session.handle : null;
  useEffect(() => {
    if (!handle) return;
    const volume = element?.volume ?? 1;
    const duck = (speaking: boolean) => {
      if (element) element.volume = speaking ? Math.min(DUCK_VOLUME, volume) : volume;
    };
    const report = (speaking: boolean) => realtime()?.sendPartySpeaking(clubId, bookId, speaking);
    const { room } = handle;
    duck(room.activeSpeakers.some((participant) => participant.identity !== room.localParticipant.identity));
    report(room.localParticipant.isSpeaking);
    const stopDucking = handle.onRemoteSpeaking(duck);
    const stopReporting = handle.onLocalSpeaking(report);
    return () => {
      stopDucking();
      stopReporting();
      duck(false);
      report(false);
    };
  }, [bookId, clubId, element, handle]);
  return null;
}
