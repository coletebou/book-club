import { Link } from 'react-router';
import type { Edition } from '@bookclub/shared';
import { useReadAlong } from '../lib/queries';
import { narrationAt, sentenceIndexAt, sentencesOf } from '../reader/readalong';

/**
 * Reading along while listening: the sentence being read, with the ones around it, from the
 * audiobook's alignment with the book's text (D46). A sentence can be tapped to hear it again.
 *
 * It is there for the whole audiobook once it reads along (D184), not only where this track has
 * sentences: during the opening credits, a track's announcement or a track of credits it says the
 * text has not begun yet (and shows the sentence it begins with), past the text's end that it is
 * over, and "Follow in the book" is always one tap away.
 */
export function ReadAlongPanel({ bookId, edition, track, ms, onSeek, inBook = false }: { bookId: string; edition: Edition; track: number; ms: number; onSeek: (seconds: number) => void; inBook?: boolean }) {
  const readAlong = useReadAlong(edition.readAlong ? edition.id : undefined, track);
  const sentences = sentencesOf(readAlong.data);
  if (!edition.readAlong) return null;
  const narration = narrationAt(readAlong.data, sentences, ms);
  const i = sentenceIndexAt(sentences, ms);
  const shown = narration.state === 'reading' ? sentences.slice(Math.max(0, i - 1), i + 2) : narration.state === 'before' && narration.next ? [narration.next] : [];
  const current = narration.state === 'reading' ? narration.sentence : null;
  return (
    <section className="readalong" aria-labelledby="readalong-title" data-testid="readalong" data-state={narration.state} data-sentence={current?.index ?? ''}>
      <h2 id="readalong-title" className="section-title">
        Reading along
      </h2>
      {narration.state === 'before' ? (
        <p className="small muted" data-testid="readalong-before">
          {narration.next ? 'Before the text: it begins with' : 'Before the text: it begins in a later track.'}
        </p>
      ) : narration.state === 'after' ? (
        <p className="small muted" data-testid="readalong-after">
          Past the end of the text.
        </p>
      ) : narration.state === 'loading' ? (
        <p className="small muted">…</p>
      ) : null}
      {shown.length > 0 ? (
        <ol className="readalong-lines">
          {shown.map((s) => (
            <li key={s.index}>
              <button
                type="button"
                className={`readalong-line${s.index === current?.index ? ' is-current' : ''}`}
                aria-current={s.index === current?.index ? 'true' : undefined}
                onClick={() => onSeek(s.startMs / 1000)}
                data-testid={s.index === current?.index ? 'readalong-current' : 'readalong-line'}
              >
                {s.text}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {/* Over the book itself (D194), the book is already following: no link back into it. */}
      {inBook ? null : (
        <Link className="btn btn-small" to={`/books/${bookId}/read?edition=${edition.readAlong.textEditionId}`} data-testid="readalong-open">
          Follow in the book
        </Link>
      )}
    </section>
  );
}
