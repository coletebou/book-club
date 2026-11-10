import { expect, test } from '@playwright/test';
import { type ClubDetail, formatBytes } from '@bookclub/shared';
import { browserAs, makeClub } from '../helpers/api';

/**
 * A club's plan (D208), as the stack under test is set up: with no limits (the demo, the default)
 * or with the host's limits and a way to Club Pro (BOOKCLUB_CLUB_* in deploy/.env). The test reads
 * the plan the server reports and checks the page says the same, either way.
 */
test.describe('a club’s plan (D208)', () => {
  test('owners and members see what the club stores and how many are in it; only an owner is offered Club Pro', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const plan = ((await (await club.owner.api.get(`/api/clubs/${club.id}`)).json()) as ClubDetail).plan;
    expect(plan.name).toBe('free');

    const ownerCtx = await browserAs(browser, club.owner);
    const page = await ownerCtx.newPage();
    await page.goto(`/clubs/${club.id}/settings`);
    const card = page.getByTestId('club-plan');
    await expect(card.getByRole('heading', { name: 'Plan' })).toBeVisible();
    const stored = plan.storage.maxBytes === null ? `${formatBytes(0)} stored` : `${formatBytes(0)} of ${formatBytes(plan.storage.maxBytes)} stored`;
    await expect(page.getByTestId('plan-storage')).toHaveText(stored);
    await expect(page.getByTestId('plan-members')).toHaveText(plan.members.max === null ? '2 members' : `2 of ${plan.members.max} members`);
    await expect(card.getByRole('meter')).toHaveCount((plan.storage.maxBytes === null ? 0 : 1) + (plan.members.max === null ? 0 : 1));
    if (plan.proUrl) {
      const link = card.getByTestId('plan-pro');
      await expect(link).toHaveAttribute('href', plan.proUrl);
      expect(new URL(plan.proUrl).searchParams.get('client_reference_id')).toBe(club.id);
    } else {
      await expect(card.getByTestId('plan-pro')).toHaveCount(0);
    }

    // A book counts as soon as its upload is declared.
    const upload = await club.owner.api.post(`/api/clubs/${club.id}/imports`, {
      data: { kind: 'epub', files: [{ name: 'alice.epub', size: 189_249, type: 'application/epub+zip', role: 'main' }] },
    });
    if (plan.storage.maxBytes !== null && plan.storage.maxBytes < 189_249) {
      expect(upload.status()).toBe(413);
      expect(((await upload.json()) as { error: { code: string } }).error.code).toBe('storage_full');
    } else {
      expect(upload.status()).toBe(201);
      // Declared, not yet sent: it already holds its room.
      await page.goto(`/clubs/${club.id}/settings`);
      await expect(page.getByTestId('plan-storage')).toContainText(formatBytes(189_249));
    }

    // Ana, a member, sees the same card, never the offer.
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/settings`);
    await expect(ana.getByTestId('club-plan')).toBeVisible();
    await expect(ana.getByTestId('plan-pro')).toHaveCount(0);
    await Promise.all([ownerCtx.close(), anaCtx.close()]);
  });
});
