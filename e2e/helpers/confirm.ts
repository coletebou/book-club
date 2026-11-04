import { type Page, expect } from '@playwright/test';

/**
 * The app's own question before something is done for good (not the browser's confirm()), as a
 * member answers it: the dialog asking `question`, and its button `answer`. It is gone once
 * answered.
 */
export async function answerQuestion(page: Page, question: string | RegExp, answer: string): Promise<void> {
  const dialog = page.getByRole('alertdialog', { name: question });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: answer, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
