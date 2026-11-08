import { z } from 'zod';

/**
 * What a Book Club message in iMessage says (D220): the URL an `MSMessage` carries, made by the iOS
 * app's Messages extension (`apps/mobile/targets/messages`) and read by it, and, for anyone in the
 * thread without the app, by the web app's `/m` page. The same format in Swift
 * (`targets/messages/_shared/BookClubMessage.swift`), held to the same golden vectors
 * (`imessage-vectors.json`).
 *
 * A thread can hold people who are not in the club, and every one of them sees the same bubble, so
 * a message never carries what only a member may see (INTENT.md, "A friend's files leaking", "A
 * spoiler"): no passage, comment or note text, no cover, no one else's progress. It carries ids,
 * which the server answers only for a member, and what the sender chose to say about themselves:
 * the book's title and how far *they* are. Text that is gated (a quote, a vote's tally, who is
 * coming) is fetched live by each reader's own extension, as that reader, through the server's
 * own gate.
 *
 * The payload sits in the URL's fragment, which a browser never sends to the server: a link opened
 * on the web carries no ids in any access log.
 */

export const MESSAGE_FORMAT_VERSION = 1;

/** The path of the web page that opens a message for someone without the app. */
export const MESSAGE_PATH = '/m';

const Id = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/);
const Count = z.coerce.number().int().min(0).max(100_000);
/** A title as its sender shares it: one line, short, nothing that could be markup. */
const Title = z.string().trim().min(1).max(120).regex(/^[^<>\n\r]*$/);

export const MessagePayloadSchema = z.discriminatedUnion('k', [
  /** Join the club (an invite code, the club's name). */
  z.strictObject({ k: z.literal('invite'), c: Id, i: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), n: Title }),
  /** "<sender> is at ch. <ch> of <title>": the sender's own place, in chapters, nothing else. */
  z.strictObject({ k: z.literal('progress'), c: Id, b: Id, t: Title, ch: Count, of: Count }),
  /** A quote: its comment's id and chapter only. Its words are the server's to give, per reader. */
  z.strictObject({ k: z.literal('quote'), c: Id, b: Id, t: Title, q: Id, ch: Count }),
  /** Vote on the next book: the club and its round; the tally is fetched live. */
  z.strictObject({ k: z.literal('vote'), c: Id, r: Id }),
  /** The meet-up for a book: who is coming is fetched live. */
  z.strictObject({ k: z.literal('rsvp'), c: Id, b: Id, t: Title }),
]);
export type MessagePayload = z.infer<typeof MessagePayloadSchema>;
export type MessageKind = MessagePayload['k'];

/** The order fields are written in, so the same payload always makes the same URL. */
const FIELD_ORDER = ['k', 'c', 'b', 'r', 'q', 'i', 't', 'n', 'ch', 'of'] as const;

/** The URL a message carries: `<origin>/m#v=1&k=…&…`. */
export function encodeMessageUrl(origin: string, payload: MessagePayload): string {
  const valid = MessagePayloadSchema.parse(payload);
  const params = new URLSearchParams();
  params.set('v', String(MESSAGE_FORMAT_VERSION));
  for (const key of FIELD_ORDER) {
    const value = (valid as Record<string, unknown>)[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return `${origin.replace(/\/$/, '')}${MESSAGE_PATH}#${params.toString()}`;
}

/** A message's payload, or null for anything that is not a Book Club message this version reads. */
export function decodeMessageUrl(url: string): MessagePayload | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.pathname !== MESSAGE_PATH) return null;
  const params = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  if (params.get('v') !== String(MESSAGE_FORMAT_VERSION)) return null;
  const fields: Record<string, string> = {};
  for (const [key, value] of params) if (key !== 'v') fields[key] = value;
  const result = MessagePayloadSchema.safeParse(fields);
  return result.success ? result.data : null;
}

/**
 * Where a message opens in the app or on the web: the club's invite, the book, or the club's
 * next-book page. Only ever a path on this site.
 */
export function messageTarget(payload: MessagePayload): string {
  switch (payload.k) {
    case 'invite':
      return `/join/${encodeURIComponent(payload.i)}`;
    case 'progress':
    case 'rsvp':
      return `/books/${payload.b}`;
    case 'quote':
      return `/books/${payload.b}#note-${payload.q}`;
    case 'vote':
      return `/clubs/${payload.c}/next`;
  }
}
