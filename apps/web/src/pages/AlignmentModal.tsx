import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type BookDetail, type Edition, chapterNames, chaptersInOrder } from '@bookclub/shared';
import { FormError } from '../components/Form';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { keys } from '../lib/queries';

/**
 * Where each unit starts at first: as it is matched now; or, matched to no chapter yet, one unit to
 * a chapter in order when there are as many as the book has chapters, or as its story has after its
 * front matter (D74). Null for each unit otherwise.
 */
function startingMapping(book: BookDetail, edition: Edition): { mapping: (number | null)[]; inOrder: boolean } {
  const current = edition.units.map((_, i) => edition.alignment.unitToChapter[i] ?? null);
  const inOrder = current.every((c) => c === null) ? chaptersInOrder(book.chapters, edition.units.length) : null;
  return inOrder ? { mapping: inOrder, inOrder: true } : { mapping: current, inOrder: false };
}

/** Choose which book chapter each track (or section) starts; the shared timeline follows. */
export default function AlignmentModal({ book, edition, onClose }: { book: BookDetail; edition: Edition; onClose: () => void }) {
  const [start] = useState(() => startingMapping(book, edition));
  const [mapping, setMapping] = useState<(number | null)[]>(start.mapping);
  // Named as places are, with their part where the book numbers its chapters afresh in each (D86).
  const names = chapterNames(book.chapters);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.setAlignment(edition.id, mapping),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.book(book.id) });
      onClose();
    },
  });
  if (edition.units.length === 0) {
    return (
      <Modal title="Match chapters" onClose={onClose}>
        <p className="muted small" data-testid="align-nothing">
          {edition.kind === 'pdf'
            ? 'This PDF has no bookmarks, and no chapter headings were found at the top of its pages: there is nothing in it to match to the chapters.'
            : 'There is nothing in this format to match to the chapters.'}
        </p>
      </Modal>
    );
  }
  return (
    <Modal
      title="Match chapters"
      onClose={onClose}
      wide
      footer={
        <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </button>
      }
    >
      <p className="muted small">Pick the chapter each part starts. Positions, comments and progress line up across formats from these matches.</p>
      {start.inOrder ? (
        <p className="muted small" data-testid="align-in-order">
          Filled in one to one, in order{edition.units.length < book.chapters.length ? ', after the book’s opening pages' : ''}: check them, then save.
        </p>
      ) : null}
      <FormError error={save.error} />
      <ol className="align-list">
        {edition.units.map((u, i) => (
          <li key={i} className="align-row">
            <label htmlFor={`align-${i}`}>{u.title}</label>
            <select
              id={`align-${i}`}
              value={mapping[i] ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                setMapping((m) => m.map((x, j) => (j === i ? v : x)));
              }}
            >
              <option value="">(no chapter starts here)</option>
              {book.chapters.map((c, k) => (
                <option key={c.index} value={c.index}>
                  {names[k]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
