import { describe, expect, it, vi } from 'vitest';
import { handleKey } from './view';

function press(key: string, init: KeyboardEventInit = {}, target?: HTMLElement) {
  const view = { next: vi.fn(() => Promise.resolve()), prev: vi.fn(() => Promise.resolve()) };
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  if (target) {
    document.body.appendChild(target);
    target.addEventListener('keydown', (e) => handleKey(e, view), { once: true });
    target.dispatchEvent(event);
    target.remove();
  } else handleKey(event, view);
  return { next: view.next.mock.calls.length, prev: view.prev.mock.calls.length, prevented: event.defaultPrevented };
}

describe('handleKey (turning pages from the keyboard)', () => {
  it.each(['ArrowRight', 'PageDown', ' '])('turns to the next page with %j', (key) => {
    expect(press(key)).toEqual({ next: 1, prev: 0, prevented: true });
  });

  it.each([
    ['ArrowLeft', {}],
    ['PageUp', {}],
    [' ', { shiftKey: true }],
  ])('turns back with %j %j', (key, init) => {
    expect(press(key, init)).toEqual({ next: 0, prev: 1, prevented: true });
  });

  it.each(['ArrowUp', 'ArrowDown', 'Enter', 'a', 'Tab', 'Home'])('leaves %j to the browser', (key) => {
    expect(press(key)).toEqual({ next: 0, prev: 0, prevented: false });
  });

  it.each([{ altKey: true }, { ctrlKey: true }, { metaKey: true }])('leaves shortcuts with a modifier (%j) to the browser', (init) => {
    expect(press('ArrowRight', init)).toEqual({ next: 0, prev: 0, prevented: false });
  });

  it.each(['input', 'textarea', 'select'])('does not turn pages while typing in a %s (writing a note)', (tag) => {
    expect(press(' ', {}, document.createElement(tag))).toEqual({ next: 0, prev: 0, prevented: false });
    expect(press('ArrowLeft', {}, document.createElement(tag))).toEqual({ next: 0, prev: 0, prevented: false });
  });

  it('leaves the keys to a dialog open over the book (the finished card), and pages again once it closes', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    expect(press('ArrowRight')).toEqual({ next: 0, prev: 0, prevented: false });
    expect(press('ArrowLeft')).toEqual({ next: 0, prev: 0, prevented: false });
    dialog.remove();
    expect(press('ArrowRight')).toEqual({ next: 1, prev: 0, prevented: true });
  });

  it('ignores a key something else already handled', () => {
    const view = { next: vi.fn(() => Promise.resolve()), prev: vi.fn(() => Promise.resolve()) };
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    event.preventDefault();
    handleKey(event, view);
    expect(view.next).not.toHaveBeenCalled();
  });
});
