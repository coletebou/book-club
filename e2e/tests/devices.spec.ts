import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, placeSaved, putProgress, serverPlace } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

async function openReader(page: Page, bookId: string) {
  await page.goto(`/books/${bookId}/read`);
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

/**
 * The same reader on two devices: a phone left open at an old page while the laptop read on. The
 * laptop's reading is saved through the API, as the laptop's reader saves it.
 */
test.describe('reading on two devices', () => {
  const later = { kind: 'epub' as const, section: 9, offset: 0 };

  test('a place saved on another device is your place on this one: a page turned here never puts the old one back', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const phone = await ctx.newPage();
    await openReader(phone, book.id);
    await phone.getByTestId('next-page').click();
    await placeSaved(phone, book.id);
    const phoneSection = Number(await phone.getByTestId('reader').getAttribute('data-section'));

    // The laptop reads on, several chapters further.
    await putProgress(club.owner, book.id, epub.id, later, [{ from: { kind: 'epub', section: phoneSection, offset: 0 }, to: later }]);
    // The phone hears of it at once, and says so.
    await expect(phone.getByText(/You read on to .+ on another device\./)).toBeVisible({ timeout: 10_000 });
    const chip = phone.getByTestId('look-chip');
    await expect(chip).toHaveAttribute('data-elsewhere', 'true');
    await expect(chip.getByTestId('back-to-reading')).toContainText('Continue at Chapter');

    // A page turned here is a look: the newer place stays saved.
    await phone.getByTestId('next-page').click();
    await phone.waitForTimeout(1500);
    expect(await serverPlace(phone, book.id)).toMatchObject(later);

    // Continue: the book opens where the laptop left it.
    await chip.getByTestId('back-to-reading').click();
    await expect(phone.getByTestId('reader')).toHaveAttribute('data-section', String(later.section));
    await expect(phone.getByTestId('look-chip')).toHaveCount(0);
    expect(await serverPlace(phone, book.id)).toMatchObject(later);
    await ctx.close();
  });

  test('"Stay here" makes the page in front of you your place again, as a choice', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const phone = await ctx.newPage();
    await openReader(phone, book.id);
    await phone.getByTestId('next-page').click();
    await placeSaved(phone, book.id);
    const phoneSection = Number(await phone.getByTestId('reader').getAttribute('data-section'));
    await putProgress(club.owner, book.id, epub.id, later, [{ from: { kind: 'epub', section: phoneSection, offset: 0 }, to: later }]);
    const chip = phone.getByTestId('look-chip');
    await expect(chip).toHaveAttribute('data-elsewhere', 'true', { timeout: 10_000 });
    await chip.getByTestId('read-from-here').click();
    await expect(phone.getByTestId('look-chip')).toHaveCount(0);
    await placeSaved(phone, book.id);
    expect(await serverPlace(phone, book.id)).toMatchObject({ kind: 'epub', section: phoneSection });
    await ctx.close();
  });

  test('in the PDF too: the place read on elsewhere is offered, and nothing here puts the old page back', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const phone = await ctx.newPage();
    await phone.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(phone.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
    await phone.getByTestId('next-page').click();
    await expect.poll(async () => (await serverPlace(phone, book.id)) as { page?: number } | null, { timeout: 10_000 }).toMatchObject({ page: 1 });
    const laptop = { kind: 'pdf' as const, page: 40, y: 0 };
    await putProgress(club.owner, book.id, pdf.id, laptop, [{ from: { kind: 'pdf', page: 1, y: 0 }, to: laptop }]);
    const chip = phone.getByTestId('look-chip');
    await expect(chip).toHaveAttribute('data-elsewhere', 'true', { timeout: 10_000 });
    await expect(chip.getByTestId('back-to-reading')).toContainText('Continue at page 41');
    await phone.getByTestId('next-page').click();
    await phone.waitForTimeout(1500);
    expect(await serverPlace(phone, book.id)).toMatchObject({ page: 40 });
    await chip.getByTestId('back-to-reading').click();
    await expect(phone.getByTestId('reader')).toHaveAttribute('data-page-index', '40');
    await ctx.close();
  });

  test('"I\u2019ve already read up to here" is this device\u2019s own news too, not another device\u2019s', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    for (let i = 0; i < 2; i++) await page.getByTestId('next-page').click();
    await page.getByTestId('open-toc').click();
    await page.getByTestId('read-up-to-here').click();
    await answerQuestion(page, 'Mark everything up to this page as read?', 'Mark as read');
    await expect(page.getByText(/now open to you|Marked as read up to here/)).toBeVisible({ timeout: 10_000 });
    // Long enough for the club's news of it to have come back.
    await page.waitForTimeout(2000);
    await expect(page.getByText(/on another device/)).toHaveCount(0);
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await ctx.close();
  });

  test('pages turned on this device are its own news: no "another device" for them', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    for (let i = 0; i < 4; i++) {
      await page.getByTestId('next-page').click();
      await placeSaved(page, book.id);
    }
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await expect(page.getByText(/on another device/)).toHaveCount(0);
    await ctx.close();
  });
});
