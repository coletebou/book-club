import { describe, expect, it } from 'vitest';
import { type MessagePayload, decodeMessageUrl, encodeMessageUrl, messageTarget } from './imessage';
import vectors from './imessage-vectors.json';

describe('Book Club messages in iMessage (D220)', () => {
  it('encodes every kind to the URL the golden vectors say (the Swift side holds to the same ones)', () => {
    for (const v of vectors.valid) expect(encodeMessageUrl(vectors.origin, v.payload as MessagePayload)).toBe(v.url);
  });

  it('decodes them back to the same payload', () => {
    for (const v of vectors.valid) expect(decodeMessageUrl(v.url)).toEqual(v.payload);
  });

  it('reads nothing it should not: another version or path, the query instead of the fragment, a missing or extra field, markup, a path in an id', () => {
    for (const url of vectors.invalid) expect(decodeMessageUrl(url), url).toBeNull();
  });

  it('never carries a quote’s words, however it is asked to', () => {
    expect(() => encodeMessageUrl(vectors.origin, { k: 'quote', c: 'club_0001', b: 'book_00001', t: 'Red Rising', q: 'note_00042', ch: 30, text: 'The passage' } as unknown as MessagePayload)).toThrow();
  });

  it('opens only paths on this site', () => {
    const targets = vectors.valid.map((v) => messageTarget(v.payload as MessagePayload));
    expect(targets).toEqual(['/join/inviteCode123', '/books/book_00001', '/books/book_00001#note-note_00042', '/clubs/club_0001/next', '/books/book_00001']);
    for (const t of targets) expect(t.startsWith('/') && !t.startsWith('//')).toBe(true);
  });

  it('a trailing slash on the origin makes the same URL', () => {
    expect(encodeMessageUrl(`${vectors.origin}/`, vectors.valid[3]!.payload as MessagePayload)).toBe(vectors.valid[3]!.url);
  });
});
