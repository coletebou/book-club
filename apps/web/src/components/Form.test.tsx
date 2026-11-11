import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthLayout, Field } from './Form';

afterEach(cleanup);

describe('Field', () => {
  it('shows its hint, described by it', () => {
    render(<Field label="Password" type="password" hint="At least 10 characters." />);
    const input = screen.getByLabelText('Password');
    expect(screen.getByText('At least 10 characters.')).toBeTruthy();
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('At least 10 characters.');
  });

  it('lets an error take the hint’s place, so nothing is said twice', () => {
    render(<Field label="Password" type="password" hint="At least 10 characters." error="Use at least 10 characters" />);
    const input = screen.getByLabelText('Password');
    expect(screen.queryByText('At least 10 characters.')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Use at least 10 characters');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Use at least 10 characters');
  });
});

describe('AuthLayout', () => {
  it('links the privacy policy (D227) as a page the browser loads, not an app route', () => {
    render(
      <AuthLayout title="Welcome back">
        <p>The form</p>
      </AuthLayout>,
    );
    const link = screen.getByRole('link', { name: 'Privacy policy' });
    expect(link.getAttribute('href')).toBe('/privacy');
    // A plain anchor: rendered here with no router at all, which a router <Link> could not be.
    expect(link.tagName).toBe('A');
  });
});
