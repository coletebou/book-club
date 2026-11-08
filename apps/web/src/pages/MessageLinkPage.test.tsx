import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { MessageLinkPage } from './MessageLinkPage';

vi.mock('./NotFoundPage', () => ({ NotFoundPage: () => <p>not found</p> }));

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.hash}</p>;
}

function open(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/m" element={<MessageLinkPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('a Book Club message opened on the web (D220)', () => {
  it('goes on to the invite, the book, or the club’s vote', () => {
    open('/m#v=1&k=invite&c=club_0001&i=inviteCode123&n=Thursday+Readers');
    expect(screen.getByTestId('where').textContent).toBe('/join/inviteCode123');
    cleanup();
    open('/m#v=1&k=progress&c=club_0001&b=book_00001&t=Red+Rising&p=23&ch=12');
    expect(screen.getByTestId('where').textContent).toBe('/books/book_00001');
    cleanup();
    open('/m#v=1&k=vote&c=club_0001&r=round_0007');
    expect(screen.getByTestId('where').textContent).toBe('/clubs/club_0001/next');
  });

  it('is not found for anything else, and never goes off this site', () => {
    open('/m#v=1&k=vote&c=club_0001');
    expect(screen.getByText('not found')).toBeTruthy();
    cleanup();
    open('/m#v=1&k=invite&c=club_0001&i=%2F%2Fevil.example&n=X');
    expect(screen.getByText('not found')).toBeTruthy();
  });
});
