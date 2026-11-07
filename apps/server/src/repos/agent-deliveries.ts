import { type Db } from '../db/db';

/** A message delivered to an agent of another service (D205, migration 025): what its answer may be fenced by. */
export interface AgentDeliveryRow {
  id: string;
  agent: string;
  /** Null once its message is removed for good (it outlives it: the agent had its words). */
  message_id: string | null;
  club_id: string;
  book_id: string | null;
  /** Null once its asker's account is removed for good. */
  asker_id: string | null;
  /** The furthest fence of everything the delivery carried; null when none of it was fenced (always in General). */
  fence_t: number | null;
  created_at: number;
}

/** Keep a delivery before its first attempt. A message is delivered to an agent once: a second call keeps the first. */
export function recordAgentDelivery(db: Db, row: Omit<AgentDeliveryRow, 'created_at' | 'message_id' | 'asker_id'> & { message_id: string; asker_id: string }): void {
  db.exec(
    `INSERT INTO agent_deliveries (id, agent, message_id, club_id, book_id, asker_id, fence_t, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent, message_id) DO NOTHING`,
    [row.id, row.agent, row.message_id, row.club_id, row.book_id, row.asker_id, row.fence_t, Date.now()],
  );
}

/** A retry carries more than the attempts before it (its asker read on meanwhile): its fence only ever rises. */
export function raiseAgentDeliveryFence(db: Db, id: string, t: number): void {
  db.exec('UPDATE agent_deliveries SET fence_t = ? WHERE id = ? AND (fence_t IS NULL OR fence_t < ?)', [t, id, t]);
}

/** The delivery of a message to an agent, if it was ever delivered to that agent. */
export function agentDeliveryOf(db: Db, agent: string, messageId: string): AgentDeliveryRow | undefined {
  return db.get<AgentDeliveryRow>('SELECT * FROM agent_deliveries WHERE agent = ? AND message_id = ?', [agent, messageId]);
}

/** The furthest fence ever delivered to an agent in a book's channel; null when nothing fenced ever was. */
export function furthestAgentFence(db: Db, agent: string, clubId: string, bookId: string): number | null {
  return db.get<{ t: number | null }>('SELECT MAX(fence_t) AS t FROM agent_deliveries WHERE agent = ? AND club_id = ? AND book_id = ?', [agent, clubId, bookId])?.t ?? null;
}
