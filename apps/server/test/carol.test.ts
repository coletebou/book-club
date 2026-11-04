import path from 'node:path';
import {
  type BookDetail,
  type ClubDetail,
  type CommentView,
  CommentViewSchema,
  type Edition,
  type EpubLocator,
  type Locator,
  ProgressUpdateResultSchema,
  type Publication,
  PublicationSchema,
  mToT,
  tToM,
} from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mp3With, textFrame } from './crafted-audio';
import { type Client, FIXTURES, SYNTHETIC_AUDIO, type TestApp, bookDetail, fileFrom, fileOf, joinClub, makeTestApp, setupOwner, uploadBook } from './helpers';

/*
 * A club's first evening, as fidelity review round 13 made it from the app's own screens: Gutenberg's
 * illustrated A Christmas Carol (#46), and LibriVox's recording of it, whose tracks its ID3v1 tags
 * name with 30 characters at most (D77).
 */
const CAROL_EPUB = path.join(FIXTURES, 'books/carol-gutenberg-46.epub');
const TRACK_TAGS = ["01 - Stave 1: Marley's Ghost", '02 - Stave 2: The First of the', '03 - Stave 3: The Second of th', '04 - Stave 4: The Last of the', '05 - Stave 5: The End of It'];
const STAVES = ['STAVE ONE. MARLEY’S GHOST.', 'STAVE TWO. THE FIRST OF THE THREE SPIRITS.', 'STAVE THREE. THE SECOND OF THE THREE SPIRITS.', 'STAVE FOUR. THE LAST OF THE SPIRITS.', 'STAVE FIVE. THE END OF IT.'];

const tracks = () =>
  TRACK_TAGS.map((title, i) =>
    fileOf(
      `christmascarol_${i + 1}_dickens_64kb.mp3`,
      mp3With([textFrame('TIT2', title), textFrame('TPE1', 'Charles Dickens'), textFrame('TALB', 'A Christmas Carol (version 7)'), textFrame('TRCK', String(i + 1))], path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3')),
      'track',
      'audio/mpeg',
    ),
  );

describe('A Christmas Carol and its LibriVox recording, as a club brings them (D77)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let book: BookDetail;
  let epub: Edition;
  let audio: Edition;
  let pub: Publication;

  const refresh = async () => {
    book = await bookDetail(owner, book.id);
    epub = book.editions.find((e) => e.kind === 'epub')!;
    audio = book.editions.find((e) => e.kind === 'audio')!;
  };
  /** Where an entry of the contents starts, as a place in the EPUB. */
  const entryAt = (title: string, past = 0): EpubLocator => {
    const e = pub.toc.find((x) => x.title === title)!;
    return { kind: 'epub', section: e.section, offset: e.offset + past };
  };
  const report = async (c: Client, edition: Edition, from: Locator, to: Locator) =>
    ProgressUpdateResultSchema.parse(await c.json(c.put(`/api/books/${book.id}/progress`, { editionId: edition.id, locator: to, readSpans: [{ from, to }], at: Date.now() }), 200));
  const viewOf = async (c: Client, id: string) => (await c.json<CommentView[]>(c.get(`/api/books/${book.id}/comments`), 200)).find((v) => v.id === id)!;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(CAROL_EPUB, 'main', 'application/epub+zip')], { title: 'A Christmas Carol', author: 'Charles Dickens' });
    await t.settle();
    await uploadBook(owner, club.id, 'audio', tracks(), { title: 'A Christmas Carol', author: 'Charles Dickens', bookId });
    await t.settle();
    book = await bookDetail(owner, bookId);
    await refresh();
    pub = PublicationSchema.parse(await owner.json(owner.get(epub.publicationUrl!), 200));
  });
  afterAll(async () => t?.close());

  it('has five staves for chapters, each under its heading and subtitle, after its front matter', () => {
    expect(book.chapters.map((c) => c.title).slice(-5)).toEqual(STAVES);
    // Before them: the edition's note, the title page's lines, the contents and the pictures' list.
    expect(book.chapters).toHaveLength(12);
    for (const name of ['MARLEY’S GHOST.', 'Marley’s Ghost', 'Scrooge’s Third Visitor', 'THE END OF IT.', 'PREFACE']) expect(book.chapters.map((c) => c.title)).not.toContain(name);
    // Its contents still list everything, for the reader to go to; which entries start chapters, they say.
    expect(pub.toc.find((e) => e.title === 'Marley’s Ghost')).toMatchObject({ chapter: false });
    expect(pub.toc.find((e) => e.title === 'MARLEY’S GHOST.')).toMatchObject({ chapter: false });
    expect(pub.toc.find((e) => e.title === 'STAVE ONE.')).toMatchObject({ chapterTitle: 'STAVE ONE. MARLEY’S GHOST.' });
    expect(pub.toc.find((e) => e.title === 'STAVE ONE.')!.chapter).toBeUndefined();
  });

  it('matches the five tracks to the five staves by their numbers, cut titles and all, and ends the last with the story', () => {
    expect(audio.alignment).toEqual({ method: 'number', unitToChapter: [7, 8, 9, 10, 11] });
    expect(audio.tracks.map((tr) => tr.chapter)).toEqual([7, 8, 9, 10, 11]);
    const starts = audio.tracks.map((_, k) => audio.tracks.slice(0, k).reduce((s, tr) => s + tr.durationMs, 0));
    starts.forEach((ms, k) => expect(mToT(audio.sync!, ms)).toBeCloseTo(book.chapters[7 + k]!.t, 9));
    // The last track is heard over all of Stave Five: before, it passed between the stave's
    // heading and its subtitle, 16 characters (0.0001 of the book).
    expect(mToT(audio.sync!, audio.durationMs!)).toBe(1);
    expect(mToT(audio.sync!, starts[4]! + audio.tracks[4]!.durationMs / 2) - book.chapters[11]!.t).toBeGreaterThan(0.03);
  });

  it('keeps a note made near the end of the last track from a friend on the first page of Stave Five, and opens it at the end', async () => {
    const ben = await joinClub(t, club, 'Ben');
    const iris = await joinClub(t, club, 'Iris');
    const lastTrack = audio.tracks[4]!;
    const ending = CommentViewSchema.parse(
      await ben.json(ben.post(`/api/books/${book.id}/comments`, { editionId: audio.id, locator: { kind: 'audio', track: 4, ms: lastTrack.durationMs - 400 }, text: 'Tiny Tim, who did NOT die!' }), 201),
    );
    // Iris has read from the start to the first page of Stave Five.
    await report(iris, epub, entryAt(pub.toc[0]!.title), entryAt('STAVE FIVE.', 1500));
    expect((await viewOf(iris, ending.id)).hidden).toBe(true);
    // Read to the end of the story (the end of Stave Five's section): there.
    const five = entryAt('STAVE FIVE.');
    const opened = await report(iris, epub, entryAt('STAVE FIVE.', 1500), { kind: 'epub', section: five.section, offset: pub.sections[five.section]!.textLength });
    expect(opened.revealed.map((r) => r.id)).toContain(ending.id);
  });

  it('takes the same match by hand, and refuses one that would cram a track into the next stave', async () => {
    const same = await owner.json<Edition>(owner.put(`/api/editions/${audio.id}/alignment`, { unitToChapter: [7, 8, 9, 10, 11] }), 200);
    expect(same.sync).toEqual(audio.sync);
    // Track 4 for Stave Five: tracks 4 and 5 would both be heard there.
    const crammed = await owner.put(`/api/editions/${audio.id}/alignment`, { unitToChapter: [7, 8, 9, 11, null] });
    expect(crammed.statusCode).toBe(400);
    expect(crammed.json<{ error: { message: string } }>().error.message).toBe('With these chapters, “04 - Stave 4: The Last of the” would be heard over far too little of the book. Check the chapter each part starts.');
    await refresh();
    expect(audio.alignment.method).toBe('manual');
    expect(tToM(audio.sync!, book.chapters[11]!.t)).toBeCloseTo(audio.tracks.slice(0, 4).reduce((s, tr) => s + tr.durationMs, 0), 6);
  });
});
