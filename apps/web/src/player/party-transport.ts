import { projectPosition, type PartyControlBody, type PartyState } from '@bookclub/shared';
import { type AudioController } from './AudioProvider';
import { trackPositionForSeek } from './track-seek';

export type LocalAudioController = Pick<AudioController, 'state' | 'element' | 'held' | 'play' | 'pause' | 'toggle' | 'seek' | 'seekBy' | 'setTrack' | 'setRate'>;

/**
 * Public transport always means intent; only the sync driver uses the explicitly local methods.
 * `intendedPlaying` is the play state this device last asked for and the party has not answered
 * yet (null with nothing outstanding): a second press of play/pause flips that, not the older
 * acknowledged state, so Play, Pause in quick succession means Pause rather than Play twice.
 */
export function partyTransport(
  local: LocalAudioController,
  getParty: () => PartyState | null,
  send: (body: PartyControlBody) => Promise<void>,
  intendedPlaying: () => boolean | null = () => null,
): LocalAudioController {
  const route = (body: PartyControlBody): boolean => {
    if (!getParty()) return false;
    void send(body);
    return true;
  };
  return {
    get state() { return local.state; },
    get element() { return local.element; },
    get held() { return local.held; },
    async play() {
      if (getParty()) await send({ action: 'play' });
      else await local.play();
    },
    pause() { if (!route({ action: 'pause' })) local.pause(); },
    toggle() {
      const p = getParty();
      if (p) void send({ action: (intendedPlaying() ?? p.playing) ? 'pause' : 'play' });
      else local.toggle();
    },
    seek(position) {
      const p = getParty();
      if (p) void send({ action: 'seek', track: p.track, position: Math.max(0, position) });
      else local.seek(position);
    },
    seekBy(delta) {
      const p = getParty();
      const edition = local.state.edition;
      if (!p || !edition) { local.seekBy(delta); return; }
      const target = trackPositionForSeek(edition.tracks, p.track, projectPosition(p, Date.now()) + delta);
      void send({ action: 'seek', ...target });
    },
    setTrack(track, position = 0, autoplay) {
      if (!route({ action: 'seek', track, position: Math.max(0, position) })) local.setTrack(track, position, autoplay);
    },
    setRate(rate) { if (!route({ action: 'rate', rate })) local.setRate(rate); },
  };
}
