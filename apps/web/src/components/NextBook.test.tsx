import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Nomination, Round, UpNext } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloseRoundControl, NominationCard, UpNextCard, formFromNomination, tiedForMostVotes, voterSummary } from './NextBook';

afterEach(cleanup);

const person = (userId: string, displayName: string) => ({ userId, displayName, color: '#D6B85E' });

const nomination = (over: Partial<Nomination> = {}): Nomination => ({
  id: 'nom_1',
  roundId: 'round_1',
  title: 'Piranesi',
  author: 'Susanna Clarke',
  link: null,
  pitch: null,
  createdBy: person('user_ana', 'Ana'),
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  votes: 0,
  voters: [],
  votedByMe: false,
  ...over,
});

const round = (nominations: Nomination[], over: Partial<Round> = {}): Round => ({
  id: 'round_1',
  clubId: 'club_1',
  status: 'open',
  openedBy: person('user_ana', 'Ana'),
  openedAt: '2026-10-01T00:00:00.000Z',
  closedBy: null,
  closedAt: null,
  winnerNominationId: null,
  nominations,
  ...over,
});

describe('voterSummary', () => {
  it('says so when nobody has voted', () => {
    expect(voterSummary([])).toBe('No votes yet');
  });

  it('names the voters, the same way as elsewhere in the app', () => {
    expect(voterSummary([person('user_ana', 'Ana')])).toBe('Voted by Ana');
    expect(voterSummary([person('user_ana', 'Ana'), person('user_ben', 'Ben')])).toBe('Voted by Ana and Ben');
    expect(voterSummary([person('user_ana', 'Ana'), person('user_ben', 'Ben'), person('user_cleo', 'Cleo')])).toBe('Voted by Ana, Ben and 1 other');
  });
});

describe('tiedForMostVotes', () => {
  it('is empty with nothing nominated', () => {
    expect(tiedForMostVotes(round([]))).toEqual([]);
  });

  it('is just the leader when there is one', () => {
    expect(tiedForMostVotes(round([nomination({ id: 'a', votes: 1 }), nomination({ id: 'b', votes: 3 })]))).toEqual(['b']);
  });

  it('is every nomination tied for the lead', () => {
    expect(tiedForMostVotes(round([nomination({ id: 'a', votes: 2 }), nomination({ id: 'b', votes: 2 }), nomination({ id: 'c', votes: 1 })]))).toEqual(['a', 'b']);
  });
});

describe('formFromNomination', () => {
  it('turns nulls into empty strings for the edit form', () => {
    expect(formFromNomination(nomination({ author: null, link: null, pitch: null }))).toEqual({ title: 'Piranesi', author: '', link: '', pitch: '' });
  });

  it('keeps what is there', () => {
    expect(formFromNomination(nomination({ link: 'https://example.com/book', pitch: 'A strange house.' }))).toMatchObject({
      link: 'https://example.com/book',
      pitch: 'A strange house.',
    });
  });
});

describe('NominationCard', () => {
  it('shows the vote count, the voters and who nominated it', () => {
    render(
      <NominationCard
        nomination={nomination({ votes: 2, voters: [person('user_ben', 'Ben'), person('user_cleo', 'Cleo')] })}
        voteBusy={false}
        canEdit={false}
        canRemove={false}
        onToggleVote={vi.fn()}
        onStartEdit={vi.fn()}
        onWithdraw={vi.fn()}
      />,
    );
    expect(screen.getByTestId('vote-toggle').textContent).toContain('Vote · 2');
    expect(screen.getByText('Voted by Ben and Cleo')).toBeTruthy();
    expect(screen.getByText('Nominated by Ana')).toBeTruthy();
    expect(screen.queryByTestId('nomination-edit')).toBeNull();
    expect(screen.queryByTestId('nomination-withdraw')).toBeNull();
  });

  it('toggles the vote, shown as voted once it is', () => {
    const onToggleVote = vi.fn();
    render(<NominationCard nomination={nomination({ votedByMe: true, votes: 1 })} voteBusy={false} canEdit={false} canRemove={false} onToggleVote={onToggleVote} onStartEdit={vi.fn()} onWithdraw={vi.fn()} />);
    const button = screen.getByTestId('vote-toggle');
    expect(button.textContent).toContain('Voted · 1');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onToggleVote).toHaveBeenCalledTimes(1);
  });

  it('shows Edit and Withdraw only to the nominator, never both at once with Remove', () => {
    render(<NominationCard nomination={nomination()} voteBusy={false} canEdit canRemove onToggleVote={vi.fn()} onStartEdit={vi.fn()} onWithdraw={vi.fn()} />);
    expect(screen.getByTestId('nomination-edit')).toBeTruthy();
    expect(screen.getByTestId('nomination-withdraw').textContent).toContain('Withdraw');
  });

  it('offers Remove, not Edit, to an owner looking at someone else’s nomination', () => {
    render(<NominationCard nomination={nomination()} voteBusy={false} canEdit={false} canRemove onToggleVote={vi.fn()} onStartEdit={vi.fn()} onWithdraw={vi.fn()} />);
    expect(screen.queryByTestId('nomination-edit')).toBeNull();
    expect(screen.getByTestId('nomination-withdraw').textContent).toContain('Remove');
  });

  it('shows the link as a plain external link, never as something fetched', () => {
    render(<NominationCard nomination={nomination({ link: 'https://www.goodreads.com/book/show/1' })} voteBusy={false} canEdit={false} canRemove={false} onToggleVote={vi.fn()} onStartEdit={vi.fn()} onWithdraw={vi.fn()} />);
    const link = screen.getByTestId('nomination-link-out');
    expect(link.getAttribute('href')).toBe('https://www.goodreads.com/book/show/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.tagName).toBe('A');
  });
});

describe('CloseRoundControl', () => {
  it('closes outright when one nomination leads, no choice asked', () => {
    const onClose = vi.fn();
    render(<CloseRoundControl round={round([nomination({ id: 'a', votes: 1 }), nomination({ id: 'b', votes: 3 })])} busy={false} onClose={onClose} />);
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByTestId('close-round-submit'));
    expect(onClose).toHaveBeenCalledWith(undefined);
  });

  it('needs a choice among a tie before it may close', () => {
    const onClose = vi.fn();
    render(<CloseRoundControl round={round([nomination({ id: 'a', title: 'A', votes: 2 }), nomination({ id: 'b', title: 'B', votes: 2 })])} busy={false} onClose={onClose} />);
    const submit = screen.getByTestId<HTMLButtonElement>('close-round-submit');
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('B'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onClose).toHaveBeenCalledWith('b');
  });

  it('refuses to close an empty round', () => {
    render(<CloseRoundControl round={round([])} busy={false} onClose={vi.fn()} />);
    expect(screen.getByTestId<HTMLButtonElement>('close-round-submit').disabled).toBe(true);
  });
});

describe('UpNextCard', () => {
  const upNext = (over: Partial<UpNext> = {}): UpNext => ({
    nominationId: 'nom_1',
    roundId: 'round_1',
    title: 'Piranesi',
    author: 'Susanna Clarke',
    link: null,
    pitch: null,
    setAt: '2026-10-25T00:00:00.000Z',
    ...over,
  });

  it('links into the picker, and offers "Mark as done" only to the owner', () => {
    const onClear = vi.fn();
    render(
      <MemoryRouter>
        <UpNextCard clubId="club_1" upNext={upNext()} canClear onClear={onClear} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Piranesi')).toBeTruthy();
    expect(screen.getByTestId('up-next-open-picker').getAttribute('href')).toBe('/clubs/club_1/next-book');
    fireEvent.click(screen.getByTestId('up-next-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('a member sees no way to mark it done', () => {
    render(
      <MemoryRouter>
        <UpNextCard clubId="club_1" upNext={upNext()} canClear={false} onClear={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('up-next-clear')).toBeNull();
  });
});
