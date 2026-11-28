import { useMemo } from 'react';
import { type Chapter, type Edition, formatDuration } from '@bookclub/shared';
import { listEntries } from './tracks';

export function ListeningChapterList({ edition, chapters, track, ms, onLook }: {
  edition: Edition;
  chapters: readonly Chapter[];
  track: number;
  ms: number;
  onLook: (track: number, seconds: number) => void;
}) {
  const entries = useMemo(() => listEntries(edition, chapters), [edition, chapters]);
  const current = entries.findLastIndex((entry) => entry.track === track && entry.ms <= ms);
  return (
    <ol>
      {entries.map((entry, index) => (
        <li key={`${entry.track}:${entry.ms}:${entry.depth ?? 0}`} className={entry.depth ? 'track-chapter' : undefined}>
          {/* A chapter from the list is a look until Play, including chapters inside a file (D72, D254). */}
          <button
            type="button"
            className={`track-item${index === current ? ' is-current' : ''}`}
            aria-current={index === current ? 'true' : undefined}
            data-testid={entry.depth ? 'track-chapter' : 'track-item'}
            onClick={() => onLook(entry.track, entry.ms / 1000)}
          >
            <span>{entry.title}</span>
            <span className="faint small">{formatDuration(entry.durationMs)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
