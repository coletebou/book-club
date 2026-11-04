import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../components/Modal';
import { askToDelete, confirmAction } from './confirm';

afterEach(() => {
  cleanup();
  // Every test answers what it asked: nothing is left on screen for the next one.
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

const DELETE_NOTE = { title: 'Delete your note?', body: 'It goes for everyone in the club.', confirm: 'Delete', cancel: 'Keep', danger: true } as const;

/** Ask, and wait until the question is on screen (the answer is wrapped, or awaiting this would wait for it). */
async function ask(options: Parameters<typeof confirmAction>[0]): Promise<{ answer: Promise<boolean> }> {
  let answer!: Promise<boolean>;
  await act(async () => {
    answer = confirmAction(options);
  });
  return { answer };
}

const press = (key: string) =>
  act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
const tap = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
  });

describe('asking before something is done for good', () => {
  it('asks in a dialog of the app’s own: an alert dialog named by its question, saying what follows, the safe answer focused', async () => {
    const { answer } = await ask(DELETE_NOTE);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete your note?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('It goes for everyone in the club.');
    const keep = within(dialog).getByRole('button', { name: 'Keep' });
    expect(document.activeElement).toBe(keep);
    // The answer that does it, in the danger colour; the close button is there too.
    expect(within(dialog).getByRole('button', { name: 'Delete' }).className).toContain('btn-danger');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
    await tap(within(dialog).getByRole('button', { name: 'Delete' }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('answers no to the safe answer, Escape, the close button and the backdrop', async () => {
    let { answer } = await ask(DELETE_NOTE);
    await tap(screen.getByRole('button', { name: 'Keep' }));
    await expect(answer).resolves.toBe(false);

    ({ answer } = await ask(DELETE_NOTE));
    await press('Escape');
    await expect(answer).resolves.toBe(false);

    ({ answer } = await ask(DELETE_NOTE));
    await tap(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close' }));
    await expect(answer).resolves.toBe(false);

    ({ answer } = await ask(DELETE_NOTE));
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('alertdialog').parentElement!);
    });
    await expect(answer).resolves.toBe(false);
  });

  it('without a body says only its question; the answers default to Cancel and a gold yes', async () => {
    const { answer } = await ask({ title: 'Mark everything up to this page as read?', confirm: 'Mark as read' });
    const dialog = screen.getByRole('alertdialog', { name: 'Mark everything up to this page as read?' });
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByRole('button', { name: 'Mark as read' }).className).toContain('btn-primary');
    await press('Escape');
    await expect(answer).resolves.toBe(false);
  });

  it('gives the focus back to what asked', async () => {
    render(<button type="button">Delete</button>);
    const opener = screen.getByRole('button', { name: 'Delete' });
    opener.focus();
    const { answer } = await ask(DELETE_NOTE);
    expect(document.activeElement).not.toBe(opener);
    await press('Escape');
    await expect(answer).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('asks one question at a time, in the order asked, as the browser’s own did', async () => {
    const { answer: first } = await ask({ title: 'Stop this upload?', confirm: 'Stop' });
    const { answer: second } = await ask({ title: 'Leave Thursday Readers?', confirm: 'Leave' });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByRole('alertdialog', { name: 'Stop this upload?' })).toBeTruthy();
    await tap(screen.getByRole('button', { name: 'Stop' }));
    await expect(first).resolves.toBe(true);
    expect(screen.getByRole('alertdialog', { name: 'Leave Thursday Readers?' })).toBeTruthy();
    await press('Escape');
    await expect(second).resolves.toBe(false);
  });

  it('is taken back, as a no, when what it was about is over', async () => {
    const over = new AbortController();
    const { answer } = await ask({ title: 'Stop this upload?', confirm: 'Stop', signal: over.signal });
    await act(async () => {
      over.abort();
    });
    await expect(answer).resolves.toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Over before it was asked: never shown.
    const { answer: late } = await ask({ title: 'Stop this upload?', confirm: 'Stop', signal: over.signal });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await expect(late).resolves.toBe(false);
  });

  it('a question taken back while another is on screen leaves that one alone', async () => {
    const over = new AbortController();
    const { answer: first } = await ask({ title: 'Delete your note?', confirm: 'Delete' });
    const { answer: second } = await ask({ title: 'Stop this upload?', confirm: 'Stop', signal: over.signal });
    await act(async () => {
      over.abort();
    });
    await expect(second).resolves.toBe(false);
    expect(screen.getByRole('alertdialog', { name: 'Delete your note?' })).toBeTruthy();
    await tap(screen.getByRole('button', { name: 'Delete' }));
    await expect(first).resolves.toBe(true);
    // Its question gone too, nothing is left: the one taken back does not come up after it.
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('going back (an iPhone’s swipe) answers no: the question was the page’s that is left', async () => {
    const { answer } = await ask(DELETE_NOTE);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(answer).resolves.toBe(false);
  });

  it('over another dialog, Escape answers the question only; that dialog then has the keyboard again', async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Contents" onClose={onClose}>
        <button type="button">I’ve already read up to here</button>
      </Modal>,
    );
    const { answer } = await ask({ title: 'Mark everything up to this page as read?', confirm: 'Mark as read' });
    await press('Escape');
    await expect(answer).resolves.toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Contents' })).toBeTruthy();
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('asking before a note or a reply goes', () => {
  it('says whose it is, that it goes for everyone, and keeps it unless told to delete it', async () => {
    const cases = [
      [{ userId: 'user_cole', authorName: 'Cole', parentId: null }, 'Delete your note?'],
      [{ userId: 'user_cole', authorName: 'Cole', parentId: 'note_1' }, 'Delete your reply?'],
      [{ userId: 'user_ana', authorName: 'Ana', parentId: null }, 'Delete Ana’s note?'],
      [{ userId: 'user_ana', authorName: 'Ana', parentId: 'note_1' }, 'Delete Ana’s reply?'],
    ] as const;
    for (const [comment, title] of cases) {
      let answer!: Promise<boolean>;
      await act(async () => {
        answer = askToDelete(comment, 'user_cole');
      });
      const dialog = screen.getByRole('alertdialog', { name: title });
      expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('It goes for everyone in the club.');
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep' }));
      await tap(within(dialog).getByRole('button', { name: 'Delete' }));
      await expect(answer).resolves.toBe(true);
    }
  });
});
