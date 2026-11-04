import { useState } from 'react';
import { type CommentView, type HiddenNoteMedia, type NoteMediaView as NoteMediaViewModel } from '@bookclub/shared';
import { usePauseAudiobookWhile } from '../player/pauseWhile';
import { Icon } from './Icon';

const KIND_LABEL: Record<HiddenNoteMedia['kind'], string> = { voice: 'a voice note', photo: 'a photo', video: 'a video' };
const KIND_ICON: Record<HiddenNoteMedia['kind'], 'mic' | 'camera' | 'video'> = { voice: 'mic', photo: 'camera', video: 'video' };

/** What a media note still closed to you says (D140): its kind, never its bytes or duration. */
export function HiddenNoteMediaMarker({ media }: { media: readonly HiddenNoteMedia[] }) {
  if (media.length === 0) return null;
  const kind = media[0]!.kind;
  const label = kind === 'photo' && media.length > 1 ? `${media.length} photos` : KIND_LABEL[kind];
  return (
    <span className="note-media-marker" data-testid="note-media-marker" data-kind={kind}>
      <Icon name={KIND_ICON[kind]} size={14} /> {label}
    </span>
  );
}

function VoiceNotePlayer({ media }: { media: NoteMediaViewModel }) {
  const [playing, setPlaying] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  usePauseAudiobookWhile(playing);
  return (
    <div className="note-voice" data-testid="note-voice">
      {media.url ? (
        <audio controls src={media.url} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} data-testid="note-voice-player" />
      ) : (
        <p className="muted small">This voice note could not be made playable.</p>
      )}
      {media.transcriptStatus === 'ready' && media.transcript ? (
        <>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setShowTranscript((s) => !s)} data-testid="note-voice-transcript-toggle">
            {showTranscript ? 'Hide transcript' : 'Show transcript'}
          </button>
          {showTranscript ? <p className="note-voice-transcript small" data-testid="note-voice-transcript">{media.transcript}</p> : null}
        </>
      ) : media.transcriptStatus === 'queued' ? (
        <p className="muted small">Transcribing…</p>
      ) : null}
    </div>
  );
}

function VideoNotePlayer({ media }: { media: NoteMediaViewModel }) {
  const [playing, setPlaying] = useState(false);
  usePauseAudiobookWhile(playing);
  if (!media.url) return <p className="muted small">This video could not be made playable.</p>;
  return (
    <video
      controls
      src={media.url}
      poster={media.posterUrl ?? undefined}
      data-testid="note-video-player"
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
    />
  );
}

/** A note's media, in full, once it is open to you (D140): the voice player with its transcript
 * under it, a photo grid, or a video with its poster frame. */
export function NoteMediaGallery({ media }: { media: readonly NoteMediaViewModel[] }) {
  if (media.length === 0) return null;
  const kind = media[0]!.kind;
  if (kind === 'voice') return <VoiceNotePlayer media={media[0]!} />;
  if (kind === 'video') return <VideoNotePlayer media={media[0]!} />;
  return (
    <ul className="note-photos" data-testid="note-photos" aria-label={`${media.length} ${media.length === 1 ? 'photo' : 'photos'}`}>
      {media.map((m) =>
        m.url ? (
          <li key={m.id}>
            <a href={m.url} target="_blank" rel="noreferrer">
              <img src={m.url} alt="" loading="lazy" />
            </a>
          </li>
        ) : (
          <li key={m.id} className="muted small">
            A picture could not be read.
          </li>
        ),
      )}
    </ul>
  );
}

/** Either side of the gate (D140): the gallery when a note is open, else its kind alone. */
export function NoteMedia({ comment }: { comment: CommentView }) {
  if (comment.hidden) {
    const media = comment.media ?? [];
    return media.length > 0 ? <HiddenNoteMediaMarker media={media} /> : null;
  }
  const media = comment.media ?? [];
  return media.length > 0 ? <NoteMediaGallery media={media} /> : null;
}
