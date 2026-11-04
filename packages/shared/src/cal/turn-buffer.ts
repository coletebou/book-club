/**
 * Caps how many bytes of audio one voice turn with Cal may accumulate in memory before STT ever
 * sees any of it (PR #13 security review, `apps/server/src/routes/cal-voice.ts`). Fastify's own
 * `maxPayload` only bounds a single WebSocket frame (64 KiB); nothing bounded how many frames a
 * turn could hold, so an authenticated club member could stream binary frames forever without
 * ever sending `{type:"end"}` — the rate limit and the monthly spend cap both run only there — and
 * grow one unbroken turn large enough to exhaust the Node process every club shares, or, once it
 * did end, large enough on its own to blow past `CAL_MONTHLY_SPEND_CAP_USD` in a single STT/TTS
 * call. Pure and tiny so the cap itself (not the WebSocket plumbing around it) is what gets tested.
 */
export class TurnBuffer {
  private bytes = 0;
  private readonly chunks: Uint8Array[] = [];

  constructor(private readonly maxBytes: number) {}

  get totalBytes(): number {
    return this.bytes;
  }

  /** Appends a chunk. Returns `false`, and does not append it, once `maxBytes` would be exceeded. */
  push(chunk: Uint8Array): boolean {
    if (this.bytes + chunk.byteLength > this.maxBytes) return false;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    return true;
  }

  /** Concatenates every chunk collected so far into one buffer, and clears it. */
  take(): Uint8Array {
    const out = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.clear();
    return out;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }
}
