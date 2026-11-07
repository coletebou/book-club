import { expect, test } from '@playwright/test';
import { type BookDetail, meetingStops, tToLocator } from '@bookclub/shared';
import { browserAs, clubWithAlice, readUpTo } from '../helpers/api';

/**
 * What to talk about at the meet-up (D209): a friend who has read to the stop adds a question and
 * votes; a friend who has not sees only that one waits for them there, and sees it once they have.
 */
test.describe('questions for the meet-up (D209)', () => {
  test('a question is open to friends at the stop, and only counted for those not there yet', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const stop = meetingStops(book.chapters).find((s) => s.label === 'the end of Chapter 2')!;
    await club.owner.api.put(`/api/books/${book.id}/meeting`, { data: { t: stop.t, on: null } });
    const at = (t: number) => tToLocator({ geometry: epub.geometry!, sync: epub.sync! }, t);
    await readUpTo(club.members.Ana!, book.id, epub.id, at(stop.t));

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}`);
    const panel = ana.getByTestId('meetup-questions');
    await expect(panel).toContainText('at the end of Chapter 2');
    await panel.getByTestId('question-input').fill('Why does Alice keep changing size, do you think?');
    await panel.getByTestId('question-add').click();
    await expect(panel.getByTestId('meetup-question')).toHaveText(/Why does Alice keep changing size/);
    await panel.getByTestId('question-vote').click();
    await expect(panel.getByTestId('question-vote')).toHaveAttribute('aria-pressed', 'true');

    // Ben has not read that far: a count, never the words.
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}`);
    await expect(ben.getByTestId('questions-held')).toHaveText(' One more question opens for you at the end of Chapter 2.');
    await expect(ben.getByTestId('meetup-questions')).not.toContainText('changing size');
    // Read to the stop, it is his, with Ana's vote.
    await readUpTo(club.members.Ben!, book.id, epub.id, at(stop.t));
    await ben.reload();
    await expect(ben.getByTestId('meetup-question')).toHaveText(/Why does Alice keep changing size/);
    await expect(ben.getByTestId('question-vote')).toContainText('1');
    const detail = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    expect(detail.meeting?.label).toBe('the end of Chapter 2');
    await Promise.all([anaCtx.close(), benCtx.close()]);
  });
});
