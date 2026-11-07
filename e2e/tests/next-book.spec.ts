import { expect, test } from '@playwright/test';
import { browserAs, makeClub } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

/**
 * Picking the next book (D214): nominate, approval-vote, one open round at a time, Up next on the
 * library page, and importing a Goodreads or StoryGraph to-read shelf (D216).
 */

test.describe('picking the next book', () => {
  test('two friends nominate and vote, live; one closes the round; Up next shows on the library page for both', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben']);

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();

    // Ben has the picker open already, before anyone has nominated anything.
    await ben.goto(`/clubs/${club.id}/next-book`);
    await expect(ben.getByRole('heading', { name: 'Nothing nominated yet' })).toBeVisible();

    // Ana nominates from the club page's own link into the picker.
    await ana.goto(`/clubs/${club.id}`);
    await ana.getByTestId('open-next-book').click();
    await expect(ana).toHaveURL(new RegExp(`/clubs/${club.id}/next-book$`));
    await ana.getByLabel('Title').fill('Piranesi');
    await ana.getByLabel('Author (optional)').fill('Susanna Clarke');
    await ana.getByLabel('Link (optional)').fill('https://www.goodreads.com/book/show/50202953');
    await ana.getByLabel('Why we should read it (optional)').fill('A strange house, a kind narrator.');
    await ana.getByTestId('nomination-submit').click();
    const piranesi = ana.getByTestId('nomination').filter({ hasText: 'Piranesi' });
    await expect(piranesi).toBeVisible();
    await expect(piranesi.getByTestId('nomination-link-out')).toHaveAttribute('href', 'https://www.goodreads.com/book/show/50202953');

    // It reaches Ben without a reload (D214's live wire is the same club:changed hub already uses).
    const piranesiOnBen = ben.getByTestId('nomination').filter({ hasText: 'Piranesi' });
    await expect(piranesiOnBen).toBeVisible({ timeout: 5000 });
    await expect(piranesiOnBen).toContainText('Nominated by Ana');

    // Ben nominates a second book and votes for Ana's; Ana sees his vote land live.
    await ben.getByLabel('Title').fill('The Fraud');
    await ben.getByTestId('nomination-submit').click();
    await expect(ben.getByTestId('nomination').filter({ hasText: 'The Fraud' })).toBeVisible();
    await piranesiOnBen.getByTestId('vote-toggle').click();
    await expect(piranesiOnBen.getByTestId('vote-toggle')).toContainText('Voted · 1');
    await expect(piranesi.getByTestId('vote-toggle')).toContainText('Vote · 1', { timeout: 5000 });
    await expect(piranesi).toContainText('Voted by Ben');

    // Ana votes for her own too, so it clearly leads (no tie to break).
    await piranesi.getByTestId('vote-toggle').click();
    await expect(piranesi.getByTestId('vote-toggle')).toContainText('Voted · 2');

    // Only the owner or whoever opened the round may close it: Ana's nomination opened this
    // round, so Ben — neither the opener nor the owner — has no close control.
    await expect(ben.getByTestId('close-round-submit')).toHaveCount(0);

    // The owner closes it: a single leader needs no tie-break.
    const owner = await browserAs(browser, club.owner);
    const olive = await owner.newPage();
    await olive.goto(`/clubs/${club.id}/next-book`);
    await olive.getByTestId('close-round-submit').click();
    await expect(olive.getByText('won the vote', { exact: false })).toBeVisible();
    await expect(olive.getByTestId('up-next-detail')).toContainText('Piranesi');
    await expect(olive.getByTestId('round-history')).toContainText('Piranesi');

    // Ben, still on the picker and not the one who closed it, is told live too (D214/D217):
    // everyone looking gets the same push, not just whoever's own close just landed.
    await expect(ben.getByText('won the vote', { exact: false })).toBeVisible({ timeout: 5000 });
    await expect(ben.getByTestId('up-next-detail')).toContainText('Piranesi');

    // Up next shows on the library page for both friends, with a way back into the picker.
    await ana.goto(`/clubs/${club.id}`);
    await expect(ana.getByTestId('up-next')).toContainText('Piranesi');
    await ana.getByTestId('up-next-open-picker').click();
    await expect(ana).toHaveURL(new RegExp(`/clubs/${club.id}/next-book$`));

    await ben.goto(`/clubs/${club.id}`);
    await expect(ben.getByTestId('up-next')).toContainText('Piranesi');
    await expect(ben.getByTestId('up-next-clear')).toHaveCount(0); // a member, not the owner

    // The owner marks it done; Ana, still on the picker page, loses it live too.
    await olive.goto(`/clubs/${club.id}`);
    await olive.getByTestId('up-next-clear').click();
    await answerQuestion(olive, 'Mark Up next as done?', 'Mark done');
    await expect(olive.getByTestId('up-next')).toHaveCount(0);
    await expect(ana.getByTestId('up-next-detail')).toHaveCount(0, { timeout: 5000 });

    await Promise.all([anaCtx.close(), benCtx.close(), owner.close()]);
  });

  test('a tie is broken by whoever closes, among the tied; withdrawing and removing a nomination', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    const ownerCtx = await browserAs(browser, club.owner);
    const olive = await ownerCtx.newPage();

    await ana.goto(`/clubs/${club.id}/next-book`);
    await ana.getByLabel('Title').fill('A Tale of Two Choices');
    await ana.getByTestId('nomination-submit').click();
    await expect(ana.getByTestId('nomination').filter({ hasText: 'A Tale of Two Choices' })).toBeVisible();
    await ana.getByLabel('Title').fill('To Be Withdrawn');
    await ana.getByTestId('nomination-submit').click();
    await expect(ana.getByTestId('nomination').filter({ hasText: 'To Be Withdrawn' })).toBeVisible();
    await ana.getByLabel('Title').fill('Owner Will Remove This');
    await ana.getByTestId('nomination-submit').click();
    await expect(ana.getByTestId('nomination').filter({ hasText: 'Owner Will Remove This' })).toBeVisible();

    await ben.goto(`/clubs/${club.id}/next-book`);
    await ben.getByLabel('Title').fill('The Other Choice');
    await ben.getByTestId('nomination-submit').click();

    // Ana withdraws her own extra nomination; nobody else may touch it while it stood.
    const withdrawn = ana.getByTestId('nomination').filter({ hasText: 'To Be Withdrawn' });
    await withdrawn.getByTestId('nomination-withdraw').click();
    await answerQuestion(ana, 'Withdraw this nomination?', 'Withdraw');
    await expect(ana.getByTestId('nomination').filter({ hasText: 'To Be Withdrawn' })).toHaveCount(0);

    // The owner removes a nomination that is not theirs (D214: the owner moderates any).
    await olive.goto(`/clubs/${club.id}/next-book`);
    await olive.getByTestId('nomination').filter({ hasText: 'Owner Will Remove This' }).getByTestId('nomination-withdraw').click();
    await answerQuestion(olive, 'Remove this nomination?', 'Remove');
    await expect(olive.getByTestId('nomination').filter({ hasText: 'Owner Will Remove This' })).toHaveCount(0);

    // Ben ties the two that are left.
    const choiceA = ben.getByTestId('nomination').filter({ hasText: 'A Tale of Two Choices' });
    const choiceB = ben.getByTestId('nomination').filter({ hasText: 'The Other Choice' });
    await choiceA.getByTestId('vote-toggle').click();
    await choiceB.getByTestId('vote-toggle').click();

    // The owner's close control shows the tie and refuses to close until one is chosen.
    const close = olive.getByTestId('close-round');
    await expect(close).toContainText('tied for the most votes', { timeout: 5000 });
    const submit = olive.getByTestId('close-round-submit');
    await expect(submit).toBeDisabled();
    await close.getByLabel('The Other Choice').check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(olive.getByTestId('up-next-detail')).toContainText('The Other Choice');
    await expect(olive.getByTestId('round-history')).toContainText('The Other Choice');

    await Promise.all([anaCtx.close(), benCtx.close(), ownerCtx.close()]);
  });

  test('importing a Goodreads to-read shelf, client-side, picks nominations from it', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}/next-book`);

    // A small synthetic Goodreads export (never a real person's data): one to-read, one not.
    const csv =
      'Book Id,Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf\n' +
      '1,"Wonder, Boy",Nora Finch,="0141439512",="9780141439518",0,to-read\n' +
      '2,Already Read,Someone Else,,,5,read\n' +
      '3,A Second Pick,Nora Finch,,,0,to-read\n';

    await page.getByTestId('import-shelf').click();
    const modal = page.getByRole('dialog', { name: 'Import your to-read shelf' });
    await expect(modal).toBeVisible();
    await modal.getByTestId('shelf-csv-input').setInputFiles({ name: 'goodreads_library_export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(modal.getByTestId('shelf-import-list')).toBeVisible();
    await expect(modal.getByTestId('shelf-import-item')).toHaveCount(2);
    await expect(modal).toContainText('2 to-read of 3 books, from Goodreads.');

    // Only "Wonder, Boy" is nominated: "A Second Pick" is unchecked first.
    await modal.getByTestId('shelf-import-item').nth(1).uncheck();
    await modal.getByTestId('shelf-import-submit').click();
    await expect(modal).toHaveCount(0);

    await expect(page.getByTestId('nomination').filter({ hasText: 'Wonder, Boy' })).toBeVisible();
    await expect(page.getByTestId('nomination').filter({ hasText: 'Wonder, Boy' })).toContainText('Nora Finch');
    await expect(page.getByTestId('nomination').filter({ hasText: 'A Second Pick' })).toHaveCount(0);
    await expect(page.getByTestId('nomination')).toHaveCount(1);

    await ctx.close();
  });
});
