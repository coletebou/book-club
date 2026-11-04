import { expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, postComment, putProgress } from '../helpers/api';

/*
 * Notes on nearby lines of a PDF page share one marker, as in the EPUB reader: no two touch
 * targets overlap, and every note can be opened (found after fidelity review round 16).
 */
test('in the PDF, notes a line apart share one marker that opens them all; one further down has its own', async ({ browser }) => {
  const { club, book } = await clubWithAlice(['Ana'], { pdf: true });
  const pdf = book.editions.find((e) => e.kind === 'pdf')!;
  const ana = club.members.Ana!;
  const page = { kind: 'pdf' as const, page: 4, y: 0 };
  await putProgress(ana, book.id, pdf.id, { ...page, y: 0.95 }, [{ from: page, to: { ...page, y: 0.95 } }]);
  for (const [y, text] of [[0.3, 'The bottle said DRINK ME'], [0.305, 'And so she did'], [0.8, 'Shutting up like a telescope']] as const) {
    await postComment(ana, book.id, { editionId: pdf.id, locator: { ...page, y }, text });
  }
  const ctx = await browserAs(browser, ana);
  const reader = await ctx.newPage();
  await reader.goto(`/books/${book.id}/read?edition=${pdf.id}`);
  await expect(reader.getByTestId('page-number')).toHaveAttribute('data-page', '5', { timeout: 30_000 });
  const markers = reader.getByTestId('margin-marker');
  await expect(markers).toHaveCount(2);
  await expect(markers.first()).toHaveAccessibleName('2 notes here from you');
  await expect(markers.first().locator('.marker-count')).toHaveText('2');
  // No two overlap.
  const [a, b] = [(await markers.nth(0).boundingBox())!, (await markers.nth(1).boundingBox())!];
  expect(a.y + a.height).toBeLessThanOrEqual(b.y);
  await markers.first().click();
  const sheet = reader.getByTestId('marker-sheet');
  await expect(sheet.getByTestId('sheet-note-text')).toHaveText(['The bottle said DRINK ME', 'And so she did']);
  await ctx.close();
});
