import {
  ID3V2_HEADER_BYTES,
  MAX_COVER_BYTES,
  type Id3v2Tags,
  chapterNumber,
  id3v2Header,
  id3v2ReadAgain,
  id3v2ReadLength,
  looksBlank,
  naturalCompare,
  prettifyTrackTitle,
  readId3v2,
} from '@bookclub/shared';

export type UploadKind = 'epub' | 'pdf' | 'audio';

const AUDIO_EXT = /\.(mp3|m4a|m4b|mp4|aac|ogg|oga|opus|flac|wav|webm)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

export interface PickedTrack {
  readonly file: File;
  readonly title: string;
  readonly trackNo: number | null;
}

export interface Draft {
  readonly kind: UploadKind;
  readonly main: File | null;
  readonly tracks: PickedTrack[];
  readonly cover: Blob | null;
  readonly coverName: string | null;
  readonly title: string;
  readonly author: string;
  readonly warnings: string[];
}

/** What did the user pick? One EPUB, one PDF, or a set of audio tracks (plus perhaps an image). */
export function classify(files: readonly File[]): { kind: UploadKind | null; error: string | null } {
  const epubs = files.filter((f) => /\.epub$/i.test(f.name));
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  const audio = files.filter((f) => AUDIO_EXT.test(f.name));
  if (audio.length > 0 && epubs.length + pdfs.length === 0) return { kind: 'audio', error: null };
  if (epubs.length === 1 && pdfs.length === 0 && audio.length === 0) return { kind: 'epub', error: null };
  if (pdfs.length === 1 && epubs.length === 0 && audio.length === 0) return { kind: 'pdf', error: null };
  if (files.length === 0) return { kind: null, error: null };
  if (epubs.length + pdfs.length > 1) return { kind: null, error: 'Choose one book at a time: one EPUB, one PDF, or one folder of audio tracks.' };
  if (audio.length > 0) return { kind: null, error: 'Audio tracks and an ebook are separate formats. Add them one at a time.' };
  return { kind: null, error: 'Choose an EPUB, a PDF, or audiobook tracks (MP3, M4A, M4B…).' };
}

/**
 * A folder's cover image: cover/folder/front first, else the largest image. One bigger than a
 * cover may be (a scan at print size) is left out: it would have the whole upload refused.
 */
export function pickFolderCover(files: readonly File[]): File | null {
  const images = files.filter((f) => IMAGE_EXT.test(f.name) && f.size <= MAX_COVER_BYTES);
  if (images.length === 0) return null;
  const named = images.find((f) => /(^|[\\/_ -])(cover|folder|front)[^\\/]*\.\w+$/i.test(f.name));
  return named ?? [...images].sort((a, b) => b.size - a.size)[0]!;
}

/** Tracks in natural filename order ("track 2" before "track 10"). */
export function orderTracks(files: readonly File[]): File[] {
  return files.filter((f) => AUDIO_EXT.test(f.name)).sort((a, b) => naturalCompare(a.name, b.name));
}

/** "Alice in Wonderland - Lewis Carroll" → title and author, for folders without tags. */
export function guessFromName(name: string): { title: string; author: string } {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { title: parts[0]!.trim(), author: parts.slice(1).join(' - ').trim() };
  return { title: base, author: '' };
}

async function epubDraft(file: File): Promise<Draft> {
  const { readEpubPreview } = await import('@bookclub/epub');
  const preview = readEpubPreview(new Uint8Array(await file.arrayBuffer()));
  const cover = preview.cover ? new Blob([preview.cover.bytes as BlobPart], { type: preview.cover.mediaType }) : null;
  const title = clubTitle(preview.title);
  // Title case is English's way: a French title keeps its small letters.
  const english = !preview.language || /^en\b/i.test(preview.language);
  return { kind: 'epub', main: file, tracks: [], cover, coverName: null, title: english ? titleCase(title) : title, author: clubAuthor(preview.author), warnings: [] };
}

async function pdfDraft(file: File): Promise<Draft> {
  const { openPdf } = await import('../lib/pdf');
  const task = openPdf(new Uint8Array(await file.arrayBuffer()));
  const doc = await task.promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const guess = guessFromName(file.name);
    const title = titleCase(clubTitle((typeof info.Title === 'string' && info.Title.trim()) || guess.title));
    const author = clubAuthor((typeof info.Author === 'string' && info.Author.trim()) || guess.author);
    // Page one, drawn, is the cover: unless it is blank (a flyleaf, or pictures this browser could
    // not decode), when the server draws the page with its own pdf.js, or the book gets a made one (D103).
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 640 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d')!;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const cover = looksBlank(context.getImageData(0, 0, canvas.width, canvas.height).data) ? null : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return { kind: 'pdf', main: file, tracks: [], cover, coverName: cover ? 'cover.jpg' : null, title, author, warnings: [] };
  } finally {
    await task.destroy();
  }
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'with']);
const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * A tag written as a slug, as LibriVox's often are ("happy_prince_and_other_tales", "wilde_o"), as
 * words: "Happy Prince and Other Tales", "O. Wilde" (its "surname_initial"). Anything else is kept.
 */
export function tidyTag(raw: string): string {
  const s = raw.trim();
  if (!s.includes('_') || /\s/.test(s)) return s;
  const words = s.split(/_+/).filter(Boolean);
  if (words.length === 2 && words[1]!.length === 1 && words[0]!.length > 1) return `${words[1]!.toUpperCase()}. ${capital(words[0]!)}`;
  return words.map((w, i) => (w !== w.toLowerCase() ? w : i > 0 && SMALL_WORDS.has(w) ? w : capital(w))).join(' ');
}

/** The number LibriVox gives a later recording of a work it has recorded before. */
const VERSION_MARK = /\(\s*version\s+\d+\s*\)$/i;

/**
 * A book's title from a tag (or a folder's name): as words, as tidyTag reads them, without the
 * number LibriVox gives a later recording of the same work ("A Christmas Carol (version 7)").
 * Other parentheses ("(Dramatic Reading)", "(Abridged)") are part of the title.
 */
export function tidyTitle(raw: string): string {
  const s = tidyTag(raw);
  const mark = VERSION_MARK.exec(s);
  return (mark ? s.slice(0, mark.index).trimEnd() : s) || s;
}

/** A heading that only says which part of something it is: "Volume 2", "Part I", "Book the First". */
const PART_ONLY = /^(?:vol(?:ume)?|part|book|tome|no|number|issue|series|chapter|section)\.?\s*(?:[0-9]+|[ivxlcdm]+|the\s+\w+|one|two|three|four|five|six|seven|eight|nine|ten)?$/i;

/** Whether what comes before a subtitle is a title of its own: a word of two letters or more, not a part's number. */
function titleOfItsOwn(head: string): boolean {
  return (head.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2 && !PART_ONLY.test(head);
}

/**
 * The title a club calls a book, from the full one a file gives (Gutenberg's, a PDF's, a tag): what
 * comes before its subtitle, at the first ";" or ":" ("Frankenstein; or, The Modern Prometheus",
 * "Jane Eyre: An Autobiography"), where that is a title of its own. A title page's "in Prose" (or
 * "in Verse") goes with its subtitle ("A Christmas Carol in Prose; Being a Ghost Story of
 * Christmas" is "A Christmas Carol"), unless a single word would be left. A title without a
 * subtitle, or whose start only says which volume or part it is ("Volume 1: …"), is kept as it is.
 * Only what is filled in is shortened: the title as typed is the book's.
 */
export function clubTitle(full: string): string {
  const s = full.trim();
  const cut = /[;:]/.exec(s);
  if (!cut) return s;
  const head = s.slice(0, cut.index).trim();
  if (!titleOfItsOwn(head)) return s;
  const form = /\s+in\s+(?:prose|verse)$/i.exec(head);
  const plain = form ? head.slice(0, form.index) : head;
  return form && /\s/.test(plain.replace(/^(?:a|an|the)\s+/i, '')) ? plain : head;
}

/**
 * Words a title keeps in small letters inside it, as the app's own labels do (shared calmCaps), and
 * the particles of names ("Charles de Gaulle", "Ludwig van Beethoven", "Notre-Dame de Paris").
 */
const TITLE_SMALL_WORDS = new Set([...SMALL_WORDS, 'from', 'into', 'de', 'des', 'du', 'la', 'le', 'van', 'von', 'der', 'di', 'da', 'del']);

/**
 * A title written in sentence case, as Project Gutenberg writes many ("The strange case of Dr.
 * Jekyll and Mr. Hyde"), in title case, as a club calls the book: "The Strange Case of Dr. Jekyll
 * and Mr. Hyde". Only then: a title whose words start with capitals already ("A Christmas Carol"),
 * or whose first word starts with a small letter (as its author set it, "the waste land"), is
 * kept as it is. Small words stay small inside it ("of", "and", "the"); the first and the last
 * words, a word after a colon or a dash, and each part of a hyphenated word ("Looking-Glass") get
 * a capital; a word with capitals of its own ("McTeague", "iPhone", "NASA") is kept as written.
 * Only what is filled in: the title as typed is the book's (D98).
 */
export function titleCase(title: string): string {
  // Words, and what stands between them.
  const parts = title.split(/(\s+)/);
  const isWord = (part: string) => /\p{L}/u.test(part);
  const words = parts.filter(isWord);
  const startsSmall = (word: string) => /^\P{L}*\p{Ll}/u.test(word);
  const small = (word: string) => TITLE_SMALL_WORDS.has(word.replace(/[^\p{L}]/gu, '').toLowerCase());
  if (words.length < 2 || startsSmall(words[0]!)) return title;
  // Sentence case: a word after the first that starts with a small letter, and is no small word.
  if (!words.slice(1).some((w) => startsSmall(w) && !small(w))) return title;
  const last = parts.findLastIndex(isWord);
  let opens = true;
  return parts
    .map((part, i) => {
      if (!isWord(part)) return part;
      const ownCapitals = /\p{L}.*\p{Lu}/su.test(part);
      const out = ownCapitals
        ? part
        : part
            .split(/([-–])/)
            .map((piece, k) => ((k === 0 && (opens || i === last || !small(piece))) || (k > 0 && !small(piece)) ? piece.replace(/^(\P{L}*)(\p{Ll})/u, (_, before: string, c: string) => before + c.toUpperCase()) : piece))
            .join('');
      opens = /[:;!?—–]$/.test(part);
      return out;
    })
    .join('');
}

/** Life dates as library catalogues write them after a name: "1850-1894", "1775-1817.", "b. 1840", "fl. 1340", "1923-". */
const LIFE_DATES = /,?\s*\(?(?:(?:b|d|fl|ca?)\.\s*|(?:born|died|active|approximately)\s+)?\d{3,4}\??\s*(?:[-–—]\s*(?:(?:ca?\.\s*)?\d{3,4}\??)?)?\)?\s*\.?$/i;
/** What a catalogue adds after a name to say what the person did ("…, 1850-1894, author"). */
const RELATOR = /,\s*(?:author|joint author|editor|illustrator|translator|narrator|compiler)\.?$/i;
/** Words a surname may start with besides its own ("de la Mare", "Le Fanu", "Van Dyke"). */
const PARTICLES = /^(?:de|da|del|della|der|di|du|la|le|van|von|den|ten|ter|st\.?|d’|d')$/i;
/** What a catalogue writes after a person's forenames that goes after their name ("Jr.") or before it ("Sir"). */
const AFTER_NAME = /^(?:jr|sr|ii|iii|iv)\.?$/i;
const BEFORE_NAME = /^(?:sir|dame|lord|lady)$/i;

/** One name as a catalogue writes it ("Stevenson, Robert Louis, 1850-1894") as people say it: "Robert Louis Stevenson". */
function nameAsSaid(raw: string): string {
  // Its dates and what the person did go, and a fuller form of the initials: "Wells, H. G. (Herbert George), 1866-1946".
  const plain = raw
    .trim()
    .replace(RELATOR, '')
    .replace(LIFE_DATES, '')
    .replace(/\s*\([^()]*\)/g, '')
    .trim()
    .replace(/,$/, '')
    .trim();
  const parts = plain.split(/\s*,\s*/);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) return plain;
  const [surname, forenames, after] = parts as [string, string, string | undefined];
  const isName = (w: string) => /^\p{Lu}[\p{L}'’.-]*$/u.test(w);
  const surnameWords = surname.split(/\s+/);
  if (!surnameWords.every((w, i) => (i === surnameWords.length - 1 ? isName(w) : PARTICLES.test(w)))) return plain;
  const forenameWords = forenames.split(/\s+/);
  if (forenameWords.length > 4 || !forenameWords.every(isName)) return plain;
  const name = `${forenames} ${surname}`;
  if (after === undefined) return name;
  if (AFTER_NAME.test(after)) return `${name} ${after}`;
  if (BEFORE_NAME.test(after)) return `${capital(after.toLowerCase())} ${name}`;
  // A rank in the catalogue's own words ("Tolstoy, Leo, graf"): not what people call them.
  return /^\p{Ll}/u.test(after) ? name : plain;
}

/**
 * The author a club names, from what a file says (a PDF's info, as archive.org copies it from a
 * library's catalogue; an EPUB's; a tag): a name written surname first, with life dates, as people
 * say it ("Stevenson, Robert Louis, 1850-1894" → "Robert Louis Stevenson", "Wells, H. G. (Herbert
 * George), 1866-1946" → "H. G. Wells"); several such names, between semicolons, each so and joined
 * with "and". A name as people say it already ("Lewis Carroll"), or names with only commas between
 * them ("Lewis Carroll, John Tenniel"), are kept. Only what is filled in: the author as typed is the book's.
 */
export function clubAuthor(raw: string): string {
  const names = raw
    .split(/\s*;\s*/)
    .map(nameAsSaid)
    .filter((name) => name.length > 0);
  if (names.length <= 1) return names[0] ?? raw.trim();
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/**
 * A track's ID3v2 tag read again from the file's first bytes where music-metadata's reading of it
 * may have stopped short (a tag unsynchronised as a whole, as LibriVox's are): only the tag's
 * bytes, as many as it declares and no more than a cover may take. Null for any other file.
 */
async function tagReadAgain(file: File, warnings: readonly { readonly message: string }[]): Promise<Id3v2Tags | null> {
  const header = id3v2Header(new Uint8Array(await file.slice(0, ID3V2_HEADER_BYTES).arrayBuffer()));
  if (!header || !id3v2ReadAgain(header, warnings)) return null;
  const bytes = new Uint8Array(await file.slice(0, id3v2ReadLength(header, MAX_COVER_BYTES)).arrayBuffer());
  return readId3v2(bytes, { maxPictureBytes: MAX_COVER_BYTES });
}

async function audioDraft(files: readonly File[]): Promise<Draft> {
  const { parseBlob } = await import('music-metadata');
  const ordered = orderTracks(files);
  const tracks: PickedTrack[] = [];
  let album: string | null = null;
  let artist: string | null = null;
  let picture: Blob | null = null;
  const warnings: string[] = [];
  for (const file of ordered) {
    try {
      const meta = await parseBlob(file, { duration: false, skipCovers: picture !== null });
      // What the tag read again holds wins over music-metadata's reading (an ID3v1 title, cut to
      // 30 characters), which stands for whatever the tag lacks, or when it cannot be read again.
      const tag = await tagReadAgain(file, meta.quality.warnings).catch(() => null);
      const { common } = meta;
      album ??= (tag?.album ?? common.album)?.trim() || null;
      artist ??= (tag?.albumArtist ?? tag?.artist ?? common.albumartist ?? common.artist)?.trim() || null;
      const pic = tag?.picture ? { data: tag.picture.data, format: tag.picture.mime } : common.picture?.[0];
      // A picture larger than a cover may be would have the whole upload refused.
      if (!picture && pic && pic.data.byteLength <= MAX_COVER_BYTES) picture = new Blob([pic.data as BlobPart], { type: pic.format });
      tracks.push({ file, title: prettifyTrackTitle(tag?.title ?? common.title, file.name), trackNo: tag?.track ?? common.track.no ?? null });
    } catch {
      tracks.push({ file, title: prettifyTrackTitle(undefined, file.name), trackNo: chapterNumber(file.name) });
      warnings.push(`${file.name}: no tags found`);
    }
  }
  const folderCover = pickFolderCover(files);
  const folder = (ordered[0]?.webkitRelativePath || '').split('/')[0] ?? '';
  const guess = guessFromName(folder || ordered[0]?.name || '');
  return {
    kind: 'audio',
    main: null,
    tracks,
    cover: folderCover ?? picture,
    coverName: folderCover?.name ?? (picture ? 'cover.jpg' : null),
    title: titleCase(clubTitle(tidyTitle(album ?? guess.title))),
    author: clubAuthor(tidyTag(artist ?? guess.author)),
    warnings,
  };
}

/** Read what we can from the files, locally, before anything is uploaded. */
export async function draftFromFiles(files: readonly File[]): Promise<Draft> {
  const { kind, error } = classify(files);
  if (!kind) throw new Error(error ?? 'Choose a file.');
  if (kind === 'epub') return epubDraft(files.find((f) => /\.epub$/i.test(f.name))!);
  if (kind === 'pdf') return pdfDraft(files.find((f) => /\.pdf$/i.test(f.name))!);
  return audioDraft(files);
}
