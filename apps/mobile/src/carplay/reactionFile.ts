import * as FileSystem from 'expo-file-system/legacy';
import { CreateCommentBodySchema, IdSchema } from '@bookclub/shared';
import { type PendingReaction, type ReactionFile } from './reactionOutbox';

const DIR = `${FileSystem.documentDirectory ?? ''}bookclub-car-reactions/`;

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
    const files = await FileSystem.readDirectoryAsync(DIR);
    let incomplete = false;
    for (const name of files) {
      const match = /^([a-f0-9-]{36})\.json$/.exec(name);
      if (!match) continue;
      try {
        const entry = parseEntry(await FileSystem.readAsStringAsync(DIR + name), match[1]!);
        if (entry) accept(entry);
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) throw new Error('Could not read a saved reaction');
  },
  async write(entry) {
    if (!(await FileSystem.getInfoAsync(DIR)).exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
    const to = `${DIR}${entry.clientId}.json`;
    const from = `${to}.tmp`;
    await FileSystem.writeAsStringAsync(from, JSON.stringify(entry));
    await FileSystem.moveAsync({ from, to });
  },
  async remove(clientId) {
    await FileSystem.deleteAsync(`${DIR}${clientId}.json`, { idempotent: true });
  },
  async clear() {
    await FileSystem.deleteAsync(DIR, { idempotent: true });
  },
};
