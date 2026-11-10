import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateNominationBody, NextBookState } from '@bookclub/shared';
import { ApiError, api } from '../lib/api';
import ImportShelfModal from './ImportShelfModal';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// A small synthetic Goodreads export (never a real person's data): three to-read books.
const CSV =
  'Title,Author,Exclusive Shelf\n' +
  'First Book,Short Author,to-read\n' +
  'Second Book,An Author Whose Name Is Implausibly Long For This Field,to-read\n' +
  'Third Book,Another Author,to-read\n';

function csvFile(): File {
  return new File([CSV], 'library_export.csv', { type: 'text/csv' });
}

const emptyState = (): NextBookState => ({ upNext: null, round: null, history: [] });

const titlesSent = (nominate: { mock: { calls: [string, CreateNominationBody][] } }) => nominate.mock.calls.map(([, body]) => body.title);

describe('ImportShelfModal: a partial failure never resends what already nominated (D214, D216)', () => {
  it('drops a nominated book from the selection at once, reports the one that failed, and a retry sends only that one again', async () => {
    const nominate = vi.spyOn(api, 'nominate').mockImplementation(async (_clubId: string, body: CreateNominationBody) => {
      if (body.title === 'Second Book') throw new ApiError(400, 'bad_request', 'Use a shorter author name', { author: 'Too long' });
      return emptyState();
    });
    const onImported = vi.fn();
    render(<ImportShelfModal clubId="club_1" onClose={vi.fn()} onImported={onImported} />);

    fireEvent.change(screen.getByTestId('shelf-csv-input'), { target: { files: [csvFile()] } });
    await screen.findByTestId('shelf-import-list');
    expect(screen.getAllByTestId('shelf-import-item')).toHaveLength(3);

    fireEvent.click(screen.getByTestId('shelf-import-submit'));
    await waitFor(() => expect(nominate).toHaveBeenCalledTimes(3));
    expect(titlesSent(nominate)).toEqual(['First Book', 'Second Book', 'Third Book']);

    const failure = await screen.findByTestId('shelf-import-failure');
    expect(failure.textContent).toContain('Second Book');
    expect(failure.textContent).toContain('Use a shorter author name');
    expect(onImported).toHaveBeenCalledTimes(1); // the two that succeeded still land in the picker

    // Only the one that failed is still checked: the other two are gone from the selection.
    const checked = screen.getAllByTestId<HTMLInputElement>('shelf-import-item').filter((el) => el.checked);
    expect(checked).toHaveLength(1);

    // Retrying sends only what is still selected: three calls become four, never six.
    fireEvent.click(screen.getByTestId('shelf-import-submit'));
    await waitFor(() => expect(nominate).toHaveBeenCalledTimes(4));
    expect(titlesSent(nominate)).toEqual(['First Book', 'Second Book', 'Third Book', 'Second Book']);
  });

  it('closes once everything selected has nominated, with nothing left to report', async () => {
    const nominate = vi.spyOn(api, 'nominate').mockResolvedValue(emptyState());
    const onClose = vi.fn();
    render(<ImportShelfModal clubId="club_1" onClose={onClose} onImported={vi.fn()} />);

    fireEvent.change(screen.getByTestId('shelf-csv-input'), { target: { files: [csvFile()] } });
    await screen.findByTestId('shelf-import-list');
    fireEvent.click(screen.getByTestId('shelf-import-submit'));

    await waitFor(() => expect(nominate).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('shelf-import-failures')).toBeNull();
  });
});
