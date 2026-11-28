import * as FileSystem from 'expo-file-system/legacy';
import { CreateCommentBodySchema, IdSchema } from '@bookclub/shared';
import { type PendingReaction, type ReactionFile } from './reactionOutbox';

const DIR = `${FileSystem.documentDirectory ?? ''}bookclub-car-reactions/`;
const TAP_FILE = /^([a-f0-9-]{36})\.json(\.tmp)?$/;
const MAX_PENDING = 128;

function parseEntry(json: string, clientId: string): PendingReaction | null {
  try {
    const value = JSON.parse(json) as { bookId: unknown; userId: unknown };
    const body = CreateCommentBodySchema.safeParse(value);
    if (!body.success || body.data.locator.kind !== 'audio' || !body.data.reaction || body.data.clientId !== clientId) return null;
    const bookId = IdSchema.safeParse(value.bookId);
    const userId = IdSchema.safeParse(value.userId);
    if (!bookId.success || !userId.success) return null;
    return { userId: userId.data, bookId: bookId.data, editionId: body.data.editionId, locator: body.data.locator, reaction: body.data.reaction, clientId };
  } catch {
    return null;
  }
}

/** Each tap gets its own atomic file. A partial write can never replace another pending tap. */
export const reactionFile: ReactionFile = {
  async read(accept) {
    if (!(await FileSystem.getInfoAsync(DIR)).exists) return;
    const files = (await FileSystem.readDirectoryAsync(DIR)).sort(); // Final files precede their temporary copies.
    const seen = new Map<string, 'saved' | 'unreadable'>();
    let incomplete = false;
    for (const name of files) {
      const match = TAP_FILE.exec(name);
      if (!match) continue;
      const clientId = match[1]!;
      const temporary = match[2] !== undefined;
      const from = DIR + name;
      try {
        if (seen.get(clientId) === 'unreadable') continue;
        if (seen.get(clientId) === 'saved') {
          await FileSystem.deleteAsync(from, { idempotent: true });
          continue;
        }
        const entry = parseEntry(await FileSystem.readAsStringAsync(from), clientId);
        if (!entry) {
          await FileSystem.deleteAsync(from, { idempotent: true });
          continue;
        }
        if (temporary) await FileSystem.moveAsync({ from, to: `${DIR}${clientId}.json` }).catch(() => undefined);
        seen.set(clientId, 'saved');
        accept(entry);
      } catch {
        if (!temporary) seen.set(clientId, 'unreadable');
        incomplete = true;
      }
    }
    if (incomplete) throw new Error('Could not read a saved reaction');
  },
  async write(entry) {
    if (!(await FileSystem.getInfoAsync(DIR)).exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
    const files = await FileSystem.readDirectoryAsync(DIR);
    const pending = new Set(files.flatMap((name) => TAP_FILE.exec(name)?.[1] ?? []));
    if (pending.size >= MAX_PENDING && !pending.has(entry.clientId)) throw new Error('Too many pending reactions');
    const to = `${DIR}${entry.clientId}.json`;
    const from = `${to}.tmp`;
    await FileSystem.writeAsStringAsync(from, JSON.stringify(entry));
    // The complete temporary file is already durable and the reader can recover it.
    await FileSystem.moveAsync({ from, to }).catch(() => undefined);
  },
  async remove(clientId) {
    const final = `${DIR}${clientId}.json`;
    await Promise.all([FileSystem.deleteAsync(final, { idempotent: true }), FileSystem.deleteAsync(`${final}.tmp`, { idempotent: true })]);
  },
  async clear() {
    await FileSystem.deleteAsync(DIR, { idempotent: true });
  },
};
