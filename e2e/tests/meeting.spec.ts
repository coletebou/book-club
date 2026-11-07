import { readFile } from 'node:fs/promises';
import { expect, request, test } from '@playwright/test';
import { type BookDetail, formatDay } from '@bookclub/shared';
import { browserAs, clubWithAlice, expectInFooter, putProgress } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

const at = (section: number, offset: number) => ({ kind: 'epub' as const, section, offset });

/** A calendar day some days from now, as the date field takes it. */
function dayFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test.describe('the next stop: how far to read before talking it over', () => {
  test('a friend sets it; everyone sees it at once, who is there and how far each has to go', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] };
    const section = (n: string) => pub.toc.find((e) => e.title.startsWith(`CHAPTER ${n}.`))!.section;
    await putProgress(club.members.Ben!, book.id, epub.id, at(section('I'), 0), [{ from: at(section('I'), 0), to: at(section('I'), 400) }]);

    // Ben has the library open.
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}`);
    await expect(ben.getByTestId('book-card')).toHaveCount(1);
    await expect(ben.getByTestId('meeting-line')).toHaveCount(0);

    // Ana chooses the end of chapter 2, by a day three days from now.
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}`);
    await ana.getByTestId('meeting-set').click();
    const dialog = ana.getByRole('dialog', { name: 'The next stop' });
    // Each stop with its chapter's title; the stop is still saved and shown by its name.
    await dialog.getByLabel('Read up to').selectOption({ label: 'The end of Chapter 2 · The Pool of Tears' });
    const day = dayFromNow(3);
    await dialog.getByLabel('By (optional)').fill(day);
    await dialog.getByTestId('meeting-save').click();
    await expect(dialog).toHaveCount(0);
    const headline = `The end of Chapter 2, by ${formatDay(day)}`;
    await expect(ana.getByTestId('meeting-headline')).toHaveText(headline);
    await expect(ana.getByTestId('meeting')).toContainText('Set by you · 0 of 3 there');

    // Ben's library shows it at once, with the flag on the card's bar.
    await expect(ben.getByTestId('meeting-line')).toHaveText(` ${headline} · 0 of 3 there`, { timeout: 5000 });
    await expect(ben.getByTestId('book-card').getByTestId('meeting-flag')).toHaveCount(1);

    // On the book page: the flag on the club bar, his way to it, and about how long that is.
    await ben.goto(`/books/${book.id}`);
    await expect(ben.getByRole('img', { name: `Next stop: ${headline}` })).toBeVisible();
    await expect(ben.getByTestId('meeting')).toContainText('Set by Ana');
    const benRow = ben.locator(`[data-testid="meeting-member"][data-user="${club.members.Ben!.id}"]`);
    await expect(benRow).toContainText('You');
    await expect(benRow).toContainText('2 chapters to go');
    await expect(ben.getByTestId('meeting-time')).toHaveText(/^About (\d+ min|\d+ h( \d+ min)?|under a minute) of reading or (\d+ min|\d+ h( \d+ min)?|under a minute) of listening to go\.$/);

    // Ben reads into chapter 3: Ana sees him there, live.
    const detail = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    expect(detail.meeting?.label).toBe('the end of Chapter 2');
    await putProgress(club.members.Ben!, book.id, epub.id, at(section('III'), 20), [{ from: at(section('I'), 0), to: at(section('III'), 20) }]);
    const benOnAna = ana.locator(`[data-testid="meeting-member"][data-user="${club.members.Ben!.id}"]`);
    await expect(benOnAna).toHaveAttribute('data-there', 'true', { timeout: 5000 });
    await expect(benOnAna).toContainText('there');
    await expect(ana.getByTestId('meeting')).toContainText('1 of 3 there');

    // Ana clears it: gone from Ben's screen too.
    await ana.getByTestId('meeting-clear').click();
    await answerQuestion(ana, 'Clear the next stop?', 'Clear');
    await expect(ana.getByTestId('meeting-set')).toBeVisible();
    await expect(ben.getByRole('img', { name: /^Next stop:/ })).toHaveCount(0, { timeout: 5000 });
    await expect(ben.getByTestId('meeting-set')).toBeVisible();
    await Promise.all([anaCtx.close(), benCtx.close()]);
  });

  test('turning the page past the next stop greets you, with who is there already', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] };
    const ch1 = pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section;
    const ch2 = pub.toc.find((e) => e.title.startsWith('CHAPTER II.'))!.section;
    // Ana is already past the end of chapter 1; the stop is there.
    await putProgress(club.members.Ana!, book.id, epub.id, at(ch2, 300), [{ from: at(ch1, 0), to: at(ch2, 300) }]);
    const stops = ((await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail).chapters;
    const end1 = stops.find((c) => c.title.startsWith('CHAPTER II.'))!.t;
    expect((await club.members.Ana!.api.put(`/api/books/${book.id}/meeting`, { data: { t: end1, on: null } })).status()).toBe(200);

    const ctx = await browserAs(browser, club.members.Ben!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    // To the last page of chapter 1, then on into chapter 2.
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER II\./ }).click();
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-section', String(ch2), { timeout: 15_000 });
    await page.getByTestId('prev-page').click();
    await expect(reader).toHaveAttribute('data-section', String(ch1));
    await expect(page.getByTestId('meeting-reached')).toHaveCount(0);
    // He reads from there: past where he has read, it is a look until he says so (D72).
    await page.getByTestId('read-from-here').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await page.getByTestId('next-page').click();
    const card = page.getByTestId('meeting-reached');
    await expect(card).toContainText('You’re at the next stop, with Ana.');
    await expect(card.locator('span').first()).toHaveAttribute('title', 'The club’s next stop: the end of Chapter 1');
    // Like the chapter's end card, it covers the footer, never the text of the new chapter, and
    // its buttons are inside it…
    await expectInFooter(page, card);
    // …and goes with the next page turn (a tap on the right of the page).
    const box = (await page.locator('.epub-viewport').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    await expect(card).toHaveCount(0);
    await ctx.close();
  });
});

test.describe('the next stop greets readers of the PDF and listeners too', () => {
  test('turning the PDF’s page past the stop, and listening past it, greet you as the EPUB does', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { pdf: true, audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] };
    const ch1 = pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section;
    const ch2 = pub.toc.find((e) => e.title.startsWith('CHAPTER II.'))!.section;
    await putProgress(club.members.Ana!, book.id, epub.id, at(ch2, 300), [{ from: at(ch1, 0), to: at(ch2, 300) }]);
    const detail = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    const end1 = detail.chapters.find((c) => c.title.startsWith('CHAPTER II.'))!.t;
    expect((await club.members.Ana!.api.put(`/api/books/${book.id}/meeting`, { data: { t: end1, on: null } })).status()).toBe(200);

    // Ben in the PDF: to chapter II, a page back, and on again.
    const ctx = await browserAs(browser, club.members.Ben!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER II\./ }).click();
    const n = page.getByTestId('page-number');
    const first = Number(await n.getAttribute('data-page'));
    await page.getByTestId('prev-page').click();
    await expect(n).toHaveAttribute('data-page', String(first - 1));
    await expect(page.getByTestId('meeting-reached')).toHaveCount(0);
    // He reads from there: past where he has read, it is a look until he says so (D72).
    await page.getByTestId('read-from-here').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('meeting-reached')).toContainText('You’re at the next stop, with Ana.');
    await expectInFooter(page, page.getByTestId('meeting-reached'));

    // Ben listening: back to chapter I's track, which plays to its end, into chapter II.
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await page.getByTestId('toggle-tracks').click();
    await page.locator('.track-item').nth(0).click();
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '0');
    // A chapter from the list is a look until Play (D72).
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await expect(page.getByTestId('meeting-reached')).toContainText('You’re at the next stop, with Ana.', { timeout: 30_000 });
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '1');
    await ctx.close();
  });
});

test.describe('meet-ups: when and where the club meets, who is coming, and a calendar (D206, D207)', () => {
  test('a meet-up (D206, D207): an evening and a place, who is coming, live, and a calendar to keep it in', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    // Ana is in New York and Ben in London: each sees the evening on their own clock.
    const anaCtx = await browserAs(browser, club.members.Ana!, { timezoneId: 'America/New_York', acceptDownloads: true });
    const benCtx = await browserAs(browser, club.members.Ben!, { timezoneId: 'Europe/London' });
    const ana = await anaCtx.newPage();
    const ben = await benCtx.newPage();
    await ana.goto(`/books/${book.id}`);
    await ana.getByTestId('meeting-set').click();
    const dialog = ana.getByRole('dialog', { name: 'The next stop' });
    await dialog.getByLabel('Read up to').selectOption({ label: 'The end of Chapter 2 · The Pool of Tears' });
    const day = dayFromNow(3);
    await dialog.getByLabel('By (optional)').fill(day);
    await dialog.getByLabel('Time (optional)').fill('19:30');
    await dialog.getByLabel('For about').selectOption({ label: '2 hours' });
    await dialog.getByRole('radio', { name: 'Somewhere: a home, a café' }).check();
    await dialog.getByLabel('The place').fill('Ana’s, 12 Elm Street');
    await dialog.getByTestId('meeting-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(ana.getByTestId('meeting-headline')).toHaveText(`The end of Chapter 2, by ${formatDay(day)}, 7:30 pm`);
    await expect(ana.getByTestId('meetup-place')).toHaveText(' Ana’s, 12 Elm Street');

    // The server keeps the instant: half past seven in New York.
    const saved = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    expect(saved.meeting).toMatchObject({ on: day, tz: 'America/New_York', minutes: 120, place: { kind: 'place', value: 'Ana’s, 12 Elm Street' } });
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(new Date(saved.meeting!.at!));
    expect(parts).toBe('19:30');

    // Ben, in London, sees it on his clock and on Ana's, and says he is coming.
    await ben.goto(`/books/${book.id}`);
    await expect(ben.getByTestId('meeting-headline')).toContainText('7:30 pm in New York');
    await ben.getByTestId('rsvp-yes').click();
    await expect(ben.getByTestId('rsvp-yes')).toHaveAttribute('aria-pressed', 'true');
    await expect(ben.getByTestId('rsvp-summary')).toHaveText('You are coming');
    // Ana sees it at once, and her library says one is coming.
    await expect(ana.getByTestId('rsvp-summary')).toHaveText('Ben is coming', { timeout: 5000 });
    await ana.goto(`/clubs/${club.id}`);
    await expect(ana.getByTestId('meeting-line')).toContainText('· 1 coming');

    // "Add to calendar" downloads the evening, in UTC, with its reminders.
    await ana.goto(`/books/${book.id}`);
    const [download] = await Promise.all([ana.waitForEvent('download'), ana.getByTestId('meetup-ics').click()]);
    const ics = (await readFile(await download.path(), 'utf8')).replace(/\r\n /g, '');
    const start = new Date(saved.meeting!.at!).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(ics).toContain(`DTSTART:${start}`);
    expect(ics).toContain('LOCATION:Ana’s\\, 12 Elm Street');
    expect(ics).toContain('TRIGGER:-PT1H');

    // Settings gives Ben a private calendar address that lists it, without signing in.
    await ben.goto('/settings');
    await ben.getByTestId('calendar-feed-make').click();
    const url = await ben.getByTestId('calendar-feed-url').inputValue();
    expect(url).toMatch(/\/api\/calendar\/[A-Za-z0-9_-]{32}\/meetups\.ics$/);
    await expect(ben.getByTestId('calendar-feed-subscribe')).toHaveAttribute('href', url.replace(/^https?:/, 'webcal:'));
    const feed = await request.newContext();
    try {
      const res = await feed.get(url);
      expect(res.status()).toBe(200);
      expect((await res.text()).replace(/\r\n /g, '')).toContain(`UID:meetup-${book.id}@`);
    } finally {
      await feed.dispose();
    }
    await Promise.all([anaCtx.close(), benCtx.close()]);
  });
});
