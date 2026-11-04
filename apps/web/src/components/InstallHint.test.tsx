import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallHint, isIos } from './InstallHint';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

function device(userAgent: string, maxTouchPoints: number, standalone = false) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  // jsdom has no touch screen to report: give it one.
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
  Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'standalone');
  Reflect.deleteProperty(navigator, 'maxTouchPoints');
});

describe('the Home Screen tip', () => {
  it('knows an iPhone and an iPad (which says it is a Mac), and nothing else', () => {
    expect(isIos(IPHONE, 5)).toBe(true);
    expect(isIos(IPAD, 5)).toBe(true);
    // A real Mac: the same words, no touch screen.
    expect(isIos(IPAD, 0)).toBe(false);
    expect(isIos(ANDROID, 5)).toBe(false);
  });

  it('shows on an iPhone in the browser, and once dismissed stays away', () => {
    device(IPHONE, 5);
    const first = render(<InstallHint />);
    expect(screen.getByTestId('install-hint').textContent).toContain('Tap Share, then “Add to Home Screen”');
    expect(screen.getByRole('complementary', { name: 'Keep the club on your Home Screen.' })).toBe(screen.getByTestId('install-hint'));
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('install-hint')).toBeNull();
    first.unmount();
    render(<InstallHint />);
    expect(screen.queryByTestId('install-hint')).toBeNull();
  });

  it('does not show in the app opened from the Home Screen, or on other devices', () => {
    device(IPHONE, 5, true);
    render(<InstallHint />);
    expect(screen.queryByTestId('install-hint')).toBeNull();
    cleanup();
    device(ANDROID, 5);
    render(<InstallHint />);
    expect(screen.queryByTestId('install-hint')).toBeNull();
  });

  it('does not show in the real iOS app either (D131): it is already the thing the tip suggests', () => {
    device(IPHONE, 5);
    (window as Window & { BookClubNative?: unknown }).BookClubNative = { postMessage: vi.fn() };
    render(<InstallHint />);
    expect(screen.queryByTestId('install-hint')).toBeNull();
    Reflect.deleteProperty(window, 'BookClubNative');
  });
});
