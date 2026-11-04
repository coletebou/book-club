import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, isStaleChunk } from './ErrorBoundary';

/* isStaleChunk --------------------------------------------------------------------------------- */

describe('isStaleChunk', () => {
  it.each([
    ['Chromium', new TypeError('Failed to fetch dynamically imported module: https://club.example/assets/ReaderPage-3f2a9c.js')],
    ['WebKit', new TypeError('Importing a module script failed.')],
    ['Firefox', new TypeError('error loading dynamically imported module: https://club.example/assets/ReaderPage-3f2a9c.js')],
    ['Vite (a stylesheet of the missing chunk)', new Error('Unable to preload CSS for /assets/ReaderPage-3f2a9c.css')],
    ['a chunk loader that names its errors', Object.assign(new Error('Loading chunk 7 failed.'), { name: 'ChunkLoadError' })],
  ])('recognises a part of the app that is gone after an update (%s)', (_engine, error) => {
    expect(isStaleChunk(error)).toBe(true);
  });

  it('recognises the message thrown as a plain string too', () => {
    expect(isStaleChunk('Importing a module script failed.')).toBe(true);
  });

  it.each([
    ['a failed API request', new TypeError('Failed to fetch')],
    ['a WebKit network error', new TypeError('Load failed')],
    ['a bug in a component', new TypeError("Cannot read properties of undefined (reading 'map')")],
    ['a syntax error', new SyntaxError('Unexpected token < in JSON at position 0')],
    ['an API error', Object.assign(new Error('Request failed (500).'), { name: 'ApiError' })],
    ['nothing', undefined],
    ['null', null],
    ['an object', { message: 'boom' }],
  ])('does not mistake other errors for one (%s)', (_label, error) => {
    expect(isStaleChunk(error)).toBe(false);
  });
});

/* ErrorBoundary -------------------------------------------------------------------------------- */

function Boom({ error }: { error: Error }): never {
  throw error;
}

describe('ErrorBoundary', () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // React and the boundary both report caught errors to the console; keep the output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reload = vi.fn();
    vi.stubGlobal('location', { pathname: '/books/book_alice/read', reload });
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders its children when nothing goes wrong', () => {
    render(
      <ErrorBoundary resetKey="/a">
        <p>The page</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('The page')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a calm error page instead of a blank app when a screen fails to render', () => {
    render(
      <ErrorBoundary resetKey="/a">
        <Boom error={new TypeError("Cannot read properties of undefined (reading 'map')")} />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.dataset.testid).toBe('error-page');
    expect(screen.getByRole('heading', { name: 'Something went wrong on this page' })).toBeTruthy();
    expect(alert.textContent).toContain('Your reading and notes are safe.');
    expect(screen.getByRole('link', { name: 'Your clubs' }).getAttribute('href')).toBe('/');
    // An ordinary bug does not reload the page by itself.
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when the reader asks', () => {
    render(
      <ErrorBoundary resetKey="/a">
        <Boom error={new Error('broken')} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('recovers when the route (resetKey) changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/books/1">
        <Boom error={new Error('broken')} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(
      <ErrorBoundary resetKey="/books/2">
        <p>Another page</p>
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Another page')).toBeTruthy();
  });

  it('stays on the error page while the route is the same', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/books/1">
        <Boom error={new Error('broken')} />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary resetKey="/books/1">
        <p>Same page</p>
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Same page')).toBeNull();
  });

  it('catches the error again if the new route fails too', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/books/1">
        <Boom error={new Error('broken')} />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary resetKey="/books/2">
        <Boom error={new Error('also broken')} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('reloads once to fetch the new version when a screen’s code is gone after an update', () => {
    const stale = new TypeError('Failed to fetch dynamically imported module: https://club.example/assets/ReaderPage-3f2a9c.js');
    render(
      <ErrorBoundary resetKey="/a">
        <Boom error={stale} />
      </ErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toBeTruthy();
    cleanup();

    // Still broken after the reload (say the server really lacks it): no reload loop.
    render(
      <ErrorBoundary resetKey="/a">
        <Boom error={stale} />
      </ErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toBeTruthy();
    cleanup();

    // Another page whose code is gone gets its own reload.
    vi.stubGlobal('location', { pathname: '/clubs/club_1', reload });
    render(
      <ErrorBoundary resetKey="/b">
        <Boom error={stale} />
      </ErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
