import { PARTY_DIAGNOSTIC_BATCH_MAX, PartyDiagnosticEventSchema, type PartyDiagnosticEvent, type PartyDiagnosticInput, type PartyDiagnosticsBody } from '@bookclub/shared';

const QUEUE_MAX = 80;
const FLUSH_MS = 5000;

/** Best effort, memory only, bounded even offline. Diagnostics must never hold up audio. */
export class PartyDiagnostics {
  private queue: PartyDiagnosticEvent[] = [];
  private readonly started = Date.now();
  private readonly sessionId = crypto.randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private stopped = false;
  private nextSendAt = 0;

  constructor(private readonly send: (body: PartyDiagnosticsBody) => Promise<void>, private readonly partyId?: string) {}

  start(): void {
    if (!this.timer && !this.stopped) this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  record(input: PartyDiagnosticInput): void {
    if (this.stopped) return;
    const result = PartyDiagnosticEventSchema.safeParse({ ...input, elapsedMs: Math.min(604_800_000, Math.max(0, Date.now() - this.started)) });
    if (!result.success) return; // Also enforce privacy/finite numbers on the device.
    if (this.queue.length === QUEUE_MAX) this.queue.shift();
    this.queue.push(result.data);
  }

  async flush(): Promise<void> {
    if (this.stopped || this.inFlight || !this.queue.length || Date.now() < this.nextSendAt) return;
    this.inFlight = true;
    this.nextSendAt = Date.now() + FLUSH_MS; // At most 12 attempts/minute, including failures.
    const events = this.queue.splice(0, PARTY_DIAGNOSTIC_BATCH_MAX);
    try {
      await this.send({ version: 1, ...(this.partyId ? { partyId: this.partyId } : {}), sessionId: this.sessionId, events });
    } catch (err) {
      // No replay/outbox: stale logs are less useful than current state. Back off (including 429).
      const status = err && typeof err === 'object' && 'status' in err ? err.status : 0;
      this.nextSendAt = Date.now() + (status === 429 ? 60_000 : 30_000);
      if (status === 401 || status === 403 || status === 409) this.stop();
    } finally {
      this.inFlight = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = []; // Never carry one participant's records into another session.
  }
}
