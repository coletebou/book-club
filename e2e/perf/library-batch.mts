// Run from the repository root with:
// pnpm --filter @bookclub/server exec tsx ../../e2e/perf/library-batch.mts
import { type Client, closeApp, makeTestApp } from '../../apps/server/test/helpers.ts';
import { seedDemoIfEmpty } from '../../apps/server/src/cli/seed.ts';
import { booksForClub, createBook, createEdition, editionsForBook } from '../../apps/server/src/repos/books.ts';
import { meetingFor, occasionOf, rsvpsFor, setMeeting, setRsvp } from '../../apps/server/src/repos/meetings.ts';
import { progressForBook } from '../../apps/server/src/repos/progress.ts';

const app = await makeTestApp();

try {
  await seedDemoIfEmpty(app.ctx);
  const { db } = app.ctx;
  const client = app.client();
  const signedIn = await client.post('/api/auth/signin', { email: 'ana@demo.bookclub', password: 'wonderland-demo' });
  if (signedIn.statusCode !== 200) throw new Error('Could not sign in as a fixture member');

  const clubId = db.get<{ id: string }>('SELECT id FROM clubs')!.id;
  const book = booksForClub(db, clubId)[0]!;
  const editions = editionsForBook(db, book.id);
  const progress = progressForBook(db, book.id);
  const meeting = meetingFor(db, book.id)!;
  const occasion = occasionOf(meeting)!;
  const rsvps = rsvpsFor(db, book.id, occasion);

  await measure(client, clubId, 1);
  db.tx(() => {
    for (let i = 2; i <= 100; i++) {
      const copy = createBook(db, { clubId, createdBy: book.created_by, title: `Volume ${i}`, author: book.author });
      const editionIds = new Map<string, string>();
      for (const source of editions) {
        const target = createEdition(db, { bookId: copy.id, kind: source.kind, createdBy: source.created_by, sizeBytes: source.size_bytes });
        editionIds.set(source.id, target.id);
        db.exec('UPDATE editions SET status = ?, geometry_json = ?, units_json = ?, sync_json = ?, alignment_json = ?, meta_json = ? WHERE id = ?',
          [source.status, source.geometry_json, source.units_json, source.sync_json, source.alignment_json, source.meta_json, target.id]);
      }
      db.exec('UPDATE books SET chapters_json = ?, reference_edition_id = ? WHERE id = ?',
        [book.chapters_json, editionIds.get(book.reference_edition_id!) ?? null, copy.id]);
      for (const row of progress) {
        db.exec(`INSERT INTO progress(user_id, book_id, edition_id, locator_json, t, label, client_at, read_ranges_json,
                                      furthest, coverage, finished_at, unplaced_ranges_json, updated_at)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.user_id, copy.id, editionIds.get(row.edition_id!) ?? null, row.locator_json, row.t, row.label, row.client_at,
            row.read_ranges_json, row.furthest, row.coverage, row.finished_at, row.unplaced_ranges_json, row.updated_at]);
      }
      setMeeting(db, copy.id, meeting.set_by, {
        t: meeting.t, onDay: meeting.on_day, startsAt: meeting.starts_at, tz: meeting.tz, minutes: meeting.minutes,
        placeKind: meeting.place_kind, place: meeting.place,
      });
      for (const rsvp of rsvps) setRsvp(db, copy.id, rsvp.user_id, occasion, rsvp.answer);
    }
  });
  await measure(client, clubId, 100);
} finally {
  await closeApp(app);
}

async function measure(client: Client, clubId: string, books: number): Promise<void> {
  const { db } = app.ctx;
  const url = `/api/clubs/${clubId}/books`;
  const headers = { 'accept-encoding': 'identity' };
  for (let i = 0; i < 3; i++) await client.get(url, headers);

  const original = { get: db.get, all: db.all, exec: db.exec };
  let statements = 0;
  db.get = function (...args) { statements++; return original.get.call(this, ...args); };
  db.all = function (...args) { statements++; return original.all.call(this, ...args); };
  db.exec = function (...args) { statements++; return original.exec.call(this, ...args); };
  const samples = [];
  try {
    for (let i = 0; i < 9; i++) {
      statements = 0;
      const start = process.cpuUsage();
      const response = await client.get(url, headers);
      const used = process.cpuUsage(start);
      if (response.statusCode !== 200 || response.json<unknown[]>().length !== books) throw new Error('Unexpected library response');
      samples.push({ statements, cpuUs: used.user + used.system, bytes: response.bytes.length });
    }
  } finally {
    Object.assign(db, original);
  }

  const sorted = samples.map((sample) => sample.cpuUs).sort((a, b) => a - b);
  console.log(JSON.stringify({ books, statements: [...new Set(samples.map((sample) => sample.statements))],
    medianCpuUs: sorted[4], bytes: samples[0]!.bytes, samples: sorted }));
}
