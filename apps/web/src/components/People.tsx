import type { Member, PresenceEntry } from '@bookclub/shared';
import { useBrowserOnline } from '../lib/online';

/** Up to two initials, by whole characters (an emoji or a letter outside the BMP is one, not half). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const chars = (s: string) => Array.from(s);
  return (parts.length === 1 ? chars(parts[0]!).slice(0, 2).join('') : chars(parts[0]!)[0]! + chars(parts[parts.length - 1]!)[0]!).toUpperCase();
}

export function Avatar({ name, color, online, reading, size = 34 }: { name: string; color: string; online?: boolean; reading?: boolean; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ background: color, width: size, height: size, fontSize: size * 0.38 }}
      data-online={online ? 'true' : undefined}
      data-reading={reading ? 'true' : undefined}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/**
 * Club members with who is online and who is reading right now: a row of faces that fits a phone
 * (a gold ring while someone reads). Where each one is, in words, is in the accessible text and
 * the tooltip; the book cards and the book page show positions. With no network you are offline,
 * as the header says, and nobody's presence is known.
 */
export function PresenceList({
  members,
  presence,
  selfId,
  books = [],
}: {
  members: readonly Member[];
  presence: ReadonlyMap<string, PresenceEntry>;
  selfId?: string | undefined;
  /** The club's books: with more than one, a reader's says which book. */
  books?: readonly { readonly id: string; readonly title: string }[];
}) {
  const online = useBrowserOnline();
  return (
    <ul className="presence-list" aria-label="Members">
      {members.map((m) => {
        const p = online ? presence.get(m.userId) : undefined;
        // In a book now (data-status "reading"); in words, listening is not reading.
        const status = p?.reading ? 'reading' : p?.online ? 'online' : !online && m.userId === selfId ? 'offline' : 'away';
        const doing = p?.reading?.kind === 'audio' ? 'listening' : 'reading';
        const shown = p?.reading ? doing : status;
        const full = p?.reading ? `${doing} now · ${p.reading.label}` : status;
        return (
          <li key={m.userId} className="presence-item" data-testid="presence-member" data-user={m.userId} data-status={status} title={`${m.displayName}: ${full}`}>
            <Avatar name={m.displayName} color={m.color} online={!!p?.online} reading={!!p?.reading} size={44} />
            <span className="presence-name">
              {m.displayName}
              {m.role === 'owner' ? <span className="visually-hidden"> (owner)</span> : null}
            </span>
            <span className={`presence-status${p?.reading ? ' is-reading' : ''}`} aria-hidden="true">
              {shown}
            </span>
            {/* Where, on the page and not only in a tooltip: a phone has no hover. */}
            {p?.reading ? (
              <span className="presence-where" aria-hidden="true" data-testid="presence-where">
                {p.reading.label.split(' · ')[0]}
                {books.length > 1 ? <span className="presence-book">{books.find((b) => b.id === p.reading!.bookId)?.title ?? ''}</span> : null}
              </span>
            ) : null}
            <span className="visually-hidden">, {full}</span>
          </li>
        );
      })}
    </ul>
  );
}
