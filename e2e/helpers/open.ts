import { type Locator, type Page, expect } from '@playwright/test';
import type { BookDetail, Edition } from '@bookclub/shared';

/*
 * Into a book as a person goes since D198 (one Continue, Book settings, no audio-only by default):
 *
 * - The book page has one way in: "Open" before you have a place in the book, "Continue" after. It
 *   opens the text you were in last, else the one the audiobook you heard is lined up with, else the
 *   EPUB, and the same tap starts the audiobook over it if you were last listening and have not
 *   hidden it. A book that is only an audiobook opens in the player. There is no button for each
 *   format: a test of a reader that is not the one Continue opens (a PDF beside an EPUB) goes
 *   straight to its address, `/books/:id/read?edition=…`, where that format's button went before.
 * - The book's formats (each with its offline toggle and its owner's menu), "Hide the audiobook in
 *   this book" and "Add a format" are in Book settings, the gear beside it.
 * - The audiobook plays over the page from the reader's footer (Listen, D197). The full player of a
 *   book with a text is behind Settings → Listening → "Allow audio-only view", off by default:
 *   `browserAs(…, { audioOnlyView: true })` is a device where it is on.
 */

/** What the book page's one way in says, and what it opens. */
export interface WayIn {
  /** "Open" before you have a place in the book (or one at its very start), "Continue" after. */
  readonly label?: 'Open' | 'Continue';
  /** The format it opens: a text, or the audiobook of a book that has no text. */
  readonly kind?: Edition['kind'];
  /** Whether the same tap starts the audiobook over the text (you were last listening). */
  readonly along?: boolean;
}

/** The book page's one way in (D198). */
export function continueButton(page: Page): Locator {
  return page.getByTestId('open-continue');
}

function onBookPage(page: Page, bookId: string): boolean {
  return new URL(page.url()).pathname === `/books/${bookId}`;
}

/**
 * Into the book by its page's one way in (D198), the book page opened first unless it is already
 * on screen. What the test says of the button is checked before it is tapped: its label, the
 * format it opens, whether it starts the audiobook along. Each check waits, as the button changes
 * once your place has loaded (until then it says Open, into the EPUB), so a test never reads
 * another format than it means unawares. Resolves once the reader or the player is the page's
 * address; what to wait for there is the caller's.
 */
export async function openFromBookPage(page: Page, book: Pick<BookDetail, 'id' | 'editions'>, way: WayIn = {}): Promise<void> {
  if (!onBookPage(page, book.id)) await page.goto(`/books/${book.id}`);
  const button = continueButton(page);
  await expect(button).toHaveCount(1);
  if (way.label) await expect(button).toHaveText(way.label);
  if (way.kind) {
    const edition = book.editions.find((e) => e.kind === way.kind && e.status === 'ready');
    if (!edition) throw new Error(`the book has no ${way.kind} ready to open`);
    const route = way.kind === 'audio' ? 'listen' : 'read';
    await expect(button, `the book page's way in opens its ${way.kind}`).toHaveAttribute('href', new RegExp(`^/books/${book.id}/${route}\\?edition=${edition.id}(&|$)`));
  }
  if (way.along !== undefined) {
    await expect(button, `the book page's way in ${way.along ? 'starts' : 'does not start'} the audiobook along`).toHaveAttribute('href', way.along ? /[?&]along=/ : /^(?!.*[?&]along=)/);
  }
  await button.click();
  await expect(page).toHaveURL(new RegExp(`/books/${book.id}/(read|listen)(\\?|$)`));
}

/**
 * An address in the app, gone to as one of its own links goes (a history entry the router follows,
 * as the app itself opens a notification's link from outside React: `installNativeNavigationBridge`),
 * not by loading the page again: the live connection and the player stay as they were. For a
 * format the book page has no button for since D198 (a PDF beside an EPUB: the old "Read the PDF"
 * went to this same address), in a test that is not about the book page.
 */
export async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    // As the router's own pushes are: its key and the next index, which a popstate then follows.
    const idx = ((history.state as { idx?: number } | null)?.idx ?? 0) + 1;
    const state = { usr: null, key: Math.random().toString(36).slice(2, 10), idx };
    history.pushState(state, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state }));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

/**
 * The book page's Book settings (D198), from its gear: the book's formats (each one's offline
 * toggle, and its owner's menu), "Hide the audiobook in this book" and "Add a format".
 */
export async function openBookSettings(page: Page): Promise<Locator> {
  await page.getByTestId('open-book-settings').click();
  const sheet = page.getByRole('dialog', { name: 'Book settings' });
  await expect(sheet.getByTestId('book-settings')).toBeVisible();
  return sheet;
}

/**
 * Listen over the page, from a reader's footer (D197): the audiobook starts at the page you are
 * reading, in that tap, playing at once, docked under the page.
 */
export async function listenFromThisPage(page: Page): Promise<void> {
  const listen = page.getByTestId('listen-here');
  // In the footer once the reader has its page (as long as the page numbers can take).
  await expect(listen).toBeVisible({ timeout: 30_000 });
  await listen.click();
  await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
}
