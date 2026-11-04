import { driftCorrection, projectPosition, type PartyDiagnosticInput, type PartyState } from '@bookclub/shared';
import { maxPlayableRate } from './native-bridge';
import { type LocalAudioController } from './party-transport';

/** One driver per active player, kept alive across page navigation. */
export class PartyAudioSync {
  private lastSeekAt = -Infinity;
  private lastSeekStateAt = -Infinity;
  private lastSampleAt = -Infinity;
  private suspended = false;

  apply(p: PartyState, audio: LocalAudioController, record: (event: PartyDiagnosticInput) => void, statusAt: number, now = Date.now()): void {
    const s = audio.state;
    const el = audio.element;
    if (!el || s.edition?.id !== p.editionId) return;
    const duration = (s.edition.tracks[p.track]?.durationMs ?? 0) / 1000;
    const projected = projectPosition(p, now);
    const expected = duration > 0 ? Math.min(projected, duration) : projected;
    // The live element (not React's last timeupdate render) is the freshest clock available.
    const position = Number.isFinite(el.currentTime) ? el.currentTime : s.position;
    let decision: PartyDiagnosticInput['decision'] = 'steady';
    const entering = audio.held && !this.suspended;
    this.suspended = audio.held;
    if (audio.held) {
      // A local interruption (a voice note, Cal speaking) holds this device's audio: no restart, no
      // seek or track chase, and no shared Pause either. Releasing the hold resyncs straight away.
      decision = 'suspended';
    } else if (s.track !== p.track) {
      audio.setTrack(p.track, expected, p.playing);
      audio.setRate(p.rate, { temporary: true });
      this.lastSeekAt = now;
      this.lastSeekStateAt = p.updatedAt;
      decision = 'track';
    } else if (el.readyState < 1 || s.buffering || el.seeking || (now - this.lastSeekAt < 1500 && p.updatedAt <= this.lastSeekStateAt)) {
      // A repeated seek while an earlier seek/track load buffers makes network playback worse.
      decision = 'hold';
    } else {
      const correction = driftCorrection(position, expected, p.rate);
      if (correction.seekTo !== null) {
        audio.seek(correction.seekTo);
        this.lastSeekAt = now;
        this.lastSeekStateAt = p.updatedAt;
        decision = 'seek';
      }
      const rate = !p.playing || correction.seekTo !== null ? p.rate : correction.rate;
      // Compared with what this device can play: an iOS build that stops at 2× (D195) would
      // otherwise be told the party's 2.5× again every second, to no effect.
      if (Math.abs(Math.min(rate, maxPlayableRate()) - el.playbackRate) > 0.001) {
        audio.setRate(rate, rate === p.rate ? { temporary: true } : { temporary: true, nudge: true });
        if (decision !== 'seek') decision = rate === p.rate ? 'rate' : 'nudge';
      }
    }
    let forced: PartyDiagnosticInput['forced'] = 'none';
    if ((!p.playing || audio.held) && (!el.paused || s.playing)) { audio.pause(); forced = 'pause'; }
    // Track changes already arrange autoplay; don't issue a second native play before it loads.
    else if (p.playing && el.paused && el.readyState >= 1 && decision !== 'track' && decision !== 'suspended') { void audio.play(); forced = 'play'; }
    const sample = decision === 'suspended' ? entering : decision !== 'steady';
    if (sample || forced !== 'none' || now - this.lastSampleAt >= 5000) {
      this.lastSampleAt = now;
      record({ event: 'sync', decision, forced, track: p.track, position, expected, drift: expected - position, rate: el.playbackRate, partyRate: p.rate, playing: !el.paused, partyPlaying: p.playing, buffering: s.buffering, seeking: !!el.seeking, readyState: el.readyState, stateAgeMs: Math.min(604_800_000, Math.max(0, now - p.updatedAt)), statusAgeMs: Math.min(604_800_000, Math.max(0, now - statusAt)) });
    }
  }
}
