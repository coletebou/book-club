import { createHash } from 'node:crypto';
import { type BookDetail, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_TINY_AUDIO, type Client, type TestApp, audioTracks, bookDetail, closeApp, joinClub, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

describe('audiobook words', () => {
  let app: TestApp;
  let owner: Client;
  let member: Client;
  let stranger: Client;
  let book: BookDetail;
  let editionId: string;

  beforeAll(async () => {
    app = await makeTestApp();
    let club: ClubDetail;
    ({ owner, club } = await setupOwner(app));
    member = await joinClub(app, club, 'Ana');
    stranger = await outsider(app, owner, 'Stu');
    const files = audioTracks(ALICE_TINY_AUDIO).slice(0, 2);
    const { bookId } = await uploadBook(owner, club.id, 'audio', files, { title: 'Alice' });
    await app.settle();
    book = await bookDetail(owner, bookId);
    const audio = book.editions[0]!;
    editionId = audio.id;
    const uploaded = await owner.put(`/api/editions/${editionId}/transcript`, {
      format: 'bookclub-transcript/1',
      engine: 'test',
      tracks: [{
        sha256: createHash('sha256').update(files[0]!.bytes).digest('hex'),
        durationMs: audio.tracks[0]!.durationMs,
        words: [[250, 490, 'White'], [500, 800, 'rabbit.'], [830, 1_030, 'Down.']],
      }],
    });
    expect(uploaded.statusCode).toBe(202);
    await app.settle();
  });

  afterAll(async () => { await closeApp(app); });

  it('serves only the source words, with durations, to an audiobook member', async () => {
    const response = await member.get(`/media/editions/${editionId}/spoken-words?track=0&window=0`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      audioEditionId: editionId,
      track: 0,
      window: 0,
      lines: [
        { text: 'White rabbit.', startMs: 250, endMs: 800, words: [[0, 5, 250, 490], [6, 7, 500, 800]] },
        { text: 'Down.', startMs: 830, endMs: 1_030, words: [[0, 5, 830, 1_030]] },
      ],
    });
    const detail = await bookDetail(member, book.id);
    expect(detail.editions[0]).toMatchObject({ readAlong: null, hasTranscript: true });
  });

  it('applies the same club access as the audio and refuses absent tracks or windows', async () => {
    const words = `/media/editions/${editionId}/spoken-words?track=0&window=0`;
    const media = `/media/editions/${editionId}/tracks/0`;
    for (const [client, code] of [[app.client(), 401], [stranger, 404]] as const) {
      expect((await client.get(media)).statusCode).toBe(code);
      const response = await client.get(words);
      expect(response.statusCode).toBe(code);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain('rabbit');
    }
    const absent = await member.get(`/media/editions/${editionId}/spoken-words?track=1&window=0`);
    expect(absent.statusCode).toBe(404);
    expect(absent.headers['cache-control']).toBe('private, no-store');
    expect((await member.get(`/media/editions/${editionId}/spoken-words?track=0&window=1`)).statusCode).toBe(404);
    expect((await member.get(`/media/editions/${editionId}/spoken-words?track=0x&window=0`)).statusCode).toBe(404);
  });
});
