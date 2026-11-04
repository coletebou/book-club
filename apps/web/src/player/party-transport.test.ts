import { DEFAULT_PARTY_SETTINGS, type Edition, type PartyState, type PartyControlBody } from '@bookclub/shared';
import { describe, expect, it, vi } from 'vitest';
import { type AudioState } from './AudioProvider';
import { partyTransport, type LocalAudioController } from './party-transport';
import { PartyAudioSync } from './party-sync';

const edition = { id: 'edition', tracks: [{ durationMs: 100_000 }, { durationMs: 100_000 }] } as unknown as Edition;
const party: PartyState = { bookId: 'book', clubId: 'club', editionId: 'edition', hostId: 'host', members: [], settings: DEFAULT_PARTY_SETTINGS, paused: null, track: 0, position: 95, playing: false, rate: 1, updatedAt: Date.now() };

function local(): LocalAudioController {
  return {
    state: { edition, track: 0, position: 0, rate: 1, playing: false, buffering: false } as AudioState,
    held: false,
    element: { currentTime: 95, playbackRate: 1, readyState: 2, paused: true, seeking: false } as HTMLAudioElement,
    play: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), pause: vi.fn(), toggle: vi.fn(), seek: vi.fn(), seekBy: vi.fn(), setTrack: vi.fn(), setRate: vi.fn(),
  };
}

describe('central party transport', () => {
  it('routes main/mini/media-session transport to shared intent, never local audio', async () => {
    const audio = local();
    const send = vi.fn<(body: PartyControlBody) => Promise<void>>().mockResolvedValue(undefined);
    let current: PartyState | null = party;
    const transport = partyTransport(audio, () => current, send);
    transport.toggle();
    await transport.play();
    transport.pause();
    transport.seek(40);
    transport.seekBy(15);
    transport.setTrack(1, 8);
    transport.setRate(1.5);
    expect(send.mock.calls.map(([body]) => body)).toEqual([
      { action: 'play' }, { action: 'play' }, { action: 'pause' }, { action: 'seek', track: 0, position: 40 },
      { action: 'seek', track: 1, position: 10 }, { action: 'seek', track: 1, position: 8 }, { action: 'rate', rate: 1.5 },
    ]);
    for (const method of ['play', 'pause', 'toggle', 'seek', 'seekBy', 'setTrack', 'setRate'] as const) expect(audio[method]).not.toHaveBeenCalled();
    current = { ...party, playing: true };
    transport.toggle();
    expect(send).toHaveBeenLastCalledWith({ action: 'pause' });
    current = null;
    transport.toggle();
    expect(audio.toggle).toHaveBeenCalledOnce();
  });

  it('toggles the latest intended play state, not the last acknowledged one', () => {
    const audio = local();
    const send = vi.fn<(body: PartyControlBody) => Promise<void>>().mockResolvedValue(undefined);
    let intended: boolean | null = true; // A Play is outstanding; the party still says paused.
    const transport = partyTransport(audio, () => party, send, () => intended);
    transport.toggle();
    expect(send).toHaveBeenLastCalledWith({ action: 'pause' });
    intended = false;
    transport.toggle();
    expect(send).toHaveBeenLastCalledWith({ action: 'play' });
    intended = null; // Nothing outstanding: the acknowledged state decides again.
    transport.toggle();
    expect(send).toHaveBeenLastCalledWith({ action: 'play' });
  });

  it('does not fall back to local audio on refused shared control', async () => {
    const audio = local();
    const send = vi.fn<(body: PartyControlBody) => Promise<void>>().mockResolvedValue(undefined); // Provider handles permission/network errors.
    const transport = partyTransport(audio, () => party, send);
    await transport.play();
    expect(audio.play).not.toHaveBeenCalled();
  });
});

describe('party audio sync', () => {
  it('reads the live clock rather than stale React position and uses temporary rates', () => {
    const audio = local();
    const record = vi.fn();
    const sync = new PartyAudioSync();
    sync.apply({ ...party, position: 95.2, playing: true }, audio, record, 1000, 1000);
    expect(audio.seek).not.toHaveBeenCalled(); // React says 0; the live element says 95.
    // A nudge says it is one (D195): played, never shown or kept as anyone's speed.
    expect(audio.setRate).toHaveBeenCalledWith(1.05, { temporary: true, nudge: true });
    expect(audio.play).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'nudge', forced: 'play' }));
  });

  it('holds correction while buffering/seeking and for 1.5 seconds after a seek', () => {
    const audio = local();
    const sync = new PartyAudioSync();
    const record = vi.fn();
    sync.apply({ ...party, position: 30 }, audio, record, 0, 0);
    expect(audio.seek).toHaveBeenCalledWith(30);
    sync.apply({ ...party, position: 30 }, audio, record, 500, 500);
    expect(audio.seek).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'hold' }));
    Object.assign(audio.element!, { seeking: true });
    sync.apply({ ...party, position: 30 }, audio, record, 2000, 2000);
    expect(audio.seek).toHaveBeenCalledTimes(1);
  });

  it('applies forced pause immediately and restores the canonical rate after a seek', () => {
    const audio = local();
    Object.assign(audio.element!, { paused: false, playbackRate: 1.05 });
    const sync = new PartyAudioSync();
    const record = vi.fn();
    sync.apply({ ...party, position: 30 }, audio, record, 0, 0);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.seek).toHaveBeenCalledWith(30);
    expect(audio.setRate).toHaveBeenCalledWith(1, { temporary: true });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'seek', forced: 'pause' }));
  });

  it('resumes a paused player even if an earlier buffering flag is still set', () => {
    const audio = local();
    Object.assign(audio.state, { buffering: true });
    const sync = new PartyAudioSync();
    sync.apply({ ...party, playing: false }, audio, vi.fn(), 0, 0);
    sync.apply({ ...party, playing: true }, audio, vi.fn(), 1000, 1000);
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it('never restarts or chases a locally held player, but still follows a shared pause', () => {
    const audio = local();
    Object.assign(audio, { held: true });
    const record = vi.fn();
    const sync = new PartyAudioSync();
    sync.apply({ ...party, position: 30, playing: true }, audio, record, 0, 0);
    sync.apply({ ...party, track: 1, position: 30, playing: true }, audio, record, 1000, 1000);
    for (const method of ['play', 'seek', 'setTrack', 'setRate'] as const) expect(audio[method]).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce(); // The hold is logged once, then sampled like steady sync.
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'suspended', forced: 'none' }));
    Object.assign(audio.element!, { paused: false }); // Delayed native/hardware Play during the hold.
    sync.apply({ ...party, position: 30, playing: true }, audio, record, 1500, 1500);
    expect(audio.pause).toHaveBeenCalledOnce();
    vi.mocked(audio.pause).mockClear();
    Object.assign(audio.element!, { paused: false });
    sync.apply({ ...party, position: 30, playing: false }, audio, record, 2000, 2000);
    expect(audio.pause).toHaveBeenCalledOnce();
    Object.assign(audio, { held: false });
    Object.assign(audio.element!, { paused: true });
    sync.apply({ ...party, position: 30, playing: true, updatedAt: 3000 }, audio, record, 3000, 3000);
    expect(audio.seek).toHaveBeenCalledWith(30); // Released: back onto the shared clock at once.
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it('changes tracks through local reconciliation (not another shared command)', () => {
    const audio = local();
    const send = vi.fn<(body: PartyControlBody) => Promise<void>>().mockResolvedValue(undefined);
    const transport = partyTransport(audio, () => party, send);
    new PartyAudioSync().apply({ ...party, track: 1, position: 20, playing: true }, audio, vi.fn(), 0, 0);
    expect(audio.setTrack).toHaveBeenCalledWith(1, 20, true);
    expect(send).not.toHaveBeenCalled();
    transport.setTrack(1, 20);
    expect(send).toHaveBeenCalledOnce();
  });
});
