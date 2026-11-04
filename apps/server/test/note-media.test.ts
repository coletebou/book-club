import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type BookDetail,
  type ClubDetail,
  type CommentView,
  CommentViewSchema,
  type Edition,
  HiddenCommentSchema,
  type Locator,
  NoteMediaViewSchema,
  RevealedCommentSchema,
  type UploadedNoteMedia,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegAvailable } from '../src/services/note-media';
import {
  ALICE_EPUB,
  ALICE_TINY_COVER,
  FIXTURES,
  type Client,
  type TestApp,
  bookDetail,
  closeApp,
  fileFrom,
  joinClub,
  makeTestApp,
  setupOwner,
  uploadBook,
  uploadNoteMedia,
} from './helpers';

const epubAt = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });
const VOICE_MP3 = path.join(FIXTURES, 'audio/synthetic/01 - The Beginning.mp3');

describe('media notes (D140-D144)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;
  let epub: Edition;
  let videoFile: string | null = null;
  let videoDir: string | null = null;

  const read = (c: Client, from: Locator, to: Locator) =>
    c.json(c.put(`/api/books/${book.id}/progress`, { editionId: epub.id, locator: from, readSpans: [{ from, to }], at: Date.now() }), 200);
  const list = async (c: Client) => (await c.json<unknown[]>(c.get(`/api/books/${book.id}/comments`), 200)).map((v) => CommentViewSchema.parse(v));

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
    epub = book.editions[0]!;
    // Reading starts at the book's very start for both: notes pinned a little further on are
    // ahead of them until each explicitly reads there (below).
    if (ffmpegAvailable()) {
      videoDir = mkdtempSync(path.join(tmpdir(), 'bookclub-video-'));
      videoFile = path.join(videoDir, 'clip.mp4');
      // A one-second, two-colour clip with a silent audio track: small, fast, real video a
      // container-sniff and ffprobe can both read, made with the same ffmpeg the server itself uses.
      execFileSync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x64:d=1',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=mono',
        '-shortest',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        videoFile,
      ]);
    }
  });

  afterAll(async () => {
    await closeApp(t);
    if (videoDir) rmSync(videoDir, { recursive: true, force: true });
  });

  it('uploads a photo, validated and resized by content, EXIF stripped by re-encoding', async () => {
    const bytes = readFileSync(ALICE_TINY_COVER);
    const res = await uploadNoteMedia(ana, book.id, 'photo', bytes, 'cover.jpg', 'image/jpeg');
    expect(res.statusCode).toBe(201);
    const media = res.json<UploadedNoteMedia>();
    expect(media).toMatchObject({ kind: 'photo', status: 'ready', mime: 'image/jpeg', error: null });
    expect(media.width).toBeGreaterThan(0);
    expect(media.height).toBeGreaterThan(0);
  });

  it('refuses a file that is not really a picture (content-sniffed, not by its declared type)', async () => {
    const res = await uploadNoteMedia(ana, book.id, 'photo', new TextEncoder().encode('not a picture'), 'fake.jpg', 'image/jpeg');
    expect(res.statusCode).toBe(201);
    const media = res.json<UploadedNoteMedia>();
    expect(media.status).toBe('failed');
    expect(media.error).toBeTruthy();
  });

  it('refuses an empty upload', async () => {
    const res = await uploadNoteMedia(ana, book.id, 'photo', new Uint8Array(0), 'empty.jpg', 'image/jpeg');
    const media = res.json<UploadedNoteMedia>();
    expect(media.status).toBe('failed');
  });

  it('uploads a voice recording; transcoded to AAC when ffmpeg is on the box, served as-is otherwise', async () => {
    const bytes = readFileSync(VOICE_MP3);
    const res = await uploadNoteMedia(ana, book.id, 'voice', bytes, 'voice.mp3', 'audio/mpeg');
    expect(res.statusCode).toBe(201);
    const media = res.json<UploadedNoteMedia>();
    expect(media.status).toBe('ready');
    expect(media.durationMs).toBeGreaterThan(0);
    if (ffmpegAvailable()) expect(media.mime).toBe('audio/mp4');
  });

  it('refuses a video with no ffmpeg or no picture, and reads one properly otherwise', async () => {
    if (!ffmpegAvailable()) {
      const res = await uploadNoteMedia(ana, book.id, 'video', readFileSync(VOICE_MP3), 'voice.mp3', 'audio/mpeg');
      expect(res.json<UploadedNoteMedia>().status).toBe('failed');
      return;
    }
    const picture = await uploadNoteMedia(ana, book.id, 'video', readFileSync(videoFile!), 'clip.mp4', 'video/mp4');
    const media = picture.json<UploadedNoteMedia>();
    expect(media.status).toBe('ready');
    expect(media.mime).toBe('video/mp4');
    expect(media.durationMs).toBeGreaterThan(0);
    expect(media.width).toBeGreaterThan(0);
    // An audio file claiming to be a video: content-sniffs as a media container, but has no picture.
    const audioAsVideo = await uploadNoteMedia(ana, book.id, 'video', readFileSync(VOICE_MP3), 'voice.mp3', 'audio/mpeg');
    expect(audioAsVideo.json<UploadedNoteMedia>().status).toBe('failed');
  });

  it('attaches media to a note; spoiler-gated exactly like its words, and its media bytes refuse a reader ahead of it', async () => {
    // Ana is ahead; Ben has not read this far.
    await read(ana, epubAt(6, 0), epubAt(6, 400));
    const upload = (await uploadNoteMedia(ana, book.id, 'photo', readFileSync(ALICE_TINY_COVER), 'cover.jpg', 'image/jpeg')).json<UploadedNoteMedia>();
    expect(upload.status).toBe('ready');
    const created = await ana.json<CommentView>(
      ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(6, 100), mediaIds: [upload.id] }),
      201,
    );
    const revealed = RevealedCommentSchema.parse(created);
    expect(revealed.hidden).toBe(false);
    expect(revealed.media).toHaveLength(1);
    const mediaView = NoteMediaViewSchema.parse(revealed.media![0]);
    expect(mediaView.url).toMatch(/^\/media\/notes\//);
    expect(mediaView.width).toBeGreaterThan(0);

    // Open the media as its author: real bytes come back.
    const ownBytes = await ana.get(mediaView.url!);
    expect(ownBytes.statusCode).toBe(200);
    expect(ownBytes.headers['cache-control']).toBe('private, no-store');
    expect(ownBytes.bytes.byteLength).toBeGreaterThan(0);

    // Ben has not read this far: the note (and its media) is a marker, kind only, no bytes.
    const bensView = (await list(ben)).find((c) => c.id === created.id)!;
    const hidden = HiddenCommentSchema.parse(bensView);
    expect(hidden.hidden).toBe(true);
    expect(hidden.media).toEqual([{ kind: 'photo' }]);
    const refused = await ben.get(mediaView.url!);
    expect(refused.statusCode).toBe(404);

    // Once Ben reads the passage, the note and its media both open for him.
    await read(ben, epubAt(6, 0), epubAt(6, 400));
    const bensViewNow = (await list(ben)).find((c) => c.id === created.id)!;
    const revealedForBen = RevealedCommentSchema.parse(bensViewNow);
    expect(revealedForBen.media).toHaveLength(1);
    const nowAllowed = await ben.get(revealedForBen.media![0]!.url!);
    expect(nowAllowed.statusCode).toBe(200);
  });

  it('a reply may be media-only, with no words at all', async () => {
    await read(ana, epubAt(7, 0), epubAt(7, 400));
    const note = await ana.json<CommentView>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(7, 50), text: 'A quiet spot' }), 201);
    await read(ben, epubAt(7, 0), epubAt(7, 400));
    const upload = (await uploadNoteMedia(ben, book.id, 'voice', readFileSync(VOICE_MP3), 'voice.mp3', 'audio/mpeg')).json<UploadedNoteMedia>();
    expect(upload.status).toBe('ready');
    const reply = await ben.json<CommentView>(ben.post(`/api/comments/${note.id}/replies`, { mediaIds: [upload.id] }), 201);
    const revealed = RevealedCommentSchema.parse(reply);
    expect(revealed.text).toBe('');
    expect(revealed.media).toHaveLength(1);
    expect(revealed.media![0]!.kind).toBe('voice');
  });

  it('a reply with neither text, reaction nor media is refused', async () => {
    await read(ana, epubAt(7, 0), epubAt(7, 400));
    const note = await ana.json<CommentView>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(7, 150), text: 'Another note' }), 201);
    const res = await ben.post(`/api/comments/${note.id}/replies`, {});
    expect(res.statusCode).toBe(400);
  });

  it('deleting a note deletes its media: the bytes go, not just the words', async () => {
    await read(ana, epubAt(8, 0), epubAt(8, 400));
    const upload = (await uploadNoteMedia(ana, book.id, 'photo', readFileSync(ALICE_TINY_COVER), 'cover.jpg', 'image/jpeg')).json<UploadedNoteMedia>();
    const created = await ana.json<CommentView>(
      ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(8, 20), mediaIds: [upload.id] }),
      201,
    );
    const revealed = RevealedCommentSchema.parse(created);
    const mediaUrl = revealed.media![0]!.url!;
    expect((await ana.get(mediaUrl)).statusCode).toBe(200);
    expect((await ana.delete(`/api/comments/${created.id}`)).statusCode).toBe(204);
    expect((await ana.get(mediaUrl)).statusCode).toBe(404);
  });

  it('cannot attach media uploaded by someone else, or already attached to another note', async () => {
    const upload = (await uploadNoteMedia(ana, book.id, 'photo', readFileSync(ALICE_TINY_COVER), 'cover.jpg', 'image/jpeg')).json<UploadedNoteMedia>();
    const stolen = await ben.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(9, 10), mediaIds: [upload.id] });
    expect(stolen.statusCode).toBe(409);
    // Ana posts with it for real, then tries to reuse the same id on a second note.
    const first = await ana.json<CommentView>(ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(9, 20), mediaIds: [upload.id] }), 201);
    expect(RevealedCommentSchema.parse(first).media).toHaveLength(1);
    const reused = await ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(9, 40), mediaIds: [upload.id] });
    expect(reused.statusCode).toBe(409);
  });

  it('discards an upload nobody will ever post', async () => {
    const upload = (await uploadNoteMedia(ana, book.id, 'photo', readFileSync(ALICE_TINY_COVER), 'cover.jpg', 'image/jpeg')).json<UploadedNoteMedia>();
    expect((await ben.delete(`/api/notes-media/${upload.id}`)).statusCode).toBe(404);
    expect((await ana.delete(`/api/notes-media/${upload.id}`)).statusCode).toBe(204);
    const reuse = await ana.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: epubAt(9, 60), mediaIds: [upload.id] });
    expect(reuse.statusCode).toBe(409);
  });
});
