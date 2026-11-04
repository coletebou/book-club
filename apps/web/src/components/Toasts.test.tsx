import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_AFTER_HOLD_MS, TOAST_MS, ToastProvider, type ToastOptions, useToast } from './Toasts';

let say: (message: string, options?: ToastOptions | ToastOptions['tone']) => void = () => undefined;

function Speaker() {
  const toast = useToast();
  say = (message, options) => toast.show(message, options);
  return <button type="button">Elsewhere on the page</button>;
}

function setup() {
  render(
    <ToastProvider>
      <Speaker />
    </ToastProvider>,
  );
}

const shown = () => screen.queryAllByTestId('toast').filter((t) => !t.hidden);
const said = () => shown().map((t) => t.querySelector('.toast-text')!.textContent);
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('toasts', () => {
  it('say a message politely, in a region of their own, and let it go after a few seconds', () => {
    setup();
    const region = screen.getByRole('region', { name: 'Messages' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    act(() => say('Saved.'));
    expect(region.textContent).toBe('Saved.');
    // Nothing to do about it: no button.
    expect(screen.queryAllByRole('button')).toHaveLength(1);
    wait(TOAST_MS.info - 1);
    expect(shown()).toHaveLength(1);
    wait(1);
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('give an error a little longer', () => {
    setup();
    act(() => say('Could not save.', 'error'));
    expect(screen.getByTestId('toast').classList.contains('toast-error')).toBe(true);
    wait(TOAST_MS.info);
    expect(shown()).toHaveLength(1);
    wait(TOAST_MS.error - TOAST_MS.info);
    expect(shown()).toHaveLength(0);
  });

  it('carry one thing to do, which stays long enough to be tapped and does it', () => {
    setup();
    const run = vi.fn();
    act(() => say('Ben replied: “Me too!”', { action: { label: 'Show', run } }));
    expect(TOAST_MS.action).toBeGreaterThan(TOAST_MS.error);
    wait(TOAST_MS.action - 1);
    const show = screen.getByRole('button', { name: 'Show' });
    // A plain button, in the order of the page: reached with the keyboard.
    expect(show.tabIndex).toBe(0);
    fireEvent.click(show);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
    // Untouched, it goes in its time.
    act(() => say('Ana got to your note', { action: { label: 'Show', run } }));
    wait(TOAST_MS.action);
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed, by its button or with Escape, which gives the focus back where it was', () => {
    setup();
    const run = vi.fn();
    act(() => say('Ben replied', { action: { label: 'Show', run } }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
    act(() => say('Ben replied again', { action: { label: 'Show', run } }));
    const before = screen.getByRole('button', { name: 'Elsewhere on the page' });
    before.focus();
    const show = screen.getByRole('button', { name: 'Show' });
    act(() => show.focus());
    fireEvent.focus(show, { relatedTarget: before });
    fireEvent.keyDown(show, { key: 'Escape' });
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
    expect(document.activeElement).toBe(before);
    expect(run).not.toHaveBeenCalled();
  });

  it('wait while a mouse rests on them or they have the focus, then have a moment more', () => {
    setup();
    act(() => say('Ben replied', { action: { label: 'Show', run: () => undefined } }));
    const toast = screen.getByTestId('toast');
    wait(TOAST_MS.action - 500);
    fireEvent.pointerEnter(toast, { pointerType: 'mouse' });
    wait(60_000);
    expect(shown()).toHaveLength(1);
    fireEvent.pointerLeave(toast, { pointerType: 'mouse' });
    wait(TOAST_AFTER_HOLD_MS - 1);
    expect(shown()).toHaveLength(1);
    wait(1);
    expect(shown()).toHaveLength(0);

    act(() => say('Ana replied', { action: { label: 'Show', run: () => undefined } }));
    const show = screen.getByRole('button', { name: 'Show' });
    fireEvent.focus(show);
    wait(60_000);
    expect(shown()).toHaveLength(1);
    // Focus moving inside it is still in it.
    fireEvent.blur(show, { relatedTarget: screen.getByRole('button', { name: 'Dismiss' }) });
    wait(60_000);
    expect(shown()).toHaveLength(1);
    // Focused at once, it has its whole time left once the focus goes.
    fireEvent.blur(screen.getByRole('button', { name: 'Dismiss' }), { relatedTarget: null });
    wait(TOAST_MS.action - 1);
    expect(shown()).toHaveLength(1);
    wait(1);
    expect(shown()).toHaveLength(0);
  });

  it('are not held by a touch: tapping one is using it', () => {
    setup();
    act(() => say('Ben replied', { action: { label: 'Show', run: () => undefined } }));
    fireEvent.pointerEnter(screen.getByTestId('toast'), { pointerType: 'touch' });
    wait(TOAST_MS.action);
    expect(shown()).toHaveLength(0);
  });

  it('come one at a time: the newest is on screen, one with something to do waits under it for its turn', () => {
    setup();
    act(() => say('Ben replied', { action: { label: 'Show', run: () => undefined } }));
    wait(3000);
    act(() => say('Note pinned here.'));
    expect(said()).toEqual(['Note pinned here.']);
    // Under it, Ben's waits, its time stopped…
    wait(TOAST_MS.info);
    expect(said()).toEqual(['Ben replied']);
    // …and has the rest of it.
    wait(TOAST_MS.action - 3000 - 1);
    expect(shown()).toHaveLength(1);
    wait(1);
    expect(shown()).toHaveLength(0);
    // A plain one under a newer one only says its piece: its time runs out, seen or not.
    act(() => say('Saved.'));
    wait(1000);
    act(() => say('Link copied.'));
    wait(TOAST_MS.info);
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('leave the one being pointed at or focused on screen when a newer one comes: its Show is not swapped for another’s', () => {
    setup();
    const ben = vi.fn();
    act(() => say('Ben replied', { action: { label: 'Show', run: ben } }));
    fireEvent.pointerEnter(screen.getByTestId('toast'), { pointerType: 'mouse' });
    act(() => say('Ana replied', { action: { label: 'Show', run: () => undefined } }));
    expect(said()).toEqual(['Ben replied']);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(ben).toHaveBeenCalledTimes(1);
    // Then the newer one, which waited.
    expect(said()).toEqual(['Ana replied']);
    // The pointer gone, the newest is on screen again; the focus holds one the same way.
    const show = screen.getByRole('button', { name: 'Show' });
    fireEvent.focus(show);
    act(() => say('Saved.'));
    expect(said()).toEqual(['Ana replied']);
    fireEvent.blur(show, { relatedTarget: null });
    expect(said()).toEqual(['Saved.']);
  });

  it('keep three at most, the newest', () => {
    setup();
    act(() => {
      for (const n of [1, 2, 3, 4]) say(`Answer ${n}`, { action: { label: 'Show', run: () => undefined } });
    });
    expect(screen.getAllByTestId('toast').map((t) => t.querySelector('.toast-text')!.textContent)).toEqual(['Answer 2', 'Answer 3', 'Answer 4']);
  });
});
