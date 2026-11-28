import { readFile } from 'node:fs/promises';
import { type Publication } from '@bookclub/shared';
import { expect, it } from 'vitest';
import { queueIndexEdition } from '../src/cal/indexer';
import { type CalContentPart } from '../src/cal/types';
import { ALICE_EPUB, allowCal, bookDetail, closeApp, fileFrom, fileOf, makeEpub, makeTestApp, readEpubTo, setupOwner, uploadBook } from './helpers';

it('cites the chapter opening at its original place without quoting the EPUB contents page', async () => {
  const app = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true', CAL_EMBEDDING_PROVIDER: 'fake' });
  try {
    const { club, owner } = await setupOwner(app);
    await allowCal(owner);
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice' });
    await app.settle();
    const book = await bookDetail(owner, bookId);
    const chapter = book.chapters.find(({ title }) => title.includes('Down the Rabbit-Hole'));
    if (!chapter) throw new Error('The Alice fixture should have a chapter for Down the Rabbit-Hole');

    const ask = async () => {
      const thread = await owner.json<{ id: string }>(owner.post(`/api/clubs/${club.id}/cal/conversations`, { bookId }), 201);
      const response = await owner.post(`/api/cal/conversations/${thread.id}/messages`, {
        text: 'What happens at the start, when Alice was beginning to get very tired of sitting by her sister?',
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('event: done');
      const detail = await owner.json<{ messages: { role: string; content: CalContentPart[] }[] }>(owner.get(`/api/cal/conversations/${thread.id}`), 200);
      const answer = detail.messages.find(({ role }) => role === 'assistant');
      if (!answer) throw new Error('Cal should save the answer');
      return answer.content.filter((part) => part.type === 'citation');
    };

    expect(await ask()).toEqual([]);
    await readEpubTo(owner, book, 0.012);
    expect((await ask()).some(({ quote }) => quote.includes('Alice was beginning'))).toBe(false);
    await readEpubTo(owner, book, 0.03);
    const [citation] = await ask();
    expect(citation).toMatchObject({ chapterTitle: 'Chapter 1', quote: expect.stringContaining('Alice was beginning') });
    expect(citation?.quote).not.toContain('Alice’s Evidence');
    expect(citation?.t).toBeGreaterThanOrEqual(chapter.t);
    // The chapter heading can leave a leading newline at that position in the EPUB.
    expect(citation?.t).toBeLessThan(chapter.t + 0.00001);
  } finally {
    await closeApp(app);
  }
});

it.each([
  { label: 'reading order', order: [0, 1, 2, 3, 4], marked: false },
  { label: 'the final chapter listed first', order: [4, 0, 1, 2, 3], marked: true },
  { label: 'only entries for prose', order: [1, 3, 4], marked: true },
])('keeps prose and skips printed navigation with $label', async ({ order, marked }) => {
  const app = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true', CAL_EMBEDDING_PROVIDER: 'fake' });
  try {
    const { club, owner } = await setupOwner(app);
    const preface = 'The author wrote this note before the story.';
    const leadingNavigation = 'Follow the links from this first list.';
    const navigation = 'Turn to the first chapter for the opening scene.';
    const epigraph = 'The bridge is older than the road.';
    const trailingNavigation = 'Go back to the start from the final links.';
    const chapter = 'The traveller stepped across the bridge.';
    const titles = ['Contents', 'Preface', 'Contents', 'Chapter I.', 'Chapter II.'];
    const links = order.map((index) => {
      const href = index === 3 ? 's3.xhtml#chapter-one' : `s${index}.xhtml`;
      return `<li><a href="${href}">${titles[index]}</a></li>`;
    }).join('');
    const nav = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
      <head><title>Contents</title></head><body><nav epub:type="toc"><ol>${links}</ol></nav></body>
    </html>`;
    const list = `<h1>Contents</h1><p>${navigation}</p>`;
    const epub = makeEpub([
      `<nav epub:type="toc"><h1>Contents</h1><p>${leadingNavigation}</p></nav>`,
      `<section epub:type="preface"><h1>Preface</h1><p>${preface}</p></section>`,
      marked ? `<nav epub:type="toc">${list}</nav>` : list,
      `<p>${epigraph}</p><section epub:type="chapter"><h1 id="chapter-one">Chapter I.</h1><p>${chapter}</p><p>${'Rain fell on the road. '.repeat(120)}</p></section>`,
      `<section epub:type="chapter"><h1>Chapter II.</h1><p>${'The storm grew closer. '.repeat(120)}</p></section>`,
      `<nav epub:type="toc"><h1>Contents</h1><p>${trailingNavigation}</p></nav>`,
    ], { extraFiles: { 'OEBPS/nav.xhtml': nav } });
    const { editionId } = await uploadBook(owner, club.id, 'epub', [fileOf('preface.epub', epub, 'main', 'application/epub+zip')], { title: 'The Bridge' });
    await app.settle();

    const passages = app.ctx.db.all<{ text: string }>('SELECT text FROM cal_chunks WHERE edition_id = ? ORDER BY seq', [editionId]).map(({ text }) => text);
    const [opening] = passages;
    expect(opening).toContain(preface);
    expect(opening).not.toContain(chapter);
    expect(passages.some((text) => text.includes(epigraph))).toBe(true);
    expect(passages.slice(1).some((text) => text.includes(chapter))).toBe(true);
    expect(passages.some((text) => [leadingNavigation, navigation, trailingNavigation].some((listText) => text.includes(listText)))).toBe(false);
  } finally {
    await closeApp(app);
  }
});

it('replaces stale search rows when reindexing a stored EPUB without chapter annotations', async () => {
  const app = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true' });
  try {
    const { club, owner } = await setupOwner(app);
    const { editionId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice' });
    await app.settle();
    const file = app.ctx.storage.pubFile(editionId, '.publication.json');
    if (!file) throw new Error('The uploaded EPUB should have a stored publication');
    const publication = JSON.parse(await readFile(file, 'utf8')) as Publication;
    const toc = publication.toc.map(({ chapter: _chapter, chapterTitle: _chapterTitle, ...entry }) => entry);
    await app.ctx.storage.writePubFile(editionId, '.publication.json', JSON.stringify({ ...publication, toc }));
    const chunk = app.ctx.db.get<{ id: string }>('SELECT id FROM cal_chunks WHERE edition_id = ? ORDER BY seq LIMIT 1', [editionId]);
    if (!chunk) throw new Error('The uploaded EPUB should have a searchable passage');
    app.ctx.db.exec('UPDATE cal_chunks SET text = ? WHERE id = ?', ['legacyindexmarker', chunk.id]);
    const findStale = () => app.ctx.db.get("SELECT rowid FROM cal_chunks_fts WHERE cal_chunks_fts MATCH 'legacyindexmarker'");
    expect(findStale()).toBeDefined();

    queueIndexEdition(app.ctx, editionId);
    await app.settle();
    expect(findStale()).toBeUndefined();
    const opening = app.ctx.db.get<{ chapter_title: string }>(
      "SELECT chapter_title FROM cal_chunks WHERE edition_id = ? AND text LIKE '%Alice was beginning%' ORDER BY seq LIMIT 1", [editionId],
    );
    expect(opening?.chapter_title).toBe('Chapter 1');
  } finally {
    await closeApp(app);
  }
});
