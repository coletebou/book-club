import { type NotificationView } from '@bookclub/shared';
import { type AppContext } from '../context';
import { type ApnsPush } from '../push/apns';
import { pushTokensFor, removePushToken } from '../repos/push-tokens';

/**
 * The push a notification becomes on a lock screen (D134): the same words the bell already shows
 * (`describe()` in apps/web, mirrored here), opening to the same place a tap on the bell does
 * (`/books/<id>#note-<id>`, `components/Notifications.tsx`). Never carries more than the bell
 * does: a reply held by D69's gate stays held in its push too (`text` and `horizon` already
 * reflect that by the time a `NotificationView` reaches here).
 */
export function pushPayloadFor(id: string, n: NotificationView): ApnsPush {
  if (n.kind === 'mention') {
    const body = n.text
      ? `${n.actorName} mentioned you: “${n.text}”`
      : n.horizon
        ? `${n.actorName} mentioned you from ${n.horizon} · it opens when you get there`
        : `${n.actorName} mentioned you`;
    return { title: n.clubName ?? 'Book Club', body, path: `/clubs/${n.clubId}/chat`, collapseId: id };
  }
  const count = n.count ?? 1;
  const body =
    n.kind === 'reached'
      ? count > 1
        ? `${n.actorName} got to ${count} of your notes`
        : `${n.actorName} got to your note`
      : n.text
        ? `${n.actorName} replied: “${n.text}”`
        : n.horizon
          ? `${n.actorName} replied from ${n.horizon} · it opens when you get there`
          : `${n.actorName} replied`;
  return { title: n.bookTitle ?? 'Book Club', body, path: `/books/${n.bookId}#note-${n.noteId}`, collapseId: id };
}

/** Push a notification to every device the user has registered; a dead token is forgotten. */
export async function pushToUser(ctx: AppContext, userId: string, push: ApnsPush): Promise<void> {
  if (!ctx.push) return;
  const client = ctx.push;
  const tokens = pushTokensFor(ctx.db, userId);
  await Promise.all(
    tokens.map(async (row) => {
      try {
        const outcome = await client.send(row.token, push);
        if (outcome === 'unregistered') removePushToken(ctx.db, row.token);
      } catch (err) {
        ctx.log.warn({ err }, 'push to a device failed');
      }
    }),
  );
}
