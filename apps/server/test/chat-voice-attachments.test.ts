import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type BookDetail, type ChatMessageView, type ClubDetail, type ContentReports, UploadedChatAttachmentSchema } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db, loadMigrations, migrate } from '../src/db/db';
import { chatAttachmentById } from '../src/repos/chat-attachments';
import * as voice from '../src/services/chat-voice';
import { ALICE_EPUB, FIXTURES, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, outsider, postFile, readEpubTo, setupOwner, uploadBook } from './helpers';

const clip = () => readFileSync(path.join(FIXTURES, 'audio/synthetic/01 - The Beginning.mp3'));

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

  const withFile = (client: Client, bytes: Uint8Array) => postFile(client, `/api/clubs/${club.id}/chat/attachments?kind=voice`, bytes, 'recording.mp3', 'audio/mpeg');
  const upload = async (client: Client, bytes = clip()) => UploadedChatAttachmentSchema.parse(await client.json(withFile(client, bytes), 201));
  const chat = () => `/api/clubs/${club.id}/chat`;

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
    expect((await listener.request({ method: 'HEAD', url })).statusCode).toBe(404);

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
    const invalid = await upload(speaker, Buffer.from('ID3 this is no audio recording'));
    expect(invalid).toMatchObject({ kind: 'voice', status: 'failed' });
    expect((await speaker.post(chat(), { attachmentIds: [invalid.id] })).statusCode).toBe(400);
    expect((await speaker.get(`/media/chat/${invalid.id}`)).statusCode).toBe(404);
  });

  it('admits two simultaneous uploads from distinct members, then lets a refused member retry', async () => {
    const encode = voice.processChatVoice;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = vi.spyOn(voice, 'processChatVoice').mockImplementation(async (...args) => {
      await gate;
      return encode(...args);
    });
    const first = withFile(speaker, clip());
    let second: ReturnType<typeof withFile> | undefined;
    try {
      await expect.poll(() => held.mock.calls.length).toBe(1);
      expect((await withFile(speaker, clip())).statusCode).toBe(503);
      second = withFile(listener, clip());
      await expect.poll(() => held.mock.calls.length).toBe(2);
      const busy = await withFile(owner, clip());
      expect(busy.statusCode).toBe(503);
      expect(busy.headers['retry-after']).toBe('5');
    } finally {
      release();
      await Promise.allSettled(second ? [first, second] : [first]);
      held.mockRestore();
    }
    expect((await first).statusCode).toBe(201);
    expect((await second)?.statusCode).toBe(201);
    expect((await upload(owner)).status).toBe('ready');
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
    const text = 'Voice note under review';
    const message = await speaker.json<ChatMessageView>(speaker.post(chat(), { text, attachmentIds: [note.id] }), 201);
    const url = `/media/chat/${note.id}`;
    const range = { Range: 'bytes=0-15' };
    expect((await owner.get(url, range)).statusCode).toBe(206);

    const reports = `/api/clubs/${club.id}/reports`;
    expect((await listener.post(reports, { kind: 'chat', targetId: message.id, reason: 'spam' })).statusCode).toBe(204);
    const { reports: filed } = await owner.json<ContentReports>(owner.get(reports), 200);
    const report = filed.find(({ targetId }) => targetId === message.id)!;
    const { user } = await speaker.json<{ user: { id: string } }>(speaker.get('/api/session'), 200);
    expect((await owner.put(`/api/clubs/${club.id}/blocks/${user.id}`, {})).statusCode).toBe(200);
    try {
      expect(await owner.json(owner.get(`${reports}/${report.id}/target`), 200)).toMatchObject({ text, media: [] });
      expect((await owner.get(url, range)).statusCode).toBe(404);
      const reportUrl = `${url}?report=${report.id}`;
      expect((await owner.get(reportUrl, range)).statusCode).toBe(404);
      expect((await owner.request({ method: 'HEAD', url: reportUrl })).statusCode).toBe(404);
      const history = await owner.json<{ messages: ChatMessageView[] }>(owner.get(chat()), 200);
      expect(history.messages.some(({ id }) => id === message.id)).toBe(false);
    } finally {
      expect(await owner.json(owner.delete(`/api/settings/blocks/${user.id}`), 200)).toEqual([]);
    }
    expect((await owner.get(url, range)).statusCode).toBe(206);
  });
});
