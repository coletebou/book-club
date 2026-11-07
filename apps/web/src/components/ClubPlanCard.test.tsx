import { cleanup, render, screen, within } from '@testing-library/react';
import type { ClubPlan } from '@bookclub/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ClubPlanCard } from './ClubPlanCard';

afterEach(cleanup);

const plan = (over: Partial<ClubPlan> = {}): ClubPlan => ({
  name: 'free',
  until: null,
  storage: { usedBytes: 1.5 * 1024 ** 3, maxBytes: 2 * 1024 ** 3 },
  members: { count: 6, max: 8 },
  proUrl: null,
  ...over,
});

describe('the club’s plan (D208)', () => {
  it('says what the club stores and how many are in it, against its plan’s limits, as meters', () => {
    render(<ClubPlanCard plan={plan()} />);
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
    expect(screen.getByTestId('plan-storage').textContent).toBe('1.5 GB of 2.0 GB stored');
    expect(screen.getByTestId('plan-members').textContent).toBe('6 of 8 members');
    const stored = screen.getByRole('meter', { name: 'Stored' });
    expect(stored.getAttribute('aria-valuetext')).toBe('1.5 GB of 2.0 GB stored');
    expect(screen.getByRole('meter', { name: 'Members' }).getAttribute('aria-valuenow')).toBe('6');
    // Nobody is offered Club Pro where the host offers none.
    expect(screen.queryByTestId('plan-pro')).toBeNull();
  });

  it('with no limit set, says only what there is', () => {
    render(<ClubPlanCard plan={plan({ storage: { usedBytes: 2048, maxBytes: null }, members: { count: 1, max: null } })} />);
    expect(screen.getByTestId('plan-storage').textContent).toBe('2.0 KB stored');
    expect(screen.getByTestId('plan-members').textContent).toBe('1 member');
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('offers Club Pro where the server gives the way to it, opening it apart from the app', () => {
    render(<ClubPlanCard plan={plan({ proUrl: 'https://pay.example/b/x?client_reference_id=club_1' })} />);
    const link = within(screen.getByTestId('club-plan')).getByRole('link', { name: /Take Club Pro/ });
    expect(link.getAttribute('href')).toBe('https://pay.example/b/x?client_reference_id=club_1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('on Club Pro, says so and until when, and a club past a limit shows it full', () => {
    render(<ClubPlanCard plan={plan({ name: 'pro', until: '2027-11-08T00:00:00.000Z', members: { count: 9, max: 8 } })} />);
    expect(screen.getByRole('heading', { name: 'Club Pro' })).toBeTruthy();
    expect(screen.getByTestId('club-plan').textContent).toContain('Club Pro until 8 November 2027');
    expect(screen.getByRole('meter', { name: 'Members' }).getAttribute('aria-valuenow')).toBe('8');
    expect(screen.getByTestId('plan-members').querySelector('.plan-meter-bar')!.className).toContain('is-full');
  });
});
