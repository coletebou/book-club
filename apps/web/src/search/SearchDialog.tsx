import { type ClubSearchResult } from '@bookclub/shared';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { DictationButton } from '../components/DictationButton';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useBook, useClubs, useSession } from '../lib/queries';
import './search.css';

const LABELS: Record<ClubSearchResult['kind'], string> = { book: 'Book', chapter: 'Chapter', note: 'Note', chat: 'Chat' };
const NONE: readonly ClubSearchResult[] = [];

interface SearchReport {
  readonly clubId: string;
  readonly query: string;
  readonly results: readonly ClubSearchResult[];
  readonly error?: string;
}

export default function SearchDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const session = useSession();
  const clubs = useClubs();
  const clubRoute = useMatch('/clubs/:clubId/*');
  const bookRoute = useMatch('/books/:bookId/*');
  const book = useBook(bookRoute?.params.bookId);
  const [chosenClub, setChosenClub] = useState<string | null>(null);
  const contextClub = chosenClub ?? clubRoute?.params.clubId ?? book.data?.clubId;
  const clubId = contextClub || bookRoute ? clubs.data?.find((club) => club.id === contextClub)?.id : clubs.data?.[0]?.id;
  const [draft, setDraft] = useState('');
  const [report, setReport] = useState<SearchReport | null>(null);
  const [selection, setSelection] = useState<{ report: SearchReport; index: number } | null>(null);
  const [dictating, setDictating] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const query = draft.trim();
  const current = report?.clubId === clubId && report?.query === query ? report : null;
  const results = current?.results ?? NONE;
  const selected = selection && selection.report === current ? selection.index : -1;
  const searching = !!clubId && query.length >= 2 && !current;
  const count = results.length > 0 ? `${results.length} ${results.length === 1 ? 'result' : 'results'} shown.` : 'No matches.';
  const status = searching ? 'Searching…' : current?.error ?? (current ? count : '');

  useEffect(() => { if (clubId) field.current?.focus(); }, [clubId]);

  useEffect(() => {
    if (!clubId || query.length < 2) return;
    const request = new AbortController();
    const timer = setTimeout(() => {
      void api.clubSearch(clubId, query, request.signal).then(
        ({ results }) => { if (!request.signal.aborted) setReport({ clubId, query, results }); },
        (err: unknown) => {
          if (!request.signal.aborted) setReport({ clubId, query, results: [], error: err instanceof Error ? err.message : 'Search failed. Try again.' });
        },
      );
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [clubId, query]);

  const setQuery = (next: string) => {
    if (next.trim() !== query) {
      setReport(null);
    }
    setDraft(next);
  };
  const open = (result: ClubSearchResult) => {
    if (dictating) return;
    onClose();
    void navigate(result.href);
  };
  const move = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || dictating || results.length === 0) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      open(results[Math.max(0, selected)]!);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? (selected + 1) % results.length : (selected <= 0 ? results.length - 1 : selected - 1);
      setSelection({ report: current, index: next });
      list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    }
  };

  return (
    <Modal title="Search" onClose={onClose} initialFocus="[data-search-field]" className="club-search-modal">
      {clubs.isPending ? <p role="status">Loading your clubs…</p> : clubs.isError ? <p role="status">Could not load your clubs.</p> : !clubs.data?.length ? <p>You have no clubs to search yet.</p> : (
        <div className="club-search">
          {clubs.data.length > 1 || !clubId ? (
            <label className="club-search-club">
              <span>Club</span>
              <select value={clubId ?? ''} disabled={dictating} onChange={(event) => {
                setChosenClub(event.target.value);
                setReport(null);
              }}>
                {!clubId ? <option value="" disabled>Choose a club</option> : null}
                {clubs.data.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}
              </select>
            </label>
          ) : null}
          <div className="club-search-input">
            <input
              type="search"
              role="combobox"
              aria-label="Search this club"
              aria-autocomplete="list"
              aria-expanded={results.length > 0}
              aria-controls={listId}
              aria-activedescendant={results[selected] ? `${listId}-${selected}` : undefined}
              placeholder="Books, chapters, notes, chat"
              value={draft}
              disabled={!clubId}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={move}
              enterKeyHint="search"
              maxLength={120}
              ref={field}
              data-search-field
            />
            {clubId && session.data?.user ? <DictationButton clubId={clubId} userId={session.data.user.id} onActiveChange={setDictating} onText={(text) => {
              setQuery(text.slice(0, 120));
              field.current?.focus();
            }} /> : null}
          </div>
          {query.length === 1 ? <p className="muted small">Type at least two characters.</p> : null}
          <p className={status && results.length === 0 ? 'muted small' : 'visually-hidden'} role="status">{status}</p>
          <div id={listId} role="listbox" aria-label="Search results" ref={list} hidden={results.length === 0} className="club-search-results">
            {results.map((result, index) => (
              <button type="button" role="option" aria-selected={index === selected} tabIndex={-1} disabled={dictating} key={`${result.kind}-${result.id}`} id={`${listId}-${index}`} onClick={() => open(result)}>
                <span className="small muted">{LABELS[result.kind]} · {result.detail}</span>
                <strong>{result.title}</strong>
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
