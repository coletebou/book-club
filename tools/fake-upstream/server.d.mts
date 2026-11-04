import { type Server } from 'node:http';

export interface UpstreamAccount {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly emailVerified: boolean;
}

export interface UpstreamOptions {
  /** Book Club's callback addresses; the one by the name the browser came by is used. Read on each request. */
  readonly callbacks: readonly string[];
  /** The clock, in milliseconds (tests move it on). */
  readonly now?: (() => number) | undefined;
  /** The bearer POST .../password requires. Unset: that route answers 404, as if it did not exist. */
  readonly passwordSecret?: string | undefined;
}

export const DEMO_PASSWORD: string;
export const SESSION_COOKIE: string;
export function account(email: string): UpstreamAccount | null;
export function createFakeUpstream(options: UpstreamOptions): Server;
