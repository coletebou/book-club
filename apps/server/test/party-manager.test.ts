import { projectPosition } from '@bookclub/shared';
import { type FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyManager } from '../src/realtime/party';
import { type Hub } from '../src/realtime/hub';

describe('party transition diagnostics', () => {
  let manager: PartyManager;
  let info = vi.fn<(obj: unknown, msg: string) => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    info = vi.fn<(obj: unknown, msg: string) => void>();
    manager = new PartyManager({ publish: vi.fn() } as unknown as Hub, { info } as unknown as FastifyBaseLogger);
    manager.start();
    manager.startParty('club', 'book', 'edition', 'host', 'Private host name', '#abc');
    manager.join('club', 'book', 'member', 'Private member name', '#def');
  });
  afterEach(() => { manager.stop(); vi.useRealTimers(); });

  it('records controls, speaking, auto-pause and auto-resume at info without names or resync spam', () => {
    manager.control('club', 'book', 'host', { action: 'play' });
    manager.speaking('club', 'book', 'member', true);
    vi.advanceTimersByTime(1000);
    expect(manager.get('club', 'book')?.paused?.reason).toBe('interruption');
    manager.speaking('club', 'book', 'member', false);
    vi.advanceTimersByTime(4000);
    expect(manager.get('club', 'book')?.playing).toBe(true);
    const events = info.mock.calls.map(([, msg]) => msg);
    expect(events).toEqual(['party.start', 'party.join', 'party.control', 'party.speaking', 'party.auto-pause', 'party.speaking', 'party.auto-resume']);
    expect(JSON.stringify(info.mock.calls)).not.toContain('Private');
  });

  it('ignores nonparticipants speaking, and leaving clears a stuck speaking interruption', () => {
    manager.control('club', 'book', 'host', { action: 'play' });
    manager.speaking('club', 'book', 'stranger', true);
    vi.advanceTimersByTime(1000);
    expect(manager.get('club', 'book')?.playing).toBe(true);
    manager.speaking('club', 'book', 'member', true);
    vi.advanceTimersByTime(1000);
    expect(manager.get('club', 'book')?.playing).toBe(false);
    manager.leave('club', 'book', 'member');
    vi.advanceTimersByTime(4000);
    expect(manager.get('club', 'book')?.playing).toBe(true);
  });
  it('does not rewind the next track when a second listener ends the old track late', () => {
    manager.control('club', 'book', 'host', { action: 'play' });
    manager.control('club', 'book', 'host', { action: 'seek', track: 1, position: 0, fromTrack: 0 });
    const first = manager.get('club', 'book')!;
    vi.advanceTimersByTime(2000);
    manager.control('club', 'book', 'member', { action: 'seek', track: 1, position: 0, fromTrack: 0 });
    const second = manager.get('club', 'book')!;
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.revision).toBe(first.revision);
    expect(projectPosition(second, Date.now())).toBe(2);
  });

  it('versions membership and settings even when the projection timestamp does not change', () => {
    const first = manager.get('club', 'book')!;
    manager.control('club', 'book', 'host', { action: 'settings', settings: { hostOnlyControls: true } });
    const second = manager.get('club', 'book')!;
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.revision).toBeGreaterThan(first.revision!);
    manager.leave('club', 'book', 'member');
    const third = manager.get('club', 'book')!;
    expect(third.revision).toBeGreaterThan(second.revision!);
  });

  it('deduplicates speaking and bounds rapid alternating server diagnostic transitions', () => {
    manager.control('club', 'book', 'host', { action: 'settings', settings: { autoPause: false } });
    manager.control('club', 'book', 'host', { action: 'play' });
    for (let i = 0; i < 100; i++) manager.speaking('club', 'book', 'member', true);
    expect(info.mock.calls.filter(([, msg]) => msg === 'party.speaking')).toHaveLength(1);
    for (let i = 0; i < 1000; i++) manager.speaking('club', 'book', 'member', i % 2 === 0);
    expect(info.mock.calls.filter(([, msg]) => msg === 'party.speaking').length).toBeLessThanOrEqual(120);
  });

  it('refuses a delayed command for a party incarnation that has ended', () => {
    const old = manager.get('club', 'book')!;
    manager.leave('club', 'book', 'member');
    manager.leave('club', 'book', 'host');
    const next = manager.startParty('club', 'book', 'edition', 'host', 'Private', '#abc');
    expect(next.partyId).not.toBe(old.partyId);
    expect(manager.control('club', 'book', 'host', { action: 'play', partyId: old.partyId })).toEqual({ ok: false, reason: 'not_found' });
    expect(manager.get('club', 'book')?.playing).toBe(false);
  });

  it('does not let a late end command undo a newer rewind or final-track play', () => {
    manager.control('club', 'book', 'host', { action: 'play' });
    const ending = manager.get('club', 'book')!;
    manager.control('club', 'book', 'member', { action: 'seek', track: 0, position: 20 });
    manager.control('club', 'book', 'host', { action: 'seek', track: 1, position: 0, fromTrack: 0, expectedClockRevision: ending.clockRevision });
    expect(manager.get('club', 'book')?.track).toBe(0);
    expect(manager.get('club', 'book')?.position).toBe(20);
    const beforeReplay = manager.get('club', 'book')!;
    manager.control('club', 'book', 'member', { action: 'play' });
    manager.control('club', 'book', 'host', { action: 'pause', expectedClockRevision: beforeReplay.clockRevision });
    expect(manager.get('club', 'book')?.playing).toBe(true);
  });

});
