import type { Server } from 'node:http';

/** Whether a delivery was signed with `secret` over this very body, within five minutes of `now` (ms): node:crypto's own check. */
export function genuine(secret: string, body: string, timestamp: string | undefined, signature: string | string[] | undefined, now?: number): boolean;

export interface FakeAgentDelivery {
  readonly at: number;
  readonly verified: boolean;
  readonly delivery: string | null;
  readonly event: string | null;
  readonly body: unknown;
}

export function startFakeAgent(options: {
  host?: string;
  port?: number;
  secret: string;
  token: string;
  /** Another origin in front of the paths deliveries name (the demo stack's containers). */
  api?: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<{ server: Server; deliveries: FakeAgentDelivery[]; port: number }>;
