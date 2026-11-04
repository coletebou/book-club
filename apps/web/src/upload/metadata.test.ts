import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { MAX_COVER_BYTES } from '@bookclub/shared';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { classify, clubAuthor, clubTitle, draftFromFiles, guessFromName, orderTracks, pickFolderCover, tidyTag, tidyTitle, titleCase } from './metadata';

const FIXTURES = path.resolve(import.meta.dirname, '../../../../fixtures');
const bytesOf = (rel: string) => new Uint8Array(readFileSync(path.join(FIXTURES, rel)));

const TYPES: Record<string, string> = { epub: 'application/epub+zip', pdf: 'application/pdf', mp3: 'audio/mpeg', jpg: 'image/jpeg', txt: 'text/plain' };
const typeOf = (name: string) => TYPES[name.split('.').pop()!.toLowerCase()] ?? '';

/** A File as the browser hands it over: real bytes, and the folder it came from, if one was picked. */
function file(name: string, bytes: Uint8Array, folder?: string): File {
  const f = new File([bytes as BlobPart], name, { type: typeOf(name) });
  if (folder) Object.defineProperty(f, 'webkitRelativePath', { value: `${folder}/${name}` });
  return f;
}
const fixture = (rel: string, folder?: string) => file(path.basename(rel), bytesOf(rel), folder);
const folder = (dir: string, as = path.basename(dir)) => readdirSync(path.join(FIXTURES, dir)).map((name) => fixture(path.join(dir, name), as));
const empty = (name: string, size = 0) => file(name, new Uint8Array(size));

/** An MP3 of the fixtures with its ID3 tag cut off: real audio, no title, artist, album or picture. */
function untaggedMp3(): Uint8Array {
  const bytes = bytesOf('audio/synthetic/02 - The Middle.mp3');
  expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('ID3');
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  return bytes.slice(10 + size);
}

const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe('classify', () => {
  it.each([
    [['Alice.epub'], 'epub'],
    [['alice.PDF'], 'pdf'],
    [['01.mp3', '02.MP3', 'cover.jpg', 'notes.txt'], 'audio'],
    [['book.m4b'], 'audio'],
    [['a.m4a', 'b.ogg', 'c.opus', 'd.flac', 'e.wav', 'f.aac', 'g.webm', 'h.mp4', 'i.oga'], 'audio'],
  ])('%j is %s', (names, kind) => {
    expect(classify(names.map((n) => empty(n)))).toEqual({ kind, error: null });
  });

  it('is undecided, without complaint, when nothing is chosen', () => {
    expect(classify([])).toEqual({ kind: null, error: null });
  });

  it.each([
    [['a.epub', 'b.epub'], 'Choose one book at a time: one EPUB, one PDF, or one folder of audio tracks.'],
    [['a.epub', 'a.pdf'], 'Choose one book at a time: one EPUB, one PDF, or one folder of audio tracks.'],
    [['a.epub', '01.mp3'], 'Audio tracks and an ebook are separate formats. Add them one at a time.'],
    [['notes.txt'], 'Choose an EPUB, a PDF, or audiobook tracks (MP3, M4A, M4B…).'],
    [['cover.jpg', 'notes.docx'], 'Choose an EPUB, a PDF, or audiobook tracks (MP3, M4A, M4B…).'],
  ])('explains what is wrong with %j', (names, error) => {
    expect(classify(names.map((n) => empty(n)))).toEqual({ kind: null, error });
  });
});

describe('pickFolderCover', () => {
  it('prefers an image named cover, folder or front over a bigger one', () => {
    for (const name of ['cover.jpg', 'Cover.JPG', 'folder.png', 'front.webp', 'Album Cover.jpg', 'my_cover_art.gif', 'Front-Cover.jpeg']) {
      expect(pickFolderCover([empty('back.jpg', 9_000), empty(name, 10), empty('01.mp3', 50_000)])?.name, name).toBe(name);
    }
  });

  it('does not take a word that merely contains "cover" for a cover', () => {
    expect(pickFolderCover([empty('discover.jpg', 10), empty('art.jpg', 900)])?.name).toBe('art.jpg');
  });

  it('leaves out an image too big to be a cover (it would have the upload refused), even one named cover', () => {
    const tooBig = MAX_COVER_BYTES + 1;
    expect(pickFolderCover([empty('cover.jpg', tooBig), empty('art.jpg', 900)])?.name).toBe('art.jpg');
    expect(pickFolderCover([empty('scan.png', tooBig)])).toBeNull();
  });

  it('otherwise takes the largest image', () => {
    expect(pickFolderCover([empty('a.jpg', 10), empty('b.png', 900), empty('c.gif', 90), empty('big.mp3', 90_000)])?.name).toBe('b.png');
  });

  it('is null without images', () => {
    expect(pickFolderCover([empty('01.mp3'), empty('readme.txt')])).toBeNull();
  });
});

describe('orderTracks', () => {
  it('orders tracks naturally by file name ("2" before "10"), whatever order they came in', () => {
    const names = ['Track 10.mp3', 'track 2.mp3', 'cover.jpg', 'Track 1.mp3', 'notes.txt', 'Track 11.MP3'];
    expect(orderTracks(names.map((n) => empty(n))).map((f) => f.name)).toEqual(['Track 1.mp3', 'track 2.mp3', 'Track 10.mp3', 'Track 11.MP3']);
  });
});

describe('guessFromName', () => {
  it.each([
    ['Alice in Wonderland - Lewis Carroll', { title: 'Alice in Wonderland', author: 'Lewis Carroll' }],
    ['Moby Dick – Herman Melville.pdf', { title: 'Moby Dick', author: 'Herman Melville' }],
    ['War and Peace — Leo Tolstoy', { title: 'War and Peace', author: 'Leo Tolstoy' }],
    ['Alice_in_Wonderland', { title: 'Alice in Wonderland', author: '' }],
    ['Title - Author - Narrator', { title: 'Title', author: 'Author - Narrator' }],
    ['Self-Reliance.epub', { title: 'Self-Reliance', author: '' }],
  ])('%j → %j', (name, expected) => {
    expect(guessFromName(name)).toEqual(expected);
  });
});

describe('draftFromFiles', () => {
  it('reads title, author and cover from a real EPUB', async () => {
    const epub = fixture('books/alice-gutenberg-11.epub');
    const draft = await draftFromFiles([epub]);
    expect(draft).toMatchObject({ kind: 'epub', main: epub, tracks: [], coverName: null, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', warnings: [] });
    expect(draft.cover?.type).toBe('image/jpeg');
    expect(draft.cover?.size).toBe(104_775);
    // A JPEG: starts with the SOI marker.
    expect([...(await blobBytes(draft.cover!)).subarray(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it('fills in the title a club calls the book, not Gutenberg’s whole title page (fidelity review round 16)', async () => {
    const draft = await draftFromFiles([fixture('books/carol-gutenberg-46.epub')]);
    expect(draft).toMatchObject({ kind: 'epub', title: 'A Christmas Carol', author: 'Charles Dickens' });
  });

  it('reads an audiobook folder from its tags: title, author, cover and every track in file-name order', async () => {
    const files = folder('audio/synthetic').reverse();
    const draft = await draftFromFiles(files);
    expect(draft.kind).toBe('audio');
    expect(draft.main).toBeNull();
    expect(draft.title).toBe('The Synthetic Tale');
    expect(draft.author).toBe('Ada Tone');
    expect(draft.tracks.map((t) => [t.file.name, t.title, t.trackNo])).toEqual([
      ['01 - The Beginning.mp3', 'The Beginning', 1],
      ['02 - The Middle.mp3', 'The Middle', 2],
      ['03 - The End.mp3', 'The End', 3],
    ]);
    // The picture embedded in the first track.
    expect(draft.cover?.type).toBe('image/jpeg');
    expect([...(await blobBytes(draft.cover!)).subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(draft.coverName).toBe('cover.jpg');
    expect(draft.warnings).toEqual([]);
  });

  it('takes the cover image from the folder when the tracks carry none (LibriVox)', async () => {
    const files = folder('audio/alice-tiny');
    const draft = await draftFromFiles(files);
    expect(draft).toMatchObject({ kind: 'audio', title: 'Alice in Wonderland', author: 'Lewis Carroll', coverName: 'Alice_in_Wonderland.jpg', warnings: [] });
    expect(draft.cover).toBe(files.find((f) => f.name === 'Alice_in_Wonderland.jpg'));
    expect(draft.tracks.map((t) => t.title)).toEqual(Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}`));
    expect(draft.tracks.map((t) => t.trackNo)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // The README beside the tracks is not a track.
    expect(draft.tracks.every((t) => t.file.name.endsWith('.mp3'))).toBe(true);
  });

  describe('LibriVox tracks whose ID3v2 tags are unsynchronised (A Christmas Carol, version 7)', () => {
    const TITLES = ["01 - Stave 1: Marley's Ghost", '02 - Stave 2: The First of the Three Spirits', '03 - Stave 3: The Second of the Three Spirits', '04 - Stave 4: The Last of the Spirits', '05 - Stave 5: The End of It'];

    it('are read by music-metadata only as far as their ID3v1 tags: titles cut to 30 characters, no picture (the check that this can fail)', async () => {
      const { parseBlob } = await import('music-metadata');
      const meta = await parseBlob(fixture('audio/carol-tiny/christmascarol_2_dickens_64kb.mp3'), { duration: false });
      expect(meta.common).toMatchObject({ title: '02 - Stave 2: The First of the', album: 'A Christmas Carol (version 7)', artist: 'Charles Dickens' });
      expect(meta.common.picture).toBeUndefined();
    });

    it('fill in the full titles, the author and the embedded cover, the title without its version', async () => {
      const files = folder('audio/carol-tiny', 'christmas_carol_7_1410_librivox').reverse();
      const draft = await draftFromFiles(files);
      expect(draft).toMatchObject({ kind: 'audio', main: null, title: 'A Christmas Carol', author: 'Charles Dickens', coverName: 'cover.jpg', warnings: [] });
      expect(draft.tracks.map((t) => [t.file.name, t.title, t.trackNo])).toEqual(TITLES.map((title, i) => [`christmascarol_${i + 1}_dickens_64kb.mp3`, title, i + 1]));
      // The picture in the first track's tag: a 200×200 JPEG of 4,298 bytes.
      expect(draft.cover?.type).toBe('image/jpeg');
      expect(draft.cover?.size).toBe(4298);
      expect([...(await blobBytes(draft.cover!)).subarray(0, 2)]).toEqual([0xff, 0xd8]);
    });
  });

  it('leaves out a picture in the tags larger than a cover may be: it would have the whole upload refused', async () => {
    // An ID3v2.3 tag of one frame, a front cover (APIC) a byte larger than a cover may be.
    const picture = new Uint8Array(MAX_COVER_BYTES + 1).fill(0x55);
    picture.set([0xff, 0xd8, 0xff, 0xe0]);
    const content = [0, ...new TextEncoder().encode('image/jpeg\0'), 3, 0];
    const frame = content.length + picture.length;
    const tag = 10 + frame;
    const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
    const head = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(tag), 0x41, 0x50, 0x49, 0x43, frame >>> 24, (frame >> 16) & 0xff, (frame >> 8) & 0xff, frame & 0xff, 0, 0, ...content]);
    const audio = untaggedMp3();
    const bytes = new Uint8Array(head.length + picture.length + audio.length);
    bytes.set(head);
    bytes.set(picture, head.length);
    bytes.set(audio, head.length + picture.length);
    const draft = await draftFromFiles([file('01 - Big Picture.mp3', bytes, 'Big Picture - Ada Tone')]);
    expect(draft).toMatchObject({ cover: null, coverName: null, title: 'Big Picture', author: 'Ada Tone', warnings: [] });
  });

  it('names an untagged audiobook after its folder and its tracks after their file names', async () => {
    const audio = untaggedMp3();
    const dir = 'The Hunting of the Snark - Lewis Carroll';
    const draft = await draftFromFiles([file('02 - The Bellman’s Speech.mp3', audio, dir), file('01 - The Landing.mp3', audio, dir)]);
    expect(draft).toMatchObject({ kind: 'audio', title: 'The Hunting of the Snark', author: 'Lewis Carroll', cover: null, coverName: null, warnings: [] });
    expect(draft.tracks.map((t) => t.title)).toEqual(['The Landing', 'The Bellman’s Speech']);
  });

  it('keeps a damaged track, named from its file, beside the readable ones', async () => {
    const dir = 'The Synthetic Tale';
    const draft = await draftFromFiles([fixture('audio/synthetic/01 - The Beginning.mp3', dir), file('07 - The Tea Party.mp3', new TextEncoder().encode('not audio at all'), dir)]);
    expect(draft.title).toBe('The Synthetic Tale');
    expect(draft.author).toBe('Ada Tone');
    expect(draft.tracks.map((t) => [t.file.name, t.title])).toEqual([
      ['01 - The Beginning.mp3', 'The Beginning'],
      ['07 - The Tea Party.mp3', 'The Tea Party'],
    ]);
  });

  it('notes a file it could not read at all, numbering it from its name', async () => {
    // No type from the browser and bytes that are not audio: the tag reader gives up on it.
    const unreadable = new File([new TextEncoder().encode('not audio at all')], '07 - The Tea Party.mp3');
    const draft = await draftFromFiles([unreadable]);
    expect(draft.tracks.map((t) => [t.title, t.trackNo])).toEqual([['The Tea Party', 7]]);
    expect(draft.warnings).toEqual(['07 - The Tea Party.mp3: no tags found']);
  });

  it('tells the person what to choose when the file is not a book', async () => {
    await expect(draftFromFiles([file('notes.txt', new TextEncoder().encode('hello'))])).rejects.toThrow('Choose an EPUB, a PDF, or audiobook tracks (MP3, M4A, M4B…).');
    await expect(draftFromFiles([fixture('audio/alice-tiny/Alice_in_Wonderland.jpg')])).rejects.toThrow('Choose an EPUB, a PDF, or audiobook tracks (MP3, M4A, M4B…).');
  });

  it('tells the person when they chose nothing, or two books', async () => {
    await expect(draftFromFiles([])).rejects.toThrow('Choose a file.');
    await expect(draftFromFiles([fixture('books/alice-gutenberg-11.epub'), fixture('books/alice.pdf')])).rejects.toThrow('Choose one book at a time');
  });

  it('says so when a file named .epub is not an EPUB', async () => {
    await expect(draftFromFiles([file('renamed.epub', new TextEncoder().encode('just some text'))])).rejects.toThrow('This file is not an EPUB.');
    await expect(draftFromFiles([file('damaged.epub', bytesOf('books/alice-gutenberg-11.epub').slice(0, 5_000))])).rejects.toThrow(/EPUB/);
  });
});

describe('tags written as slugs', () => {
  it('read as words, as LibriVox writes its album and reader', () => {
    expect(tidyTag('happy_prince_and_other_tales')).toBe('Happy Prince and Other Tales');
    expect(tidyTag('wilde_o')).toBe('O. Wilde');
    expect(tidyTag('the_time_machine')).toBe('The Time Machine');
    // Already words, or a name with capitals: kept as it is.
    expect(tidyTag("Alice's Adventures in Wonderland")).toBe("Alice's Adventures in Wonderland");
    expect(tidyTag('Lewis Carroll')).toBe('Lewis Carroll');
    expect(tidyTag('McGuffin_Tales')).toBe('McGuffin Tales');
  });
});

describe('titles from tags', () => {
  it('lose the number LibriVox gives a later recording of a work it has recorded before', () => {
    expect(tidyTitle('A Christmas Carol (version 7)')).toBe('A Christmas Carol');
    expect(tidyTitle('Pride and Prejudice (Version 2)')).toBe('Pride and Prejudice');
    expect(tidyTitle('  Hamlet ( VERSION 12 ) ')).toBe('Hamlet');
  });

  it('keep every other parenthesis, and a version that is not the end of the title', () => {
    expect(tidyTitle('A Christmas Carol (Dramatic Reading)')).toBe('A Christmas Carol (Dramatic Reading)');
    expect(tidyTitle('Bleak House (Abridged)')).toBe('Bleak House (Abridged)');
    expect(tidyTitle('The Time Machine (version two)')).toBe('The Time Machine (version two)');
    expect(tidyTitle('The Time Machine (version 2) Retold')).toBe('The Time Machine (version 2) Retold');
    expect(tidyTitle('Persuasion (1818 version)')).toBe('Persuasion (1818 version)');
    // A title that is nothing but the mark keeps it.
    expect(tidyTitle('(version 7)')).toBe('(version 7)');
  });

  it('are read as words first, as every tag is', () => {
    expect(tidyTitle('happy_prince_and_other_tales')).toBe('Happy Prince and Other Tales');
    expect(tidyTitle("Alice's Adventures in Wonderland")).toBe("Alice's Adventures in Wonderland");
  });
});


describe('the title a club calls a book (fidelity review round 16)', () => {
  it('is what comes before the subtitle, as Gutenberg writes its titles', () => {
    expect(clubTitle('Frankenstein; or, The modern Prometheus')).toBe('Frankenstein');
    expect(clubTitle('Moby Dick; Or, The Whale')).toBe('Moby Dick');
    expect(clubTitle('Jane Eyre: An Autobiography')).toBe('Jane Eyre');
    expect(clubTitle('Little Women; Or, Meg, Jo, Beth, and Amy')).toBe('Little Women');
    expect(clubTitle('A Tale of Two Cities: A Story of the French Revolution')).toBe('A Tale of Two Cities');
    expect(clubTitle('Emma: A Novel')).toBe('Emma');
    expect(clubTitle('1984: A Novel')).toBe('1984');
    expect(clubTitle('  Beowulf : An Anglo-Saxon Epic Poem ')).toBe('Beowulf');
  });

  it('leaves a title page’s “in Prose” with its subtitle, unless a single word would be left', () => {
    expect(clubTitle('A Christmas Carol in Prose; Being a Ghost Story of Christmas')).toBe('A Christmas Carol');
    expect(clubTitle('The Song of Hiawatha in Verse: A Poem')).toBe('The Song of Hiawatha');
    expect(clubTitle('Fables in Verse: For the Improvement of the Young and the Old')).toBe('Fables in Verse');
    expect(clubTitle('A Dream in Verse: Or, a Vision')).toBe('A Dream in Verse');
    // Without a subtitle, it is the title.
    expect(clubTitle('A Christmas Carol in Prose')).toBe('A Christmas Carol in Prose');
  });

  it('keeps anything shorter as it is: a title with no subtitle, or whose start is no title of its own', () => {
    for (const title of [
      "Alice's Adventures in Wonderland",
      'The Count of Monte Cristo',
      'Dr. Jekyll and Mr. Hyde',
      'Hamlet, Prince of Denmark',
      'Volume 1: The Fellowship of the Ring',
      'Book I: The Coming of Arthur',
      'Part the First: Childhood',
      'Vol. II; Letters',
      'A: Novel',
      ': A Subtitle Alone',
      '',
    ]) {
      expect(clubTitle(title), title).toBe(title);
    }
  });

  it('keeps a volume named in the title itself', () => {
    expect(clubTitle('The Works of Edgar Allan Poe, Volume 2: Tales')).toBe('The Works of Edgar Allan Poe, Volume 2');
    expect(clubTitle('Le Morte d’Arthur, Volume 1; Sir Thomas Malory’s Book of King Arthur')).toBe('Le Morte d’Arthur, Volume 1');
  });
});

/** An EPUB of one page whose package says this title, author and language. */
function epubOf(title: string, author: string, language = 'en'): Uint8Array {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:test:1</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>${language}</dc:language>
  </metadata>
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/c1.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Mr. Utterson the lawyer was a man of a rugged countenance.</p></body></html>'),
  });
}

describe('the author a club names (fidelity review round 17)', () => {
  it('is a library catalogue’s name, surname first with life dates, as people say it', () => {
    expect(clubAuthor('Stevenson, Robert Louis, 1850-1894')).toBe('Robert Louis Stevenson');
    expect(clubAuthor('Carroll, Lewis')).toBe('Lewis Carroll');
    expect(clubAuthor('Austen, Jane, 1775-1817.')).toBe('Jane Austen');
    expect(clubAuthor('Shelley, Mary Wollstonecraft, 1797–1851')).toBe('Mary Wollstonecraft Shelley');
    expect(clubAuthor('Stevenson, Robert Louis 1850-1894')).toBe('Robert Louis Stevenson');
    expect(clubAuthor('Chaucer, Geoffrey, d. 1400')).toBe('Geoffrey Chaucer');
    expect(clubAuthor('Dickens, Charles, 1812-1870, author')).toBe('Charles Dickens');
    // Initials with the catalogue's fuller form of them; a surname with its particles.
    expect(clubAuthor('Wells, H. G. (Herbert George), 1866-1946')).toBe('H. G. Wells');
    expect(clubAuthor('Le Fanu, Joseph Sheridan, 1814-1873')).toBe('Joseph Sheridan Le Fanu');
    expect(clubAuthor('de la Mare, Walter, 1873-1956')).toBe('Walter de la Mare');
    // What the catalogue writes after the forenames: before the name, after it, or not at all.
    expect(clubAuthor('Doyle, Arthur Conan, Sir, 1859-1930')).toBe('Sir Arthur Conan Doyle');
    expect(clubAuthor('King, Martin Luther, Jr., 1929-1968')).toBe('Martin Luther King Jr.');
    expect(clubAuthor('Tolstoy, Leo, graf, 1828-1910')).toBe('Leo Tolstoy');
  });

  it('names several, between semicolons, each so, joined with “and”', () => {
    expect(clubAuthor('Stevenson, Robert Louis, 1850-1894; Osbourne, Lloyd, 1868-1947')).toBe('Robert Louis Stevenson and Lloyd Osbourne');
    expect(clubAuthor('Nordhoff, Charles; Hall, James Norman; Verne, Jules')).toBe('Charles Nordhoff, James Norman Hall and Jules Verne');
  });

  it('keeps a name as people say it, names with only commas between them, and anything else', () => {
    for (const name of ['Lewis Carroll', 'Robert Louis Stevenson', 'H. G. Wells', 'Lewis Carroll, John Tenniel', 'Project Gutenberg, Inc.', 'Anonymous', 'Ada Tone', '']) {
      expect(clubAuthor(name), name).toBe(name);
    }
  });
});

describe('a title in sentence case, as the upload form fills it in (fidelity review round 17)', () => {
  it('is put in title case, as a club calls the book', () => {
    expect(titleCase('The strange case of Dr. Jekyll and Mr. Hyde')).toBe('The Strange Case of Dr. Jekyll and Mr. Hyde');
    expect(titleCase('Strange case of Dr. Jekyll and Mr. Hyde')).toBe('Strange Case of Dr. Jekyll and Mr. Hyde');
    expect(titleCase("Alice's adventures in Wonderland")).toBe("Alice's Adventures in Wonderland");
    expect(titleCase('The war of the worlds')).toBe('The War of the Worlds');
    expect(titleCase('Of mice and men')).toBe('Of Mice and Men');
    expect(titleCase('Twenty thousand leagues under the sea')).toBe('Twenty Thousand Leagues Under the Sea');
    expect(titleCase('Letters from my windmill')).toBe('Letters from My Windmill');
    expect(titleCase('The 39 steps')).toBe('The 39 Steps');
    // Each part of a hyphenated word; after a colon, a small word starts the subtitle; the last word.
    expect(titleCase('Through the looking-glass')).toBe('Through the Looking-Glass');
    expect(titleCase('The adventures of Tom Sawyer: a story')).toBe('The Adventures of Tom Sawyer: A Story');
    expect(titleCase('What the night is for')).toBe('What the Night Is For');
    // A word with capitals of its own keeps them; a name's particles stay small.
    expect(titleCase('My life with an iPhone')).toBe('My Life with an iPhone');
    expect(titleCase('The life of Charles de Gaulle')).toBe('The Life of Charles de Gaulle');
  });

  it('keeps a title in title case already, one in small letters as its author set it, and a word alone', () => {
    for (const title of ['A Christmas Carol', "Alice's Adventures in Wonderland", 'The Count of Monte Cristo', 'Dr. Jekyll and Mr. Hyde', 'Pride and Prejudice', 'Notre-Dame de Paris', 'Le Morte d’Arthur', 'THE TIME MACHINE', 'the waste land', 'Frankenstein', 'McTeague', '']) {
      expect(titleCase(title), title).toBe(title);
    }
  });

  it('is how a Gutenberg EPUB’s title and a catalogue’s author are filled in; a French title keeps its small letters', async () => {
    const jekyll = await draftFromFiles([file('pg43.epub', epubOf('The strange case of Dr. Jekyll and Mr. Hyde', 'Stevenson, Robert Louis, 1850-1894'))]);
    expect(jekyll).toMatchObject({ kind: 'epub', title: 'The Strange Case of Dr. Jekyll and Mr. Hyde', author: 'Robert Louis Stevenson' });
    const prince = await draftFromFiles([file('prince.epub', epubOf('Le petit prince', 'Saint-Exupéry, Antoine de, 1900-1944', 'fr'))]);
    expect(prince).toMatchObject({ title: 'Le petit prince' });
  });
});
