import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { type Edition, type ReadAlongTrack, type ReadAlongWordTiming, SPOKEN_WORDS_WINDOW_MS } from '@bookclub/shared';
import { useReadAlong, useSpokenWords } from '../lib/queries';
import { type Sentence, narrationAt, sentenceIndexAt, sentencesOf } from '../reader/readalong';
import { useAudioMaybe } from './AudioProvider';
import { audioDisplayClock } from './native-bridge';

const WORDS_PAGE_SIZE = 24;
type NarratedLine = Pick<Sentence, 'index' | 'text' | 'startMs'>;
type TimedLines = Pick<ReadAlongTrack, 'audioEditionId' | 'track' | 'wordTimings'>;

function wordAt(words: readonly ReadAlongWordTiming[] | undefined, ms: number): ReadAlongWordTiming | undefined {
  return words?.findLast(([, , from, to]) => from <= ms && ms < to);
}

/** Paint short words between transport updates. D260 wakes at the next change. */
function useNarrationTime(data: TimedLines | undefined, sentences: readonly NarratedLine[], observedMs: number): number {
  const audio = useAudioMaybe();
  const element = audio?.element;
  const playing = audio?.state.playing && !audio.state.buffering && audio.state.edition?.id === data?.audioEditionId && audio.state.track === data?.track;
  const timings = data?.wordTimings;
  const [sample, setSample] = useState<{ track: TimedLines; ms: number } | null>(null);

  useLayoutEffect(() => {
    if (!playing || !audio || !element || !data || !timings) {
      setSample(null);
      return;
    }
    let lastSentence = -2;
    let lastWord: ReadAlongWordTiming | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      clearTimeout(timer);
      if (document.hidden || audio.state.edition?.id !== data.audioEditionId || audio.state.track !== data.track) return;
      const { seconds, advanceForMs } = audioDisplayClock(element);
      const ms = seconds * 1000;
      const sentence = sentenceIndexAt(sentences, ms);
      const words = timings[sentence];
      const word = wordAt(words, ms);
      if (sentence !== lastSentence || word !== lastWord) {
        lastSentence = sentence;
        lastWord = word;
        setSample({ track: data, ms });
      }
      if (advanceForMs === 0) return;
      let nextMs = sentences[sentence + 1]?.startMs ?? Infinity;
      for (const [, , from, to] of words ?? []) {
        if (from > ms) nextMs = Math.min(nextMs, from);
        if (to > ms) nextMs = Math.min(nextMs, to);
      }
      const waitMs = (nextMs - ms) / element.playbackRate;
      // Recheck after a media event when the next edge is beyond the native interpolation window.
      if (Number.isFinite(waitMs) && waitMs <= advanceForMs) timer = setTimeout(draw, Math.max(8, Math.ceil(waitMs)));
    };
    const signals = ['timeupdate', 'seeking', 'seeked', 'native-seeking', 'playing', 'ratechange', 'native-ratechange'] as const;
    for (const signal of signals) element.addEventListener(signal, draw);
    document.addEventListener('visibilitychange', draw);
    draw();
    return () => {
      for (const signal of signals) element.removeEventListener(signal, draw);
      document.removeEventListener('visibilitychange', draw);
      clearTimeout(timer);
    };
  }, [playing, audio, element, data, timings, sentences]);

  return playing && !element?.seeking && sample?.track === data && sample ? sample.ms : observedMs;
}

const SentenceLine = memo(function SentenceLine({ line, current, word, seek }: { line: NarratedLine; current: boolean; word?: ReadAlongWordTiming; seek: (seconds: number) => void }) {
  const offset = word?.[0] ?? 0;
  const end = offset + (word?.[1] ?? 0);
  return (
    <li>
      <button
        type="button"
        className={`readalong-line${current ? ' is-current' : ''}`}
        aria-current={current ? 'true' : undefined}
        onClick={() => seek(line.startMs / 1000)}
        data-testid={current ? 'readalong-current' : 'readalong-line'}
      >
        {word ? <>{line.text.slice(0, offset)}<mark className="readalong-word" data-testid="readalong-word">{line.text.slice(offset, end)}</mark>{line.text.slice(end)}</> : line.text}
      </button>
    </li>
  );
});

const SentenceLines = memo(function SentenceLines({ lines, current, word, seek }: { lines: readonly NarratedLine[]; current: number | null; word?: ReadAlongWordTiming; seek: (seconds: number) => void }) {
  return (
    <ol className="readalong-lines">
      {lines.map((line) => (
        <SentenceLine key={line.index} line={line} current={line.index === current} word={line.index === current ? word : undefined} seek={seek} />
      ))}
    </ol>
  );
});

/** The current line stays close at hand. The expanded view follows it or lets you browse this track (D240). */
export function ReadAlongPanel({ bookId, edition, track, ms: observedMs, onSeek, inBook = false }: { bookId: string; edition: Edition; track: number; ms: number; onSeek: (seconds: number) => void; inBook?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { data } = useReadAlong(edition.readAlong ? edition.id : undefined, track, expanded);
  const alignedSentences = useMemo(() => sentencesOf(data), [data]);
  const raw = !edition.readAlong && !!edition.hasTranscript;
  const duration = raw ? edition.tracks[track]?.durationMs ?? 0 : 0;
  const maxWindow = Math.max(0, Math.ceil(duration / SPOKEN_WORDS_WINDOW_MS) - 1);
  const window = Math.max(0, Math.min(maxWindow, Math.floor(observedMs / SPOKEN_WORDS_WINDOW_MS)));
  const nextNear = window < maxWindow && observedMs >= (window + 1) * SPOKEN_WORDS_WINDOW_MS - 12_000;
  const spoken = useSpokenWords(raw && expanded ? edition.id : undefined, track, window, nextNear);
  const spokenLines = useMemo(() => spoken.data?.lines.map(({ text, startMs }, index) => ({ index, text, startMs })) ?? [], [spoken.data]);
  const timed = useMemo(() => spoken.data ? {
    audioEditionId: spoken.data.audioEditionId,
    track: spoken.data.track,
    wordTimings: spoken.data.lines.map((line) => line.words),
  } : data, [data, spoken.data]);
  const sentences = raw ? spokenLines : alignedSentences;
  const ms = useNarrationTime(expanded ? timed : undefined, sentences, observedMs);
  const narration = narrationAt(data, alignedSentences, ms);
  const lastAligned = alignedSentences.at(-1);
  const pastText = narration.state === 'after' || (!expanded && data?.finalTextTrack && lastAligned && ms >= lastAligned.endMs);
  const spokenIndex = raw ? sentenceIndexAt(spokenLines, ms) : -1;
  const current = raw ? (spokenIndex < 0 ? null : spokenIndex) : !pastText && narration.state === 'reading' ? narration.sentence.index : null;
  const trackKey = `${edition.id}:${track}${raw ? `:${window}` : ''}`;
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
  const end = expanded ? start + WORDS_PAGE_SIZE : current !== null ? current + 2 : pastText ? 0 : 1;
  const lines = useMemo(() => sentences.slice(first, end), [sentences, first, end]);
  const activeLine = current !== null && current >= first && current < end ? current : null;
  // The track's word array stays stable across time updates. Only a different match redraws a row.
  const activeWord = expanded && activeLine !== null ? wordAt(timed?.wordTimings?.[activeLine], ms) : undefined;
  const showWords = expanded && (lines.length > 0 || (!raw && !data));

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
      const focus = line.height > view.clientHeight ? row.querySelector('mark')?.getBoundingClientRect() ?? line : line;
      const target = view.scrollTop + focus.top - bounds.top - Math.max(0, (bounds.height - focus.height) / 2);
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

  // A sentence can extend beyond the viewport. Follow the word within it as well as the sentence.
  useLayoutEffect(() => {
    const view = scroller.current;
    if (!view || !following || !activeWord) return;
    const mark = view.querySelector('mark');
    if (!mark) return;
    const word = mark.getBoundingClientRect();
    const top = view.getBoundingClientRect().top + view.clientTop;
    const bottom = top + view.clientHeight;
    const delta = word.bottom > bottom ? word.bottom - bottom : Math.min(0, word.top - top);
    if (delta) view.scrollBy({ top: delta, behavior: 'instant' });
  }, [activeWord, following]);

  if (!edition.readAlong && !raw) return null;
  return (
    <section className="readalong" aria-labelledby={titleId} data-testid="readalong" data-state={raw ? 'transcript' : pastText ? 'after' : narration.state} data-sentence={current ?? ''}>
      <div className="readalong-heading">
        <h2 id={titleId} className="section-title" ref={heading} tabIndex={-1}>{raw ? 'Audiobook transcript' : 'Reading along'}</h2>
        {raw || sentences.length > 0 ? (
          <button type="button" className="btn btn-small btn-ghost" aria-expanded={raw ? expanded : showWords} aria-controls={showWords ? wordsId : undefined} onClick={() => {
            setExpanded(!expanded);
            setBrowsing(null);
          }}>
            {expanded ? 'Hide words' : 'Show words'}
          </button>
        ) : null}
      </div>
      {raw ? expanded && !showWords ? (
        <p className="small muted" role="status">
          {spoken.isPaused ? 'Transcript available when you’re back online.' : spoken.isError ? 'The transcript could not load.' : spoken.isPending ? 'Loading audiobook words…' : spoken.data ? 'No words in this part of the track.' : 'No transcript for this track.'}
          {spoken.isError ? <button type="button" className="btn btn-small btn-ghost" onClick={() => void spoken.refetch()}>Try again</button> : null}
        </p>
      ) : null : narration.state === 'before' ? (
        <p className="small muted" data-testid="readalong-before">
          {narration.next ? 'Before the text: it begins with' : 'Before the text: it begins in a later track.'}
        </p>
      ) : pastText ? (
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
            <SentenceLines key={trackKey} lines={lines} current={activeLine} word={activeWord} seek={seek} />
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
      {inBook || !edition.readAlong ? null : (
        <Link className="btn btn-small" to={`/books/${bookId}/read?edition=${edition.readAlong.textEditionId}`} data-testid="readalong-open">
          Follow in the book
        </Link>
      )}
    </section>
  );
}
