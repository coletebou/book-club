import { type PartyDiagnosticsBody } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportNativeErrors } from './native-error-report';

const diag = (detail: unknown) => new CustomEvent('native-diagnostic', { detail });

describe('native playback errors outside a party (D219)', () => {
  let el: EventTarget;
  let sent: PartyDiagnosticsBody[];
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    el = new EventTarget();
    sent = [];
  });
  afterEach(() => { stop?.(); vi.useRealTimers(); });

  it('sends errors with the track, domain, code and source, and nothing else native says', async () => {
    let track = 39;
    stop = reportNativeErrors(el, () => track, async (body) => { sent.push(body); });
    el.dispatchEvent(diag({ event: 'native-source', source: 'native-local' }));
    el.dispatchEvent(diag({ event: 'native-error', outcome: 'failed', source: 'native-local', recovered: true, errorDomain: 'AVFoundationErrorDomain', errorCode: -11828 }));
    track = 40;
    el.dispatchEvent(diag({ event: 'native-error', outcome: 'failed', source: 'native-network' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.partyId).toBeUndefined();
    expect(sent[0]!.events.map((e) => ({ ...e, elapsedMs: 0 }))).toEqual([
      { event: 'native-error', outcome: 'failed', source: 'native-local', recovered: true, errorDomain: 'AVFoundationErrorDomain', errorCode: -11828, track: 39, elapsedMs: 0 },
      { event: 'native-error', outcome: 'failed', source: 'native-network', track: 40, elapsedMs: 0 },
    ]);
  });

  it('drops anything outside the closed schema on the device', async () => {
    stop = reportNativeErrors(el, () => 1, async (body) => { sent.push(body); });
    el.dispatchEvent(diag({ event: 'native-error', outcome: 'failed', message: 'Cannot Open /private/var/mobile/x' }));
    el.dispatchEvent(diag({ event: 'native-error', outcome: 'failed', errorDomain: 'free text' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([]);
  });

  it('sends what is queued when it stops, and listens no more', async () => {
    stop = reportNativeErrors(el, () => 2, async (body) => { sent.push(body); });
    el.dispatchEvent(diag({ event: 'native-error', outcome: 'failed', source: 'native-network' }));
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    el.dispatchEvent(diag({ event: 'native-error', outcome: 'failed', source: 'native-network' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
  });
});
