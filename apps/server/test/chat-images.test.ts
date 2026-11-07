import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  type BookDetail,
  ChatHistorySchema,
  type ChatMessageView,
  type ClubDetail,
  HiddenChatMessageSchema,
  LIMITS,
  RevealedChatMessageSchema,
  UploadedChatAttachmentSchema,
} from '@bookclub/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeOrphanBlobs } from '../src/repos/blobs';
import { removeOrphanChatAttachments } from '../src/services/chat-images';
import { ALICE_EPUB, type Client, type Res, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

/** One file as multipart/form-data, built by hand (the test client has no multipart of its own). */
function upload(c: Client, clubId: string, bytes: Uint8Array, filename = 'photo.jpg', mime = 'image/jpeg'): Promise<Res> {
  const boundary = `----chat-test-${Math.random().toString(36).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const body = new Uint8Array(Buffer.concat([Buffer.from(head), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]));
  return c.request({ method: 'POST', url: `/api/clubs/${clubId}/chat/attachments`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
}

/** A camera's photo: 3000 x 2000, with EXIF in it (a copyright and a GPS position). */
const cameraPhoto = () =>
  sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#a33' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'someone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '0/1 7/1 0/1' } })
    .toBuffer();

const blobCount = (t: TestApp) => readdirSync(path.join(t.dir, 'blobs'), { recursive: true }).filter((f) => !String(f).includes(path.sep) || String(f).split(path.sep).length === 2).length;

/**
 * Pictures in chat (D203), over the real server, with real sharp: uploaded before the message,
 * made safe (no EXIF, no GPS, resized, thumbnailed), claimed when sent, served only to members
 * who may read the message they are in (its spoiler fence too), never cached, and gone with it.
 */
describe('pictures in chat (D203)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;

  const send = async (c: Client, body: Record<string, unknown>, status = 201) => c.json<ChatMessageView>(c.post(`/api/clubs/${club.id}/chat`, body), status);
  const picture = async (c: Client, bytes: Uint8Array, filename?: string, mime?: string) => UploadedChatAttachmentSchema.parse(await c.json(upload(c, club.id, bytes, filename, mime), 201));

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t, 'Cole', 'Thursday Readers'));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('strips every bit of metadata, the GPS with it, resizes, and makes a thumbnail', async () => {
    const original = await cameraPhoto();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const up = await picture(ana, original);
    expect(up).toMatchObject({ kind: 'image', status: 'ready', width: 2048, height: 1365, error: null });

    const sent = RevealedChatMessageSchema.parse(await send(ana, { attachmentIds: [up.id] }));
    expect(sent.text).toBe('');
    expect(sent.attachments).toEqual([{ id: up.id, kind: 'image', url: `/media/chat/${up.id}`, thumbUrl: `/media/chat/${up.id}/thumb`, width: 2048, height: 1365 }]);

    const full = await ben.get(sent.attachments[0]!.url);
    expect(full.statusCode).toBe(200);
    expect(full.headers['cache-control']).toBe('private, no-store');
    expect(full.headers['content-type']).toBe('image/jpeg');
    const served = await sharp(full.bytes).metadata();
    expect(served.exif).toBeUndefined();
    expect(served.xmp).toBeUndefined();
    expect([served.width, served.height]).toEqual([2048, 1365]);
    const thumb = await ben.get(sent.attachments[0]!.thumbUrl);
    const small = await sharp(thumb.bytes).metadata();
    expect(small.format).toBe('webp');
    expect(Math.max(small.width!, small.height!)).toBe(640);
    expect(small.exif).toBeUndefined();
  });

  it('keeps transparency, keeps an animated GIF animated, and never enlarges a small picture', async () => {
    const sticker = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const s = await picture(ana, sticker, 'sticker.png', 'image/png');
    expect(s).toMatchObject({ status: 'ready', width: 200, height: 100 });
    const frame = (color: string) => sharp({ create: { width: 60, height: 40, channels: 3, background: color } }).png().toBuffer();
    const gif = await sharp([await frame('#f00'), await frame('#00f')], { join: { animated: true } }).gif().toBuffer();
    const g = await picture(ana, gif, 'wave.gif', 'image/gif');
    expect(g).toMatchObject({ status: 'ready', width: 60, height: 40 });
    const sent = RevealedChatMessageSchema.parse(await send(ana, { text: 'look', attachmentIds: [s.id, g.id] }));
    expect(sent.attachments.map((a) => a.id)).toEqual([s.id, g.id]);
    const stickerServed = await sharp((await ben.get(`/media/chat/${s.id}`)).bytes).metadata();
    expect([stickerServed.format, stickerServed.hasAlpha]).toEqual(['webp', true]);
    const gifServed = await sharp((await ben.get(`/media/chat/${g.id}`)).bytes, { animated: true }).metadata();
    expect([gifServed.format, gifServed.pages]).toEqual(['webp', 2]);
  });

  it('refuses what is not a picture, or is too large, with a reason', async () => {
    const notPicture = await picture(ana, new TextEncoder().encode('%PDF-1.7 not a picture at all'), 'x.jpg');
    expect(notPicture).toMatchObject({ status: 'failed', error: 'That is not a picture we can read.' });
    const tooBig = await upload(ana, club.id, new Uint8Array(LIMITS.photoNoteBytes + 1024));
    expect(tooBig.statusCode).toBe(400);
    // A failed upload cannot be sent.
    const res = await ana.post(`/api/clubs/${club.id}/chat`, { attachmentIds: [notPicture.id] });
    expect(res.statusCode).toBe(400);
  });

  it('shows an upload not yet sent to its uploader only, and lets them take it back', async () => {
    const up = await picture(ana, await cameraPhoto());
    expect((await ana.get(`/media/chat/${up.id}/thumb`)).statusCode).toBe(200);
    expect((await ben.get(`/media/chat/${up.id}/thumb`)).statusCode).toBe(404);
    // Nobody else can send it.
    expect((await ben.post(`/api/clubs/${club.id}/chat`, { attachmentIds: [up.id] })).statusCode).toBe(400);
    expect((await ben.delete(`/api/chat/attachments/${up.id}`)).statusCode).toBe(404);
    expect((await ana.delete(`/api/chat/attachments/${up.id}`)).statusCode).toBe(204);
    expect((await ana.get(`/media/chat/${up.id}/thumb`)).statusCode).toBe(404);
  });

  it('claims a picture once, all or nothing, and never across clubs', async () => {
    const one = await picture(ana, await cameraPhoto());
    const two = await picture(ana, await cameraPhoto());
    await send(ana, { attachmentIds: [one.id] });
    // One already sent with a message: the whole send is refused, and no message is left half-made.
    const before = (await ChatHistorySchema.parseAsync(await ana.json(ana.get(`/api/clubs/${club.id}/chat`), 200))).messages.length;
    expect((await ana.post(`/api/clubs/${club.id}/chat`, { text: 'again', attachmentIds: [two.id, one.id] })).statusCode).toBe(400);
    expect((await ChatHistorySchema.parseAsync(await ana.json(ana.get(`/api/clubs/${club.id}/chat`), 200))).messages.length).toBe(before);
    expect((await ana.post(`/api/clubs/${club.id}/chat`, { attachmentIds: [two.id, two.id] })).statusCode).toBe(400);
    const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Elsewhere' }), 201);
    expect((await owner.post(`/api/clubs/${other.id}/chat`, { attachmentIds: [two.id] })).statusCode).toBe(400);
    const stranger = await outsider(t, owner, 'Oz');
    expect((await stranger.get(`/media/chat/${one.id}`)).statusCode).toBe(404);
  });

  it('hides a fenced message’s pictures with it: no address, no size, refused, until the reader gets there', async () => {
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const last = geometry.sectionLengths.length - 1;
    const end = { kind: 'epub' as const, section: last, offset: geometry.sectionLengths[last]! };
    const up = await picture(ana, await cameraPhoto());
    const fenced = RevealedChatMessageSchema.parse(await send(ana, { bookId: book.id, text: 'the trial scene', spoilerUpToT: 0.8, attachmentIds: [up.id] }));
    const hidden = HiddenChatMessageSchema.parse(
      (await ChatHistorySchema.parseAsync(await ben.json(ben.get(`/api/clubs/${club.id}/chat?channel=${book.id}`), 200))).messages.find((m) => m.id === fenced.id),
    );
    expect(hidden.attachments).toEqual([{ kind: 'image' }]);
    expect(JSON.stringify(hidden)).not.toContain(up.id);
    expect((await ben.get(`/media/chat/${up.id}`)).statusCode).toBe(404);
    expect((await ben.get(`/media/chat/${up.id}/thumb`)).statusCode).toBe(404);
    // A reply quoting it says nothing of its pictures either.
    const answer = await send(ana, { text: 'remember this?', parentId: fenced.id });
    const quoted = (await ChatHistorySchema.parseAsync(await ben.json(ben.get(`/api/clubs/${club.id}/chat?channel=${book.id}`), 200))).messages.find((m) => m.id === answer.id)!;
    expect(quoted.replyTo).toMatchObject({ hidden: true, imageCount: 0 });

    await ben.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: end, readSpans: [{ from: { kind: 'epub', section: 0, offset: 0 }, to: end }], at: Date.now() });
    expect((await ben.get(`/media/chat/${up.id}`)).statusCode).toBe(200);
    const open = (await ChatHistorySchema.parseAsync(await ben.json(ben.get(`/api/clubs/${club.id}/chat?channel=${book.id}`), 200))).messages.find((m) => m.id === answer.id)!;
    expect(open.replyTo).toMatchObject({ hidden: false, imageCount: 1 });
  });

  it('deletes a message’s pictures with it, at once, bytes and all', async () => {
    const up = await picture(ana, await sharp({ create: { width: 321, height: 123, channels: 3, background: '#123456' } }).png().toBuffer(), 'unique.png', 'image/png');
    const sent = await send(ana, { attachmentIds: [up.id] });
    const blobs = blobCount(t);
    expect((await ana.delete(`/api/chat/${sent.id}`)).statusCode).toBe(204);
    expect((await ana.get(`/media/chat/${up.id}`)).statusCode).toBe(404);
    expect(blobCount(t)).toBe(blobs - 2);
  });

  it('sweeps uploads nobody sent, and the blob sweep never takes a sent picture’s bytes', async () => {
    const kept = await picture(ana, await sharp({ create: { width: 77, height: 55, channels: 3, background: '#0a0' } }).png().toBuffer(), 'kept.png', 'image/png');
    await send(ana, { attachmentIds: [kept.id] });
    const abandoned = await picture(ana, await sharp({ create: { width: 66, height: 44, channels: 3, background: '#a0a' } }).png().toBuffer(), 'gone.png', 'image/png');
    expect(await removeOrphanChatAttachments(t.ctx, -1)).toBeGreaterThanOrEqual(1);
    expect((await ana.get(`/media/chat/${abandoned.id}/thumb`)).statusCode).toBe(404);
    await removeOrphanBlobs(t.ctx, -1);
    expect((await ben.get(`/media/chat/${kept.id}`)).statusCode).toBe(200);
    expect((await ben.get(`/media/chat/${kept.id}/thumb`)).statusCode).toBe(200);
  });
});
