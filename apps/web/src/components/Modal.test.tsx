import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Dialogs({ inner, onOuter, onInner }: { inner: boolean; onOuter: () => void; onInner: () => void }) {
  return (
    <>
      <Modal title="Add a book" onClose={onOuter}>
        <button type="button">Cancel the upload</button>
      </Modal>
      {inner ? (
        <Modal title="Stop this upload?" onClose={onInner} role="alertdialog" describedBy="why">
          <p id="why">What was sent so far is discarded.</p>
          <button type="button">Keep uploading</button>
        </Modal>
      ) : null}
    </>
  );
}

describe('a dialog over another', () => {
  it('takes the keyboard: Escape closes it alone, then the one below again', () => {
    const onOuter = vi.fn();
    const onInner = vi.fn();
    const { rerender } = render(<Dialogs inner onOuter={onOuter} onInner={onInner} />);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onOuter).not.toHaveBeenCalled();
    rerender(<Dialogs inner={false} onOuter={onOuter} onInner={onInner} />);
    // Focus is back in the dialog below, where it was before the other opened.
    expect(screen.getByRole('dialog', { name: 'Add a book' }).contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onOuter).toHaveBeenCalledTimes(1);
    expect(onInner).toHaveBeenCalledTimes(1);
  });

  it('a question is an alert dialog, described by what it says', () => {
    render(<Dialogs inner onOuter={() => undefined} onInner={() => undefined} />);
    const question = screen.getByRole('alertdialog', { name: 'Stop this upload?' });
    expect(question.getAttribute('aria-describedby')).toBe('why');
    expect(question.getAttribute('aria-modal')).toBe('true');
    // The dialog below keeps its role and has no description.
    expect(screen.getByRole('dialog', { name: 'Add a book' }).hasAttribute('aria-describedby')).toBe(false);
  });
});

/** A phone's visual viewport: what is seen of the page, which the keyboard shortens. */
class SeenArea extends EventTarget {
  height = 844;
  offsetTop = 0;
  scale = 1;
  set(next: Partial<Pick<SeenArea, 'height' | 'offsetTop' | 'scale'>>) {
    Object.assign(this, next);
    this.dispatchEvent(new Event('resize'));
  }
}

describe('a sheet with the keyboard up (D88)', () => {
  it('sits in the part of the screen still seen, so its text box and its Post button are above the keys', () => {
    const seen = new SeenArea();
    vi.stubGlobal('visualViewport', seen);
    vi.stubGlobal('innerHeight', 844);
    render(
      <Modal title="Leave a note" onClose={() => undefined}>
        <textarea aria-label="Your note" />
      </Modal>,
    );
    const backdrop = screen.getByRole('dialog').parentElement!;
    expect(backdrop.style.getPropertyValue('--seen-bottom')).toBe('0px');
    // The keyboard: 336 px of the screen's bottom, and iOS has panned 40 px to the text box.
    act(() => seen.set({ height: 508, offsetTop: 40 }));
    expect([backdrop.style.getPropertyValue('--seen-top'), backdrop.style.getPropertyValue('--seen-bottom'), backdrop.style.getPropertyValue('--seen-height')]).toEqual(['40px', '296px', '508px']);
    // Zoomed in, the page is left as it is.
    act(() => seen.set({ height: 400, offsetTop: 120, scale: 2 }));
    expect([backdrop.style.getPropertyValue('--seen-top'), backdrop.style.getPropertyValue('--seen-bottom')]).toEqual(['0px', '0px']);
  });

  it('without a visual viewport (an older browser), stays as it was', () => {
    vi.stubGlobal('visualViewport', undefined);
    render(<Modal title="Leave a note" onClose={() => undefined}>x</Modal>);
    expect(screen.getByRole('dialog').parentElement!.style.getPropertyValue('--seen-bottom')).toBe('');
  });
});
