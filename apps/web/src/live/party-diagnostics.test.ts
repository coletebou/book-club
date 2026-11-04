import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyDiagnosticsBodySchema, type PartyDiagnosticsBody } from '@bookclub/shared';
import { PartyDiagnostics } from './party-diagnostics';

describe('party diagnostics batching', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps at most 80 records, batches 20, and sends only validated data', async () => {
    const send = vi.fn<(body: PartyDiagnosticsBody) => Promise<void>>().mockResolvedValue();
    const log = new PartyDiagnostics(send);
    log.start();
    for (let i = 0; i < 200; i++) log.record({ event: 'sync', position: i });
    // Runtime validation also rejects unexpected private data despite a caller bypassing TS.
    log.record({ event: 'media', url: 'https://secret.test/token', position: NaN } as never);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(4);
    const batches = send.mock.calls.map(([body]) => PartyDiagnosticsBodySchema.parse(body));
    expect(batches.flatMap((b) => b.events)).toHaveLength(80);
    expect(batches[0]!.events[0]!.position).toBe(120);
    expect(new Set(batches.map((b) => b.sessionId)).size).toBe(1);
    expect(JSON.stringify(batches)).not.toContain('secret');
    log.stop();
  });

  it('never overlaps requests and drops old failed batches with backoff', async () => {
    let reject!: (err: unknown) => void;
    const send = vi.fn<(body: PartyDiagnosticsBody) => Promise<void>>().mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; })).mockResolvedValue();
    const log = new PartyDiagnostics(send);
    log.start();
    log.record({ event: 'joined' });
    await vi.advanceTimersByTimeAsync(5000);
    log.record({ event: 'sync' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledTimes(1);
    reject({ status: 429 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].events.map((e) => e.event)).toEqual(['sync']);
    log.stop();
  });

  it('stops on revoked access and never carries records into another participation', async () => {
    const send = vi.fn<(body: PartyDiagnosticsBody) => Promise<void>>().mockRejectedValue({ status: 403 });
    const log = new PartyDiagnostics(send);
    log.start();
    log.record({ event: 'joined' });
    await vi.advanceTimersByTimeAsync(5000);
    log.record({ event: 'sync' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
    const next = new PartyDiagnostics(send);
    next.record({ event: 'joined' });
    await next.flush();
    expect(send.mock.calls[1]![0].sessionId).not.toBe(send.mock.calls[0]![0].sessionId);
    next.stop();
  });
});
