import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Edition } from '@bookclub/shared';
import { useReadAlong } from '../lib/queries';
import { type Sentence, narrationAt, sentencesOf } from '../reader/readalong';

const WORDS_PAGE_SIZE = 24;

const SentenceLines = memo(function SentenceLines({ lines, current, seek }: { lines: readonly Sentence[]; current: number | null; seek: (seconds: number) => void }) {
  return (
    <ol className="readalong-lines">
      {lines.map((line) => (
        <li key={line.index}>
          <button
            type="button"
            className={`readalong-line${line.index === current ? ' is-current' : ''}`}
            aria-current={line.index === current ? 'true' : undefined}
            onClick={() => seek(line.startMs / 1000)}
            data-testid={line.index === current ? 'readalong-current' : 'readalong-line'}
          >
            {line.text}
          </button>
        </li>
      ))}
    </ol>
  );
});

/** The current line stays close at hand. The expanded view follows it or lets you browse this track (D240). */
export function ReadAlongPanel({ bookId, edition, track, ms, onSeek, inBook = false }: { bookId: string; edition: Edition; track: number; ms: number; onSeek: (seconds: number) => void; inBook?: boolean }) {
  const { data } = useReadAlong(edition.readAlong ? edition.id : undefined, track);
  const sentences = useMemo(() => sentencesOf(data), [data]);
  const narration = narrationAt(data, sentences, ms);
  const current = narration.state === 'reading' ? narration.sentence.index : null;
  const trackKey = `${edition.id}:${track}`;
  const [expanded, setExpanded] = useState(false);
  const [browsing, setBrowsing] = useState<{ trackKey: string; page: number } | null>(null);
  const pageCount = Math.max(1, Math.ceil(sentences.length / WORDS_PAGE_SIZE));
  const browsingThisTrack = browsing?.trackKey === trackKey && browsing.page < pageCount ? browsing : null;
  const page = browsingThisTrack?.page ?? Math.floor((current ?? 0) / WORDS_PAGE_SIZE);
  const start = page * WORDS_PAGE_SIZE;
  const following = browsingThisTrack === null;
  const followingIndex = following ? current : null;
  const titleId = useId();
  const wordsId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedLine = useRef<HTMLElement | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const seek = useCallback((seconds: number) => {
    const view = scroller.current;
    if (view?.contains(document.activeElement)) view.focus({ preventScroll: true });
    setBrowsing(null);
    onSeekRef.current(seconds);
  }, []);
  const first = expanded ? start : Math.max(0, (current ?? 0) - 1);
  const end = expanded ? start + WORDS_PAGE_SIZE : current === null ? 1 : current + 2;
  const lines = useMemo(() => sentences.slice(first, end), [sentences, first, end]);
  const activeLine = current !== null && current >= first && current < end ? current : null;
  const showWords = expanded && (lines.length > 0 || !data);

  useLayoutEffect(() => {
    // A track can change while a sentence has focus. Keep focus inside this panel when its row goes away.
    const last = focusedLine.current;
    if (last && !last.isConnected && document.activeElement === document.body) {
      (scroller.current ?? heading.current)?.focus({ preventScroll: true });
    }
  }, [lines, showWords]);

  useEffect(() => {
    setBrowsing((was) => was && (was.trackKey !== trackKey || was.page >= pageCount) ? null : was);
  }, [trackKey, pageCount]);

  const holdPage = () => {
    if (following) setBrowsing({ trackKey, page });
  };
  const browsePage = (next: number) => {
    scroller.current?.focus({ preventScroll: true });
    setBrowsing({ trackKey, page: next });
    scroller.current?.scrollTo({ top: 0, behavior: 'instant' });
  };
  const followNarrator = () => {
    scroller.current?.focus({ preventScroll: true });
    setBrowsing(null);
  };

  useEffect(() => {
    const view = scroller.current;
    if (!view || !showWords || !following) return;
    if (followingIndex === null) {
      if (view.scrollTop > 0) view.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    const row = view.querySelector('[aria-current="true"]');
    if (!row) return;
    const center = () => {
      const line = row.getBoundingClientRect();
      const bounds = view.getBoundingClientRect();
      const target = view.scrollTop + line.top - bounds.top - Math.max(0, (bounds.height - line.height) / 2);
      const top = Math.max(0, Math.min(view.scrollHeight - view.clientHeight, target));
      if (Math.abs(view.scrollTop - top) > 1) view.scrollTo({ top });
    };
    center();
    if (typeof ResizeObserver === 'undefined') return;
    const size = new ResizeObserver(center);
    size.observe(view);
    size.observe(row);
    return () => size.disconnect();
  }, [showWords, following, followingIndex, page, trackKey]);

  if (!edition.readAlong) return null;
  return (
    <section className="readalong" aria-labelledby={titleId} data-testid="readalong" data-state={narration.state} data-sentence={current ?? ''}>
      <div className="readalong-heading">
        <h2 id={titleId} className="section-title" ref={heading} tabIndex={-1}>Reading along</h2>
        {sentences.length > 0 ? (
          <button type="button" className="btn btn-small btn-ghost" aria-expanded={showWords} aria-controls={showWords ? wordsId : undefined} onClick={() => {
            setExpanded(!expanded);
            setBrowsing(null);
          }}>
            {expanded ? 'Hide words' : 'Show words'}
          </button>
        ) : null}
      </div>
      {narration.state === 'before' ? (
        <p className="small muted" data-testid="readalong-before">
          {narration.next ? 'Before the text: it begins with' : 'Before the text: it begins in a later track.'}
        </p>
      ) : narration.state === 'after' ? (
        <p className="small muted" data-testid="readalong-after">Past the end of the text.</p>
      ) : narration.state === 'loading' ? (
        <p className="small muted">…</p>
      ) : null}
      {showWords ? (
        <>
          <div
            className="readalong-words"
            ref={scroller}
            id={wordsId}
            role="region"
            aria-label="Narrated words"
            tabIndex={0}
            onWheel={holdPage}
            onTouchMove={holdPage}
            onPointerDown={(event) => { if (event.target === event.currentTarget) holdPage(); }}
            onFocusCapture={(event) => {
              focusedLine.current = event.target;
              if (event.target !== event.currentTarget) holdPage();
            }}
            onBlurCapture={(event) => {
              const previous = focusedLine.current;
              const view = event.currentTarget;
              queueMicrotask(() => {
                if (previous?.isConnected && focusedLine.current === previous && !view.contains(document.activeElement)) focusedLine.current = null;
              });
            }}
            onKeyDown={(event) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) holdPage(); }}
          >
            <SentenceLines lines={lines} current={activeLine} seek={seek} />
          </div>
          {pageCount > 1 || !following ? (
            <div className="readalong-navigation" role="group" aria-label="Browse narrated words">
              {pageCount > 1 ? <button type="button" className="btn btn-small btn-ghost" disabled={page === 0} onClick={() => browsePage(page - 1)}>Earlier sentences</button> : null}
              {!following ? <button type="button" className="btn btn-small btn-ghost" onClick={followNarrator}>Follow narrator</button> : null}
              {pageCount > 1 ? <button type="button" className="btn btn-small btn-ghost" disabled={page === pageCount - 1} onClick={() => browsePage(page + 1)}>Later sentences</button> : null}
            </div>
          ) : null}
        </>
      ) : lines.length > 0 ? <SentenceLines lines={lines} current={activeLine} seek={seek} /> : null}
      {/* The book under the sheet is already following (D194). */}
      {inBook ? null : (
        <Link className="btn btn-small" to={`/books/${bookId}/read?edition=${edition.readAlong.textEditionId}`} data-testid="readalong-open">
          Follow in the book
        </Link>
      )}
    </section>
  );
}
