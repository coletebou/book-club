import type {} from '@fastify/cookie';
import type {} from '@fastify/websocket';
import { type FastifyBaseLogger } from 'fastify';
import { type Config } from './config';
import { type Db } from './db/db';
import { type ApnsClient } from './push/apns';
import { type Hub } from './realtime/hub';
import { type PartyManager } from './realtime/party';
import { type UserRow } from './repos/users';
import { type ChatAgents } from './services/chat-agents';
import { type Jobs } from './services/jobs';
import { type Storage } from './storage/storage';

export interface AppContext {
  readonly config: Config;
  readonly db: Db;
  readonly storage: Storage;
  readonly hub: Hub;
  /** Listening parties (D155): ephemeral, in-memory, broadcast over `hub` (see realtime/party.ts). */
  readonly parties: PartyManager;
  readonly jobs: Jobs;
  /** Long background work (speech recognition), so it never holds up an upload's ingest. */
  readonly slowJobs: Jobs;
  /** Cal's own background work (indexing, embedding), kept off slowJobs: its pending count is a documented invariant other tests assert on, independent of Cal. */
  readonly calJobs: Jobs;
  /** The agents that take part in chat (D204: Cal) and their background work (an answer being written). */
  readonly agents: ChatAgents;
  /** The iOS app's push, or null with APNS_* unset: the in-app bell still works either way. */
  readonly push: ApnsClient | null;
  readonly log: FastifyBaseLogger;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    sessionToken: string | null;
  }
}
