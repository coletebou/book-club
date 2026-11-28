import { type CSSProperties, type ReactNode, useId, useMemo, useState } from 'react';
import { type AudioLocator, type BookDetail, SKIP_BACK_SECONDS, SKIP_FORWARD_SECONDS, chapterHeading, formatDuration, formatPercent } from '@bookclub/shared';
import { coverSrc } from '../components/BookCard';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { supportsVoiceRecording } from '../lib/media-capture';
import { useBrowserOnline } from '../lib/online';
import { useParty, useSession } from '../lib/queries';
import { PartyBar } from '../live/PartyBar';
import { tOf } from '../reader/position';
import { useAudio, useAudioState, useAudioTransportPlaying } from './AudioProvider';
import { AskListeningCal, ListeningNote, ListeningReactions } from './ListeningActions';
import { ListeningChapterList } from './ListeningChapterList';
import { listeningCaptureAllowed, useListeningCaptureAllowed } from './native-bridge';
import { atBookStart, chapterStep, chapterStops } from './now-playing';
import { PassingReactions } from './PassingReactions';
import { ReadAlongPanel } from './ReadAlong';
import { SpeedSlot } from './SpeedSlot';
import { chapterNamedAt, trackName } from './tracks';

/** What is being heard: the chapter where it is known (in a track of several, the one playing, FR152), else the track. */
function useHeard(book: BookDetail) {
  const state = useAudioState();
  const edition = state.edition;
  const ms = state.position * 1000;
  const chapter = edition ? chapterNamedAt(edition, state.track, ms) : null;
  const title = (chapter != null ? book.chapters[chapter]?.title : undefined) ?? (edition ? trackName(edition, state.track) : null) ?? book.title;
  const duration = state.duration > 0 ? state.duration : (edition?.tracks[state.track]?.durationMs ?? 0) / 1000;
  const t = edition ? tOf(edition, { kind: 'audio', track: state.track, ms }) : 0;
  return { state, edition, title, ms, duration, t };
}

/** The track's scrubber, with the time heard and the time left in it. */
function Scrubber({ book, testId, className }: { book: BookDetail; testId: string; className: string }) {
  const audio = useAudio();
  const { state, ms, duration, title } = useHeard(book);
  return (
    <div className={className}>
      <span className="dock-time" data-testid={`${testId}-current`}>
        {formatDuration(ms)}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(1, Math.floor(duration))}
        step={1}
        value={Math.floor(state.position)}
        onChange={(e) => audio.seek(Number(e.target.value))}
        aria-label={`Position in ${chapterHeading(title)}`}
        aria-valuetext={`${formatDuration(ms)} of ${formatDuration(duration * 1000)}`}
        // How far, for the track's filled part (a range's own progress is not styleable in WebKit).
        style={{ '--done': `${Math.min(100, (state.position / Math.max(1, duration)) * 100)}%` } as CSSProperties}
        data-testid={testId}
      />
      <span className="dock-time">−{formatDuration(Math.max(0, duration * 1000 - ms))}</span>
    </div>
  );
}

/**
 * The audiobook over the page, docked in a reader's footer (D194; text first, D197). The scrubber
 * across its top; Stop, the page numbers (`info`) and Now in this book; the page arrows (`prev`,
 * `next`) at the ends of its controls. Ask Cal fits beside Now in this book (D236).
 */
export function ReaderDock({ book, prev, next, info, onPlay, onStop, onOpenPlayer }: { book: BookDetail; prev: ReactNode; next: ReactNode; info: ReactNode; onPlay: () => void; onStop: () => void; onOpenPlayer: () => void }) {
  const audio = useAudio();
  const playing = useAudioTransportPlaying();
  const { title, edition, state } = useHeard(book);
  const [open, setOpen] = useState(false);
  return (
    <div className="reader-dock" role="group" aria-label={`Now playing: ${chapterHeading(title)}`} data-testid="mini-player">
      {edition ? <PassingReactions bookId={book.id} edition={edition} /> : null}
      <div className="dock-heard" aria-hidden="true">
        {chapterHeading(title)}
      </div>
      <Scrubber book={book} testId="dock-scrubber" className="dock-scrub" />
      {prev}
      <div className="dock-meta">
        {/* Stop listening: the audiobook goes from the footer, its place saved; the page stays. */}
        <button type="button" className="icon-btn dock-stop" aria-label="Stop the audiobook" onClick={onStop} data-testid="dock-stop">
          <Icon name="close" size={18} />
        </button>
        <div className="dock-info">{info}</div>
        <AskListeningCal book={book} compact />
        <button type="button" className="icon-btn dock-expand" aria-label="Open Now in this book" aria-expanded={open} onClick={() => setOpen(true)} data-testid="dock-expand">
          <Icon name="expand" size={20} />
        </button>
      </div>
      <div className="dock-controls footer-player">
        {/* "What did they say?": back a little without leaving the page (D186). */}
        <button type="button" className="icon-btn" aria-label={`Back ${SKIP_BACK_SECONDS} seconds`} onClick={() => audio.seekBy(-SKIP_BACK_SECONDS)} data-testid="footer-skip-back">
          <Icon name="back15" size={20} />
        </button>
        <button
          type="button"
          className="icon-btn dock-play"
          aria-label={playing ? 'Pause the audiobook' : 'Play the audiobook'}
          // Play in a reader starts where you are reading, unless the narrator is already here (D186).
          onClick={() => (playing ? audio.pause() : onPlay())}
          data-testid="footer-play"
          data-playing={playing ? 'true' : 'false'}
        >
          <Icon name={playing ? 'pause' : 'play'} size={22} />
        </button>
        <button type="button" className="icon-btn" aria-label={`Forward ${SKIP_FORWARD_SECONDS} seconds`} onClick={() => audio.seekBy(SKIP_FORWARD_SECONDS)} data-testid="footer-skip-forward">
          <Icon name="fwd30" size={20} />
        </button>
        <SpeedSlot compact />
      </div>
      {next}
      {state.error && !open ? <p className="form-error" role="alert">{state.error}</p> : null}
      {open ? (
        <NowPlayingSheet
          book={book}
          onPlay={onPlay}
          onClose={() => setOpen(false)}
          onStop={() => {
            setOpen(false);
            onStop();
          }}
          onOpenPlayer={() => {
            setOpen(false);
            onOpenPlayer();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Now in this book (D194): the player over the page, the page and the narrator going on under it.
 * The cover and the chapter, the scrubber and how far through the book, the tracks, the skips,
 * Play, the speed and the sleep timer, notes and reactions at the narrator's place (D236), the
 * reading-along lines, then the full player and Stop (D197).
 */
export function NowPlayingSheet({ book, onPlay, onClose, onStop, onOpenPlayer }: { book: BookDetail; onPlay: () => void; onClose: () => void; onStop: () => void; onOpenPlayer: () => void }) {
  const audio = useAudio();
  const playing = useAudioTransportPlaying();
  const { state, edition, title, ms, t } = useHeard(book);
  const online = useBrowserOnline();
  const canCapture = useListeningCaptureAllowed();
  const party = useParty(book.id).data;
  const userId = useSession().data?.user?.id;
  const inParty = !!party && party.editionId === edition?.id && party.members.some((member) => member.userId === userId);
  const [showChapters, setShowChapters] = useState(false);
  const chaptersId = useId();
  const stops = useMemo(() => edition ? chapterStops(edition, book.chapters) : [], [edition, book.chapters]);
  const [note, setNote] = useState<{ locator: AudioLocator; recordVoice: boolean } | null>(null);
  const openNote = (recordVoice: boolean) => {
    if (recordVoice && !listeningCaptureAllowed()) return;
    const locator = audio.locator();
    if (locator) setNote({ locator, recordVoice });
  };
  if (!edition) return null;
  const here = { kind: 'audio' as const, track: state.track, ms };
  const previous = chapterStep(stops, here, -1);
  const next = chapterStep(stops, here, 1);
  const goTo = (stop: { track: number; ms: number } | null) => {
    if (stop) audio.setTrack(stop.track, stop.ms / 1000);
  };
  const play = () => {
    if (playing) audio.pause();
    else if (state.returnTo) void audio.play();
    else onPlay();
  };
  return (
    <Modal title="Now in this book" onClose={onClose} className="now-playing-sheet" initialFocus='[data-testid="sheet-play"]'>
      <div className="now-playing" data-testid="now-playing">
        <div className="now-playing-head">
          <img src={coverSrc(book.coverUrl, 320)} width={72} height={108} alt="" />
          <div className="now-playing-text">
            <span className="folio-label small">{book.title}</span>
            <strong className="now-playing-title" data-testid="now-playing-title">
              {chapterHeading(title)}
            </strong>
            <span className="small muted">
              {book.author} · {formatPercent(t)} of the book
            </span>
          </div>
        </div>
        {state.returnTo ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => audio.back()}>
            <Icon name="back" size={16} /> Back to saved place
          </button>
        ) : null}
        {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
        <Scrubber book={book} testId="sheet-scrubber" className="dock-scrub now-playing-scrub" />
        <div className="transport" role="group" aria-label="Playback">
          <button type="button" className="icon-btn" aria-label="Previous chapter" onClick={() => goTo(previous)} disabled={!previous || atBookStart(stops, here)}>
            <Icon name="prev" />
          </button>
          <button type="button" className="icon-btn transport-skip" aria-label={`Back ${SKIP_BACK_SECONDS} seconds`} onClick={() => audio.seekBy(-SKIP_BACK_SECONDS)}>
            <Icon name="back15" />
            <span className="skip-num">{SKIP_BACK_SECONDS}</span>
          </button>
          <button type="button" className="play-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={play} data-testid="sheet-play" data-playing={playing ? 'true' : 'false'}>
            <Icon name={playing ? 'pause' : 'play'} size={30} />
          </button>
          <button type="button" className="icon-btn transport-skip" aria-label={`Forward ${SKIP_FORWARD_SECONDS} seconds`} onClick={() => audio.seekBy(SKIP_FORWARD_SECONDS)}>
            <Icon name="fwd30" />
            <span className="skip-num">{SKIP_FORWARD_SECONDS}</span>
          </button>
          <button type="button" className="icon-btn" aria-label="Next chapter" onClick={() => goTo(next)} disabled={!next}>
            <Icon name="next" />
          </button>
        </div>
        <div className="listen-tools">
          <button type="button" className="btn btn-small" disabled={inParty} aria-expanded={showChapters && !inParty} aria-controls={showChapters && !inParty ? chaptersId : undefined} onClick={() => setShowChapters(!showChapters)}>
            <Icon name="toc" size={16} /> Chapters
          </button>
          <SpeedSlot testId="sheet-speed" />
          <label className="speed">
            <span className="visually-hidden">Sleep timer</span>
            <select
              value={state.sleepAtTrackEnd ? 'track' : state.sleepUntil ? 'on' : 'off'}
              onChange={(e) => {
                const v = e.target.value;
                audio.setSleep(v === 'off' ? 'off' : v === 'track' ? 'track' : Number(v));
              }}
              data-testid="sheet-sleep"
            >
              <option value="off">Sleep: off</option>
              <option value="15">Sleep in 15 min</option>
              <option value="30">Sleep in 30 min</option>
              <option value="60">Sleep in 60 min</option>
              <option value="track">End of track</option>
              {state.sleepUntil ? <option value="on">Sleep at {new Date(state.sleepUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</option> : null}
            </select>
          </label>
        </div>
        {showChapters && !inParty ? (
          <section className="track-list" id={chaptersId} aria-label="Chapters" tabIndex={0}>
            <ListeningChapterList edition={edition} chapters={book.chapters} track={state.track} ms={ms} onLook={(track, seconds) => audio.look(track, seconds)} />
          </section>
        ) : null}
        <div className="listen-tools" role="group" aria-label="At this moment">
          <AskListeningCal book={book} />
          <button type="button" className="btn btn-small" onClick={() => openNote(false)}>
            <Icon name="quill" size={16} /> Note here
          </button>
          {online && canCapture && supportsVoiceRecording() ? (
            <button type="button" className="btn btn-small" onClick={() => openNote(true)}>
              <Icon name="mic" size={16} /> Record voice note
            </button>
          ) : null}
        </div>
        <ListeningReactions bookId={book.id} editionId={edition.id} locate={() => audio.locator()} />
        {online ? <PartyBar bookId={book.id} editionId={edition.id} /> : null}
        <ReadAlongPanel bookId={book.id} edition={book.editions.find(({ id }) => id === edition.id) ?? edition} track={state.track} ms={ms} onSeek={(seconds) => audio.seek(seconds)} inBook />
        <div className="now-playing-modes">
          <button type="button" className="btn btn-small" onClick={onOpenPlayer} data-testid="open-full-player">
            <Icon name="headphones" size={16} /> Full player
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={onStop} data-testid="sheet-stop">
            <Icon name="close" size={16} /> Stop listening
          </button>
        </div>
      </div>
      {note ? <ListeningNote book={book} edition={edition} {...note} onClose={() => setNote(null)} /> : null}
    </Modal>
  );
}

/**
 * The one obvious Play (D194): reading along asked for and the browser waiting for a tap, over the
 * middle of the page. Its tap is the one that starts the audiobook.
 */
export function AlongStart({ where, onPlay }: { where: string; onPlay: () => void }) {
  return (
    <div className="along-start" data-testid="along-start-wrap">
      <button type="button" className="along-start-btn" onClick={onPlay} data-testid="along-start">
        <span className="along-start-disc" aria-hidden="true">
          <Icon name="play" size={34} />
        </span>
        <span className="along-start-label">Read along from here</span>
        <span className="along-start-where small">{where}</span>
      </button>
    </div>
  );
}
