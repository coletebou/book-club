import { projectPosition, type PartyControlBody, type PartyState } from '@bookclub/shared';
import { type AudioController } from './AudioProvider';

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
      let track = p.track;
      let position = projectPosition(p, Date.now()) + delta;
      while (position < 0 && track > 0) position += (edition.tracks[--track]?.durationMs ?? 0) / 1000;
      while (track < edition.tracks.length - 1) {
        const duration = (edition.tracks[track]?.durationMs ?? 0) / 1000;
        if (duration <= 0 || position <= duration) break;
        position -= duration;
        track++;
      }
      const duration = (edition.tracks[track]?.durationMs ?? 0) / 1000;
      void send({ action: 'seek', track, position: Math.max(0, duration > 0 ? Math.min(position, duration) : position) });
    },
    setTrack(track, position = 0, autoplay) {
      if (!route({ action: 'seek', track, position: Math.max(0, position) })) local.setTrack(track, position, autoplay);
    },
    setRate(rate) { if (!route({ action: 'rate', rate })) local.setRate(rate); },
  };
}
