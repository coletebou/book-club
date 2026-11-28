import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { type BookDetail, type ChatMessageView, type ClubDetail, type ContentReports, type UploadedNoteMedia, UploadedChatAttachmentSchema } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db, loadMigrations, migrate } from '../src/db/db';
import { chatAttachmentById } from '../src/repos/chat-attachments';
import { removeOrphanChatAttachments } from '../src/services/chat-images';
import * as voice from '../src/services/chat-voice';
import { ffmpegAvailable, setFfmpegAvailableForTests } from '../src/services/note-media';
import { ALICE_EPUB, FIXTURES, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, outsider, postFile, readEpubTo, setupOwner, uploadBook } from './helpers';

const clip = () => readFileSync(path.join(FIXTURES, 'audio/synthetic/01 - The Beginning.mp3'));

function silentWav(seconds: number): Buffer {
  const samplesPerSecond = 8000;
  const size = seconds * samplesPerSecond * 2;
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(samplesPerSecond, 24);
  wav.writeUInt32LE(samplesPerSecond * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(size, 40);
  return wav;
}

function beginVoiceRequest(client: Client, url: string, complete = false): () => Promise<void> {
  const boundary = 'voice-held-request';
  const pending = request(client.baseUrl + url, { method: 'POST', headers: {
    cookie: client.cookieHeader, origin: client.baseUrl, 'content-type': `multipart/form-data; boundary=${boundary}`,
  } });
  pending.on('error', () => {}); // The test closes these requests itself.
  const closed = new Promise<void>((resolve) => { pending.once('close', resolve); });
  pending.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`);
  if (complete) pending.end(Buffer.concat([clip(), Buffer.from(`\r\n--${boundary}--\r\n`)]));
  else pending.write(clip().subarray(0, 1024));
  return async () => { pending.destroy(); await closed; };
}

it('upgrades existing pictures with their message, order, and both blob references', () => {
  const db = new Db(':memory:');
  const migrations = loadMigrations();
  const upgrade = migrations.find((m) => m.name.endsWith('_chat_voice_attachments.sql'))!;
  try {
    migrate(db, migrations.filter((m) => m.version < upgrade.version));
    db.raw.exec(`
      INSERT INTO users (id, display_name, created_at) VALUES ('reader', 'A reader', 1);
      INSERT INTO clubs (id, name, created_by, created_at) VALUES ('club', 'A club', 'reader', 1);
      INSERT INTO chat_messages (id, club_id, user_id, text, created_at) VALUES ('message', 'club', 'reader', 'look', 2);
      INSERT INTO blobs (id, sha256, size, mime, created_at) VALUES ('full', 'first', 80, 'image/jpeg', 1), ('thumb', 'second', 40, 'image/webp', 1);
      INSERT INTO chat_attachments (id, message_id, club_id, user_id, idx, kind, status, blob_id, thumb_blob_id, mime, width, height, created_at)
        VALUES ('picture', 'message', 'club', 'reader', 2, 'image', 'ready', 'full', 'thumb', 'image/jpeg', 10, 8, 2);
    `);
    const before = db.get('SELECT * FROM chat_attachments WHERE id = ?', ['picture']);
    expect(migrate(db, [upgrade])).toEqual([upgrade.version]);
    expect(db.get('SELECT * FROM chat_attachments WHERE id = ?', ['picture'])).toEqual({ ...before, duration_ms: null });
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.all<{ name: string }>('PRAGMA index_list(chat_attachments)').map(({ name }) => name)).toEqual(expect.arrayContaining(['chat_attachments_message', 'chat_attachments_orphan']));
    db.exec('DELETE FROM chat_messages WHERE id = ?', ['message']);
    expect(db.get('SELECT * FROM chat_attachments WHERE id = ?', ['picture'])).toBeUndefined();
  } finally {
    db.close();
  }
});

describe('chat voice attachments (D276)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let speaker: Client;
  let listener: Client;
  let stranger: Client;
  let book: BookDetail;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    speaker = await joinClub(t, club, 'Ana');
    listener = await joinClub(t, club, 'Ben');
    stranger = await outsider(t, owner, 'Oz');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  const voicePath = () => `/api/clubs/${club.id}/chat/attachments?kind=voice`;
  const withFile = (client: Client, bytes: Uint8Array) => postFile(client, voicePath(), bytes, 'recording.mp3', 'audio/mpeg');
  const upload = async (client: Client, bytes = clip()) => UploadedChatAttachmentSchema.parse(await client.json(withFile(client, bytes), 201));
  const chat = () => `/api/clubs/${club.id}/chat`;
  const uploadFiles = async () => (await readdir(t.ctx.storage.tmpDir)).filter((file) => file.startsWith('upload-chat-'));
  const countUploads = async () => (await uploadFiles()).length;

  it('gates the address, HEAD, and byte ranges with the sent message and current membership', async () => {
    expect((await withFile(stranger, clip())).statusCode).toBe(404);
    const note = await upload(speaker);
    expect(note).toMatchObject({ kind: 'voice', status: 'ready', error: null });
    const url = `/media/chat/${note.id}`;
    expect((await speaker.get(url)).statusCode).toBe(200);
    expect((await listener.get(url)).statusCode).toBe(404);
    expect((await listener.post(chat(), { attachmentIds: [note.id] })).statusCode).toBe(400);

    const message = await speaker.json<ChatMessageView>(speaker.post(chat(), { bookId: book.id, spoilerUpToT: 0.6, attachmentIds: [note.id] }), 201);
    expect(message).toMatchObject({ text: '', attachments: [{ id: note.id, kind: 'voice', url, durationMs: expect.any(Number) }] });
    const history = await listener.json<{ messages: ChatMessageView[] }>(listener.get(`${chat()}?channel=${book.id}`), 200);
    const hidden = history.messages.find((m) => m.id === message.id);
    expect(hidden).toMatchObject({ hidden: true, attachments: [{ kind: 'voice' }] });
    expect(hidden?.attachments).toEqual([{ kind: 'voice' }]);
    expect(JSON.stringify(hidden)).not.toContain(note.id);
    expect((await listener.get(url, { Range: 'bytes=0-15' })).statusCode).toBe(404);
    expect((await listener.request({ method: 'HEAD', url, headers: { Range: 'bytes=0-15' } })).statusCode).toBe(404);

    await readEpubTo(listener, book, 0.7);
    const audio = await listener.get(url);
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['cache-control']).toBe('private, no-store');
    expect(audio.headers['content-type']).toBe('audio/mp4');
    expect(Buffer.from(audio.bytes.subarray(4, 8)).toString()).toBe('ftyp');
    const first = await listener.get(url, { Range: 'bytes=0-15' });
    expect(first.statusCode).toBe(206);
    expect(first.headers['content-range']).toBe(`bytes 0-15/${audio.bytes.length}`);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.bytes).toEqual(audio.bytes.subarray(0, 16));
    expect((await listener.request({ method: 'HEAD', url })).statusCode).toBe(200);
    expect((await listener.get(`${url}/thumb`)).statusCode).toBe(404);
    expect((await stranger.get(url)).statusCode).toBe(404);
    expect((await speaker.delete(`/api/chat/${message.id}`)).statusCode).toBe(204);
    expect((await listener.get(url, { Range: 'bytes=0-15' })).statusCode).toBe(404);
  });

  it('rejects a file with a plausible audio signature that the encoder cannot read', async () => {
    expect(ffmpegAvailable(), 'Install FFmpeg to verify the malformed input reaches the actual encoder.').toBe(true);
    const invalid = await upload(speaker, Buffer.from('ID3 this is no audio recording'));
    expect(invalid).toMatchObject({ kind: 'voice', status: 'failed', error: 'That recording could not be read.' });
    expect((await speaker.post(chat(), { attachmentIds: [invalid.id] })).statusCode).toBe(400);
    expect((await speaker.get(`/media/chat/${invalid.id}`)).statusCode).toBe(404);
  });

  it('reports unavailable FFmpeg separately when a valid recording reaches the upload route', async () => {
    setFfmpegAvailableForTests(false);
    try {
      const result = await upload(speaker);
      expect(result).toMatchObject({ kind: 'voice', status: 'failed', error: 'This server cannot prepare voice messages right now.' });
      expect((await speaker.get(`/media/chat/${result.id}`)).statusCode).toBe(404);
    } finally {
      setFfmpegAvailableForTests(null);
    }
  });

  it('rejects a truncated oversize upload before encoding', async () => {
    const encode = vi.spyOn(voice, 'processChatVoice');
    try {
      const tooBig = await withFile(speaker, Buffer.alloc(30 * 1024 ** 2 + 1));
      expect(tooBig.statusCode).toBe(400);
      expect(tooBig.json()).toMatchObject({ error: { message: 'That recording is larger than 30 MB.' } });
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it('refuses an empty file and a valid recording beyond the duration limit', async () => {
    const empty = await upload(speaker, Buffer.alloc(0));
    expect(empty).toMatchObject({ kind: 'voice', status: 'failed', error: 'That file is empty.' });
    const atLimit = await speaker.json(postFile(speaker, voicePath(), silentWav(300), 'five-minutes.wav', 'audio/wav'), 201);
    expect(atLimit).toMatchObject({ kind: 'voice', status: 'ready' });
    const tooLong = await speaker.json(postFile(speaker, voicePath(), silentWav(305), 'long.wav', 'audio/wav'), 201);
    const failed = UploadedChatAttachmentSchema.parse(tooLong);
    expect(failed).toMatchObject({ kind: 'voice', status: 'failed', error: 'That recording is too long.' });
    expect((await speaker.get(`/media/chat/${failed.id}`)).statusCode).toBe(404);
  });

  it('lets a different club encode while two members are still uploading their bodies', async () => {
    const { id } = (await stranger.json<ClubDetail[]>(stranger.get('/api/clubs'), 200))[0]!;
    await expect.poll(countUploads).toBe(0);
    const stopFirst = beginVoiceRequest(speaker, voicePath());
    const stopSecond = beginVoiceRequest(listener, voicePath());
    try {
      await expect.poll(countUploads).toBe(2);
      const fast = await postFile(stranger, `/api/clubs/${id}/chat/attachments?kind=voice`, clip(), 'recording.mp3', 'audio/mpeg');
      expect(fast.statusCode).toBe(201);
      expect(fast.json()).toMatchObject({ status: 'ready' });
    } finally {
      await Promise.all([stopFirst(), stopSecond()]);
      await expect.poll(countUploads).toBe(0);
    }
  });

  it('runs two encoders, queues four completed uploads and lets a refused member retry', async () => {
    const others = [owner, ...await Promise.all(['Cy', 'Di', 'Eli', 'Flo'].map((name) => joinClub(t, club, name)))];
    const encode = voice.processChatVoice;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const held = vi.spyOn(voice, 'processChatVoice').mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await gate;
        return await encode(...args);
      } finally {
        active--;
      }
    });
    const first = withFile(speaker, clip());
    const second = withFile(listener, clip());
    const waiting: ReturnType<typeof withFile>[] = [];
    let refused: Client | undefined;
    try {
      await expect.poll(() => held.mock.calls.length).toBe(2);
      expect((await withFile(speaker, clip())).statusCode).toBe(409);
      waiting.push(...others.map((member) => withFile(member, clip())));
      const { member, busy } = await Promise.race(waiting.map(async (result, index) => ({ member: others[index]!, busy: await result })));
      refused = member;
      expect(busy.statusCode).toBe(503);
      expect(busy.headers['retry-after']).toBe('195');
      expect(held).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.allSettled([first, second, ...waiting]);
      held.mockRestore();
    }
    const codes = (await Promise.all([first, second, ...waiting])).map(({ statusCode }) => statusCode);
    expect(codes.sort()).toEqual([201, 201, 201, 201, 201, 201, 503]);
    expect(peak).toBe(2);
    expect((await upload(refused!)).status).toBe('ready');
  });

  it('admits complete bodies in order across clubs and cleans up cancelled or revoked waiters', async () => {
    await expect.poll(countUploads).toBe(0);
    const { id: otherClub } = (await stranger.json<ClubDetail[]>(stranger.get('/api/clubs'), 200))[0]!;
    const queueClub = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Queued Readers' }), 201);
    const eligible = await joinClub(t, queueClub, 'Eligible Reader');
    const revoked = await joinClub(t, queueClub, 'Queued Reader');
    const { user } = await revoked.json<{ user: { id: string } }>(revoked.get('/api/session'), 200);
    const queuedFile = (client: Client) => postFile(client, `/api/clubs/${queueClub.id}/chat/attachments?kind=voice`, clip(), 'recording.mp3', 'audio/mpeg');
    const clipSize = clip().length;
    const completed = async () => {
      const files = await Promise.all((await uploadFiles()).map((file) => stat(path.join(t.ctx.storage.tmpDir, file)).catch(() => null)));
      return files.filter((file) => file?.size === clipSize).length;
    };
    const encode = voice.processChatVoice;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstSlot = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondSlot = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const heldSlots = [firstSlot, secondSlot];
    const entered: string[] = [];
    const held = vi.spyOn(voice, 'processChatVoice').mockImplementation(async (...args) => {
      const slot = heldSlots[entered.length];
      entered.push(args[1].club_id);
      await slot;
      return encode(...args);
    });
    const first = withFile(speaker, clip());
    const second = withFile(listener, clip());
    const waiting: ReturnType<typeof withFile>[] = [];
    let stop: (() => Promise<void>) | undefined;
    try {
      await expect.poll(() => held.mock.calls.length).toBe(2);
      const cross = postFile(stranger, `/api/clubs/${otherClub}/chat/attachments?kind=voice`, clip(), 'recording.mp3', 'audio/mpeg');
      waiting.push(cross);
      await expect.poll(completed).toBe(3);
      const eligibleUpload = queuedFile(eligible);
      waiting.push(eligibleUpload);
      await expect.poll(completed).toBe(4);
      const revokedUpload = queuedFile(revoked);
      waiting.push(revokedUpload);
      await expect.poll(completed).toBe(5);
      stop = beginVoiceRequest(owner, voicePath(), true);
      await expect.poll(completed).toBe(6);
      await stop();
      await expect.poll(countUploads).toBe(5);
      expect(held).toHaveBeenCalledTimes(2);
      expect((await owner.delete(`/api/clubs/${queueClub.id}/members/${user.id}`)).statusCode).toBe(204);
      releaseFirst();
      expect((await cross).statusCode).toBe(201);
      expect((await eligibleUpload).statusCode).toBe(201);
      expect((await revokedUpload).statusCode).toBe(404);
      expect(entered).toEqual([club.id, club.id, otherClub, queueClub.id]);
    } finally {
      await stop?.();
      releaseFirst();
      releaseSecond();
      await Promise.allSettled([first, second, ...waiting]);
      held.mockRestore();
    }
    expect((await upload(owner)).status).toBe('ready');
  });

  it('signals an active encoder when its upload disconnects and lets the member retry', async () => {
    await expect.poll(countUploads).toBe(0);
    const held = vi.spyOn(voice, 'processChatVoice').mockImplementationOnce(async (_ctx, _row, _file, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
      throw new Error('Expected the disconnected upload to be aborted');
    });
    const stop = beginVoiceRequest(speaker, voicePath(), true);
    try {
      await expect.poll(() => held.mock.calls.length).toBe(1);
      await stop();
      await expect.poll(countUploads).toBe(0);
      expect(held.mock.calls[0]![3].aborted).toBe(true);
    } finally {
      await stop();
      held.mockRestore();
    }
    expect((await upload(speaker)).status).toBe('ready');
  });

  it('claims shared bytes before an identical upload yields to duplicate file cleanup', async () => {
    const sameBytes = readFileSync(path.join(FIXTURES, 'audio/synthetic/02 - The Middle.mp3'));
    const first = await upload(speaker, sameBytes);
    const old = chatAttachmentById(t.ctx.db, first.id)!;
    const storage = t.ctx.storage;
    const removeBlob = storage.removeBlob.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = vi.spyOn(storage, 'removeBlob').mockImplementation(async (id) => {
      if (id !== old.blob_id) {
        await gate;
      }
      await removeBlob(id);
    });
    const pending = upload(listener, sameBytes);
    try {
      // Wait for the duplicate check, with a failing assertion if the encodes did not deduplicate.
      await expect.poll(() => held.mock.calls.length).toBe(1);
      expect(held.mock.calls[0]![0]).not.toBe(old.blob_id);
      expect((await speaker.delete(`/api/chat/attachments/${first.id}`)).statusCode).toBe(204);
    } finally {
      release();
      await Promise.allSettled([pending]);
      held.mockRestore();
    }
    const next = await pending;
    expect((await listener.get(`/media/chat/${next.id}`)).statusCode).toBe(200);
  });

  it('keeps a voice note’s bytes when the shared chat recording is discarded during upload', async () => {
    const chatRecording = await upload(speaker, readFileSync(path.join(FIXTURES, 'audio/synthetic/03 - The End.mp3')));
    const chatUrl = `/media/chat/${chatRecording.id}`;
    const source = await speaker.get(chatUrl);
    expect(source.statusCode).toBe(200);
    const sharedId = chatAttachmentById(t.ctx.db, chatRecording.id)!.blob_id;
    const storage = t.ctx.storage;
    const removeBlob = storage.removeBlob.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = vi.spyOn(storage, 'removeBlob').mockImplementation(async (id) => {
      if (id !== sharedId) await gate;
      await removeBlob(id);
    });
    const pending = postFile(listener, `/api/books/${book.id}/media?kind=voice`, source.bytes, 'note.m4a', 'audio/mp4');
    try {
      await expect.poll(() => held.mock.calls.length).toBe(1);
      expect(held.mock.calls[0]![0]).not.toBe(sharedId);
      expect((await speaker.delete(`/api/chat/attachments/${chatRecording.id}`)).statusCode).toBe(204);
    } finally {
      release();
      await Promise.allSettled([pending]);
      held.mockRestore();
    }
    const note = await listener.json<UploadedNoteMedia>(pending, 201);
    expect(note.status).toBe('ready');
    const audio = await listener.get(`/media/notes/${note.id}/file`);
    expect(audio.statusCode).toBe(200);
    expect(Buffer.from(audio.bytes.subarray(4, 8)).toString()).toBe('ftyp');
    expect((await speaker.get(chatUrl)).statusCode).toBe(404);
    expect((await listener.delete(`/api/notes-media/${note.id}`)).statusCode).toBe(204);
  });

  it('keeps a recording sent while an earlier orphan’s bytes are being deleted', async () => {
    const abandoned = await upload(speaker, readFileSync(path.join(FIXTURES, 'audio/synthetic/03 - The End.mp3')));
    const ready = await upload(listener);
    t.ctx.db.exec('UPDATE chat_attachments SET created_at = 1 WHERE id = ?', [abandoned.id]);
    t.ctx.db.exec('UPDATE chat_attachments SET created_at = 2 WHERE id = ?', [ready.id]);
    const abandonedBlob = chatAttachmentById(t.ctx.db, abandoned.id)!.blob_id;
    const removeBlob = t.ctx.storage.removeBlob.bind(t.ctx.storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = vi.spyOn(t.ctx.storage, 'removeBlob').mockImplementation(async (id) => {
      if (id === abandonedBlob) await gate;
      await removeBlob(id);
    });
    const sweep = removeOrphanChatAttachments(t.ctx);
    try {
      await expect.poll(() => held.mock.calls.some(([id]) => id === abandonedBlob)).toBe(true);
      await listener.json(listener.post(chat(), { attachmentIds: [ready.id] }), 201);
    } finally {
      release();
      await Promise.allSettled([sweep]);
      held.mockRestore();
    }
    await expect(sweep).resolves.toBe(1);
    expect((await speaker.get(`/media/chat/${ready.id}`)).statusCode).toBe(200);
  });

  it('rejects extra multipart parts before encoding the recording', async () => {
    const boundary = 'voice-attachment-form';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      clip(),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nextra\r\n--${boundary}--\r\n`),
    ]);
    const process = vi.spyOn(voice, 'processChatVoice');
    try {
      const result = await speaker.post(`/api/clubs/${club.id}/chat/attachments?kind=voice`, body, {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      });
      expect(result.statusCode).toBe(400);
      expect(process).not.toHaveBeenCalled();
    } finally {
      process.mockRestore();
    }
  });

  it('revokes access even for the original uploader once they leave the club', async () => {
    const person = await joinClub(t, club, 'Lee');
    const pending = await upload(person);
    const posted = await upload(person);
    await person.json(person.post(chat(), { attachmentIds: [posted.id] }), 201);
    const who = await person.json<{ user: { id: string } }>(person.get('/api/session'), 200);
    expect((await owner.delete(`/api/clubs/${club.id}/members/${who.user.id}`)).statusCode).toBe(204);
    for (const id of [pending.id, posted.id]) {
      expect((await person.get(`/media/chat/${id}`)).statusCode).toBe(404);
    }
  });

  it('refuses voice playback after a block even when the owner has a report to review', async () => {
    const note = await upload(speaker);
    const message = await speaker.json<ChatMessageView>(speaker.post(chat(), { bookId: book.id, spoilerUpToT: 0.8, attachmentIds: [note.id] }), 201);
    const url = `/media/chat/${note.id}`;
    const range = { Range: 'bytes=0-15' };
    await readEpubTo(listener, book, 0.95);
    const reports = `/api/clubs/${club.id}/reports`;
    expect((await listener.post(reports, { kind: 'chat', targetId: message.id, reason: 'spam' })).statusCode).toBe(204);
    const { reports: filed } = await owner.json<ContentReports>(owner.get(reports), 200);
    const report = filed.find(({ targetId }) => targetId === message.id)!;
    const target = `${reports}/${report.id}/target`;
    expect((await listener.get(target)).statusCode).toBe(403);
    expect((await owner.get(target)).statusCode).toBe(404);
    await readEpubTo(owner, book, 0.95);
    expect((await owner.get(url, range)).statusCode).toBe(206);
    const { user } = await speaker.json<{ user: { id: string } }>(speaker.get('/api/session'), 200);
    expect((await owner.put(`/api/clubs/${club.id}/blocks/${user.id}`, {})).statusCode).toBe(200);
    try {
      expect(await owner.json(owner.get(target), 200)).toEqual({ text: '', reaction: null, media: [], hasVoiceMessage: true });
      expect((await owner.get(url, range)).statusCode).toBe(404);
      const reportUrl = `${url}?report=${report.id}`;
      expect((await owner.get(reportUrl, range)).statusCode).toBe(404);
      expect((await owner.request({ method: 'HEAD', url: reportUrl })).statusCode).toBe(404);
      const history = await owner.json<{ messages: ChatMessageView[] }>(owner.get(`${chat()}?channel=${book.id}`), 200);
      expect(history.messages.some(({ id }) => id === message.id)).toBe(false);
    } finally {
      expect(await owner.json(owner.delete(`/api/settings/blocks/${user.id}`), 200)).toEqual([]);
    }
    expect((await owner.get(url, range)).statusCode).toBe(206);
  });
});
