import { copyFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { measureBodyText } from '@bookclub/epub';
import { type EpubLocator, type Locator, type Publication, TranscriptSchema, localDayIn, locatorToT, mToLocator, meetingStops, naturalCompare, tToLocator, zonedInstant } from '@bookclub/shared';
import { type AppContext } from '../context';
import { hashPassword } from '../lib/crypto';
import { toJson } from '../lib/json';
import { ingestEdition } from '../ingest/pipeline';
import { adoptBlob } from '../repos/blobs';
import { addEditionFile, bookById, bookChapters, createBook, createEdition, editionById, editionTimeline } from '../repos/books';
import { addMember, createClub } from '../repos/clubs';
import { insertComment } from '../repos/comments';
import { setMeeting, setRsvp } from '../repos/meetings';
import { type UserRow, countUsers, createLocalUser } from '../repos/users';
import { applyProgress } from '../services/progress';
import { alignBook, importTranscript } from '../services/readalong';

/** Demo accounts, documented in README.md. */
export const DEMO_PASSWORD = 'wonderland-demo';
export const DEMO_USERS = [
  { key: 'cole', name: 'Cole', email: 'cole@demo.bookclub' },
  { key: 'ana', name: 'Ana', email: 'ana@demo.bookclub' },
  { key: 'ben', name: 'Ben', email: 'ben@demo.bookclub' },
  { key: 'cleo', name: 'Cleo', email: 'cleo@demo.bookclub' },
] as const;

interface DemoAssets {
  readonly epub: string;
  readonly pdf: string | null;
  readonly audioDir: string | null;
  /** What a recogniser heard in the LibriVox recording (tools/align/transcribe.py), for read-along. */
  readonly transcript: string | null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Where the demo books are: the image's /demo, or the repository fixtures in development. */
export async function findDemoAssets(root: string): Promise<DemoAssets | null> {
  const candidates = root ? [root] : [];
  candidates.push(path.resolve('fixtures'), path.resolve('../../fixtures'));
  for (const base of candidates) {
    const epub = path.join(base, 'books', 'alice-gutenberg-11.epub');
    if (!(await exists(epub))) continue;
    const pdf = path.join(base, 'books', 'alice.pdf');
    let audioDir: string | null = null;
    for (const dir of [path.join(base, 'audio', 'librivox-alice'), path.join(base, 'audio', 'alice-tiny')]) {
      if (await exists(dir)) {
        audioDir = dir;
        break;
      }
    }
    const transcript = path.join(base, 'align', 'librivox-alice.transcript.json');
    return { epub, pdf: (await exists(pdf)) ? pdf : null, audioDir, transcript: (await exists(transcript)) ? transcript : null };
  }
  return null;
}

async function addFileEdition(ctx: AppContext, bookId: string, userId: string, kind: 'epub' | 'pdf', file: string): Promise<string> {
  const tmp = path.join(ctx.storage.tmpDir, `seed-${path.basename(file)}`);
  await copyFile(file, tmp);
  const blob = await adoptBlob(ctx.db, ctx.storage, tmp, kind === 'epub' ? 'application/epub+zip' : 'application/pdf');
  const edition = createEdition(ctx.db, { bookId, kind, createdBy: userId, sizeBytes: blob.size });
  addEditionFile(ctx.db, { edition_id: edition.id, idx: 0, blob_id: blob.id, role: 'main', original_name: path.basename(file) });
  await ingestEdition(ctx, edition.id);
  return edition.id;
}

async function addAudioEdition(ctx: AppContext, bookId: string, userId: string, dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => /\.(mp3|m4a|m4b|ogg|opus)$/i.test(n)).sort(naturalCompare);
  const edition = createEdition(ctx.db, { bookId, kind: 'audio', createdBy: userId, sizeBytes: 0 });
  let total = 0;
  for (const [idx, name] of names.entries()) {
    const tmp = path.join(ctx.storage.tmpDir, `seed-${idx}-${name}`);
    await copyFile(path.join(dir, name), tmp);
    const blob = await adoptBlob(ctx.db, ctx.storage, tmp, 'audio/mpeg');
    addEditionFile(ctx.db, { edition_id: edition.id, idx, blob_id: blob.id, role: 'track', original_name: name });
    total += blob.size;
  }
  ctx.db.exec('UPDATE editions SET size_bytes = ? WHERE id = ?', [total, edition.id]);
  await ingestEdition(ctx, edition.id);
  return edition.id;
}

/** The locator at timeline position t in an edition. */
function at(ctx: AppContext, editionId: string, t: number): Locator {
  const tl = editionTimeline(editionById(ctx.db, editionId)!);
  if (!tl) throw new Error('edition not ready');
  return tToLocator(tl, t);
}

/** Progress as if the member had read (or listened) continuously from the start to t. */
/** Where a passage really is in an EPUB edition (so a seeded quote is pinned to its own words). */
async function findPassage(ctx: AppContext, editionId: string, passage: string): Promise<{ start: EpubLocator; end: EpubLocator } | null> {
  const manifest = ctx.storage.pubFile(editionId, '.publication.json');
  if (!manifest) return null;
  const pub = JSON.parse(await readFile(manifest, 'utf8')) as Publication;
  // Line breaks in the book's source are whitespace like any other.
  const pattern = new RegExp(passage.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  for (const section of pub.sections) {
    const file = ctx.storage.pubFile(editionId, section.href);
    if (!file) continue;
    const match = pattern.exec(measureBodyText(await readFile(file, 'utf8')));
    if (match) return { start: { kind: 'epub', section: section.index, offset: match.index }, end: { kind: 'epub', section: section.index, offset: match.index + match[0].length } };
  }
  return null;
}

function readTo(ctx: AppContext, userId: string, bookId: string, editionId: string, t: number, minutesAgo: number): void {
  const book = bookById(ctx.db, bookId)!;
  const edition = editionById(ctx.db, editionId)!;
  const tl = editionTimeline(edition)!;
  const from = tl.geometry.kind === 'epub' ? mToLocator(tl.geometry, tl.sync.points[0]!.m) : tToLocator(tl, 0);
  applyProgress(ctx.db, userId, book, edition, {
    editionId,
    locator: at(ctx, editionId, t),
    readSpans: [{ from, to: at(ctx, editionId, t) }],
    at: Date.now() - minutesAgo * 60_000,
  });
}

/**
 * Seed a demo club on an empty database: four friends reading Alice's Adventures in Wonderland in
 * three formats, at different places, with a few notes and reactions along the way.
 */
export async function seedDemoIfEmpty(ctx: AppContext, assetsRoot = ctx.config.DEMO_ASSETS): Promise<boolean> {
  if (countUsers(ctx.db) > 0) return false;
  const assets = await findDemoAssets(assetsRoot);
  if (!assets) {
    ctx.log.warn('demo assets not found; skipping the demo seed');
    return false;
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const users = {} as Record<(typeof DEMO_USERS)[number]['key'], UserRow>;
  for (const u of DEMO_USERS) users[u.key] = createLocalUser(ctx.db, { displayName: u.name, email: u.email, passwordHash });
  const club = createClub(ctx.db, { name: 'The Rabbit Hole Society', description: 'Reading Alice together, one chapter at a time.', ownerId: users.cole.id });
  for (const key of ['ana', 'ben', 'cleo'] as const) addMember(ctx.db, club.id, users[key].id);

  const book = createBook(ctx.db, { clubId: club.id, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', createdBy: users.cole.id });
  const epub = await addFileEdition(ctx, book.id, users.cole.id, 'epub', assets.epub);
  const pdf = assets.pdf ? await addFileEdition(ctx, book.id, users.cole.id, 'pdf', assets.pdf) : null;
  const audio = assets.audioDir ? await addAudioEdition(ctx, book.id, users.ana.id, assets.audioDir) : null;
  // Sentence by sentence, before anyone's place is set: the demo reads along (D46). The
  // transcript is of the LibriVox recording; with the tiny development tracks it matches nothing.
  if (audio && assets.transcript) {
    const edition = editionById(ctx.db, audio);
    try {
      if (edition) importTranscript(ctx, edition, TranscriptSchema.parse(JSON.parse(await readFile(assets.transcript, 'utf8'))));
      await alignBook(ctx, book.id);
    } catch (err) {
      ctx.log.info({ err: err instanceof Error ? err.message : String(err) }, 'demo transcript not used');
    }
  }

  // Where everyone is, as on a first evening: Cole (who opens the demo, on his phone) and Ana in
  // the EPUB, Ben listening, Cleo further on in the PDF at her computer. A phone opening "Read on"
  // in a PDF meets a page of 10-pixel type (fidelity review round 17).
  readTo(ctx, users.ana.id, book.id, epub, 0.47, 30);
  readTo(ctx, users.cleo.id, book.id, pdf ?? epub, 0.71, 240);
  if (audio) readTo(ctx, users.ben.id, book.id, audio, 0.18, 90);
  else readTo(ctx, users.ben.id, book.id, epub, 0.18, 90);
  readTo(ctx, users.cole.id, book.id, epub, 0.08, 600);

  // Notes and reactions, each at a real place in the text: a quote is pinned to its own words.
  const note = async (userId: string, editionId: string, t: number, text: string | null, reaction: string | null, quote: string | null = null) => {
    const found = quote ? await findPassage(ctx, editionId, quote) : null;
    const timeline = editionTimeline(editionById(ctx.db, editionId)!)!;
    const locator = found?.start ?? at(ctx, editionId, t);
    insertComment(ctx.db, {
      bookId: book.id,
      userId,
      editionId,
      kind: locator.kind,
      locator,
      endLocator: found?.end ?? null,
      t: found ? locatorToT(timeline, found.start) : t,
      endT: found ? locatorToT(timeline, found.end) : null,
      quote: found ? quote : null,
      text,
      reaction: reaction as never,
      clientId: null,
    });
  };
  await note(users.ana.id, epub, 0.035, 'Falling for so long she has time to wonder about latitude. I love her already.', '😂', 'Down, down, down. Would the fall never come to an end?');
  await note(users.cleo.id, epub, 0.12, 'The pool of tears is literally her own tears. Carroll is wild.', '🤯', 'I wish I hadn’t cried so much!');
  await note(users.ana.id, epub, 0.33, null, '❤️');
  await note(users.cleo.id, epub, 0.52, 'The Cheshire Cat! "We\'re all mad here."', '😱', 'we’re all mad here. I’m mad. You’re mad.');
  await note(users.cleo.id, epub, 0.6, 'This tea party is the best chapter so far.', '😂', 'Have some wine');
  if (audio) await note(users.ben.id, audio, 0.16, 'Listening on the bus: the narrator does a perfect Mouse.', '😂');
  // The next stop (D53), as a meet-up (D206): Ana suggested talking it over at the end of chapter 6,
  // in four days at half past seven, in the club's voice room where the demo has one; Ana and Cleo
  // are coming, Ben is not sure yet.
  const stop = meetingStops(bookChapters(bookById(ctx.db, book.id)!)).find((s) => s.label === 'the end of Chapter 6');
  if (stop) {
    const tz = 'America/New_York';
    const startsAt = zonedInstant(localDayIn(Date.now() + 4 * 24 * 3600_000, tz), '19:30', tz);
    const place = ctx.config.livekit ? { placeKind: 'voice' as const } : { placeKind: 'place' as const, place: 'The Mad Hatter’s, 6 Tea Party Lane' };
    setMeeting(ctx.db, book.id, users.ana.id, { t: stop.t, onDay: localDayIn(startsAt, tz), startsAt, tz, minutes: 90, ...place });
    const occasion = `at:${startsAt}`;
    setRsvp(ctx.db, book.id, users.ana.id, occasion, 'yes');
    setRsvp(ctx.db, book.id, users.cleo.id, occasion, 'yes');
    setRsvp(ctx.db, book.id, users.ben.id, occasion, 'maybe');
  }
  ctx.db.exec('UPDATE books SET created_at = ? WHERE id = ?', [Date.now() - 3 * 24 * 3600_000, book.id]);
  ctx.log.info({ club: club.id, book: book.id, editions: toJson({ epub, pdf, audio }) }, 'demo seeded');
  return true;
}
