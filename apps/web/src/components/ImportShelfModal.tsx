import { useRef, useState } from 'react';
import type { CreateNominationBody, NextBookState } from '@bookclub/shared';
import { api } from '../lib/api';
import { ShelfImportError, type ShelfImportResult, parseShelfExport } from '../lib/shelf-import';
import { Icon } from './Icon';
import { Modal } from './Modal';

/**
 * Importing a to-read shelf (D214, D216): a Goodreads or StoryGraph export CSV, parsed entirely on
 * this device (`lib/shelf-import.ts`). The file itself never leaves the browser; only the
 * nominations chosen below are ever sent to the server, one at a time, each its own nomination.
 */
export default function ImportShelfModal({ clubId, onClose, onImported }: { clubId: string; onClose: () => void; onImported: (state: NextBookState) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ShelfImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const parsed = parseShelfExport(await file.text());
      setResult(parsed);
      setSelected(new Set(parsed.toRead.map((_, i) => i)));
    } catch (err) {
      setError(err instanceof ShelfImportError ? err.message : 'Could not read that file.');
    }
  }

  function toggle(i: number): void {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (!result) return;
    setBusy(true);
    try {
      let last: NextBookState | undefined;
      for (const i of selected) {
        const book = result.toRead[i]!;
        const body: CreateNominationBody = { title: book.title, ...(book.author ? { author: book.author } : {}) };
        last = await api.nominate(clubId, body);
      }
      if (last) onImported(last);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not nominate those books.');
      setBusy(false);
    }
  }

  const allSelected = !!result && selected.size === result.toRead.length && result.toRead.length > 0;

  return (
    <Modal
      title="Import your to-read shelf"
      onClose={onClose}
      footer={
        result && result.toRead.length > 0 ? (
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={() => setResult(null)} data-testid="shelf-import-reset">
              Choose a different file
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => void submit()} data-testid="shelf-import-submit">
              {busy ? 'Nominating…' : `Nominate ${selected.size} selected`}
            </button>
          </div>
        ) : undefined
      }
    >
      <p className="muted">
        Export your library from Goodreads (My Books → Import and export → Export library) or StoryGraph (Manage Account → Export your data), then choose
        the CSV here. The file is read on this device only — nothing is uploaded except the nominations you choose below.
      </p>
      {!result ? (
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={16} /> Choose a CSV file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="visually-hidden"
            data-testid="shelf-csv-input"
            aria-label="Choose a CSV file"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert" data-testid="shelf-import-error">
          {error}
        </p>
      ) : null}
      {result ? (
        result.toRead.length === 0 ? (
          <p className="muted" data-testid="shelf-import-empty">
            No to-read books were found in that export ({result.totalRows} books in all).
          </p>
        ) : (
          <>
            <div className="section-head">
              <p className="muted small">
                {result.toRead.length} to-read of {result.totalRows} books, from {result.source === 'goodreads' ? 'Goodreads' : 'StoryGraph'}.
              </p>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setSelected(allSelected ? new Set() : new Set(result.toRead.map((_, i) => i)))}
                data-testid="shelf-import-select-all"
              >
                {allSelected ? 'Select none' : 'Select all'}
              </button>
            </div>
            <ul className="shelf-import-list stack-sm" data-testid="shelf-import-list">
              {result.toRead.map((book, i) => (
                <li key={`${book.title}-${i}`}>
                  <label className="row">
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} data-testid="shelf-import-item" />
                    <span>
                      <strong>{book.title}</strong>
                      {book.author ? <span className="muted small"> — {book.author}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </Modal>
  );
}
