import { Icon } from '../components/Icon';
import { useAudio, useAudioTransportPlaying } from './AudioProvider';

/**
 * The main transport button describes its next command, not whether this device is audible. Until
 * this page's audiobook is in the player (`loaded`) it does nothing: its tap would play, and move
 * the place of, whatever else the player still holds (another book, paused in the mini player).
 */
export function PlayPauseButton({ loaded }: { loaded: boolean }) {
  const audio = useAudio();
  const playing = useAudioTransportPlaying() && loaded;
  return (
    <button type="button" className="play-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={() => audio.toggle()} disabled={!loaded} data-testid="play-pause" data-playing={playing ? 'true' : 'false'}>
      <Icon name={playing ? 'pause' : 'play'} size={30} />
    </button>
  );
}
