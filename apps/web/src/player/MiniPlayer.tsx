import { Link, useLocation, useNavigate } from 'react-router';
import { SKIP_BACK_SECONDS, formatDuration } from '@bookclub/shared';
import { coverSrc } from '../components/BookCard';
import { Icon } from '../components/Icon';
import { textFor } from '../lib/two-formats';
import { useAudio, useAudioState, useAudioTransportPlaying } from './AudioProvider';
import { chapterNamedAt, trackName } from './tracks';

/**
 * Keeps the audiobook within reach while browsing the club, and in a reader's `footer` while
 * reading along (never over the text, never changing the page's layout).
 */
export function MiniPlayer({ footer = false, onPlay }: { footer?: boolean; onPlay?: () => void }) {
  const state = useAudioState();
  const audio = useAudio();
  const transportPlaying = useAudioTransportPlaying();
  const location = useLocation();
  const navigate = useNavigate();
  if (!state.book || !state.edition || location.pathname.endsWith('/listen')) return null;
  // What is being heard: the chapter where it is known (in a track of several, the one playing, FR152), else the track.
  const chapter = chapterNamedAt(state.edition, state.track, state.position * 1000);
  const heard = (chapter != null ? state.book.chapters[chapter]?.title : undefined) ?? trackName(state.edition, state.track) ?? '';
  // The book is its text (D197): it opens where the narrator is, the audiobook docked under the
  // page; a book that is only an audiobook opens in the player.
  const text = textFor(state.book.editions, state.edition);
  const listen = text ? `/books/${state.book.id}/read?edition=${text.id}` : `/books/${state.book.id}/listen?edition=${state.edition.id}`;
  const opens = text ? 'open the book' : 'open the player';
  /** The book opens at the narrator's place: saved first, as the player's Show the text does (D197). */
  const open = (e: { preventDefault: () => void }) => {
    if (!text) return;
    e.preventDefault();
    void audio
      .saveNow()
      .catch(() => undefined)
      .finally(() => navigate(listen));
  };
  if (footer) {
    // In a reader's footer, beside the page numbers: nothing over the text (reading along).
    return (
      <span className="footer-player" role="group" aria-label="Now playing" data-testid="mini-player">
        {/* "What did they say?": back a little without leaving the page (D186). */}
        <button type="button" className="icon-btn" aria-label={`Back ${SKIP_BACK_SECONDS} seconds`} onClick={() => audio.seekBy(-SKIP_BACK_SECONDS)} data-testid="footer-skip-back">
          <Icon name="back15" size={18} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={transportPlaying ? 'Pause the audiobook' : 'Play the audiobook'}
          // Play in a reader starts where you are reading, unless the narrator is already here (D186).
          onClick={() => (transportPlaying || !onPlay ? audio.toggle() : onPlay())}
          data-testid="footer-play"
        >
          <Icon name={transportPlaying ? 'pause' : 'play'} size={20} />
        </button>
        <Link to={listen} onClick={open} className="icon-btn" aria-label={`${state.book.title}: ${heard}, ${opens}`}>
          <Icon name="headphones" size={18} />
        </Link>
      </span>
    );
  }
  return (
    <div className="mini-player" role="region" aria-label="Now playing" data-testid="mini-player">
      <Link to={listen} onClick={open} className="mini-link">
        <img src={coverSrc(state.book.coverUrl, 160)} width={40} height={60} alt="" />
        <span className="mini-text">
          <span className="mini-title">{state.book.title}</span>
          <span className="mini-sub small muted">
            {heard} · {formatDuration(state.position * 1000)}
          </span>
        </span>
      </Link>
      <button type="button" className="icon-btn" aria-label={transportPlaying ? 'Pause' : 'Play'} onClick={() => audio.toggle()}>
        <Icon name={transportPlaying ? 'pause' : 'play'} />
      </button>
      <button type="button" className="icon-btn" aria-label="Stop and close the player" onClick={() => audio.stop()}>
        <Icon name="close" />
      </button>
    </div>
  );
}
