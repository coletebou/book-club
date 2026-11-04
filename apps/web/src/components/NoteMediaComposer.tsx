import { useEffect, useRef, useState } from 'react';
import { LIMITS, type NoteMediaKind } from '@bookclub/shared';
import { ApiError, api, browserOffline } from '../lib/api';
import { checkPhotoFile, checkVideoFile, suggestedFilename, supportsVoiceRecording } from '../lib/media-capture';
import { usePauseAudiobookWhile } from '../player/pauseWhile';
import { Icon } from './Icon';
import { VoiceRecorder } from './VoiceRecorder';

export interface MediaAttachment {
  /** The server's id once uploaded; a client-only placeholder while it is in flight. */
  id: string;
  kind: NoteMediaKind;
  status: 'uploading' | 'ready' | 'failed';
  previewUrl: string | null;
  error: string | null;
}

/**
 * Attach a voice recording, 1-4 photos, or a short video to a note or reply (D140): one kind at a
 * time (attaching a photo locks out voice and video, and the other way round, until every
 * attachment is removed). Offline, attaching is refused outright with a clear message (D140's
 * explicit choice over a half-built offline media queue): text notes still work offline
 * (lib/outbox.ts), but a recording or a picture needs the upload to actually go somewhere.
 */
export function NoteMediaComposer({
  bookId,
  attachments,
  onChange,
  disabled = false,
}: {
  bookId: string;
  attachments: readonly MediaAttachment[];
  onChange: (next: MediaAttachment[] | ((prev: MediaAttachment[]) => MediaAttachment[])) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [offline, setOffline] = useState(browserOffline());
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  usePauseAudiobookWhile(recording);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const kind = attachments[0]?.kind ?? null;
  const busy = attachments.some((a) => a.status === 'uploading');
  const locked = disabled || offline;

  // Every update goes through the functional form of onChange (React's setState updater), never
  // a snapshot of this render's `attachments`: `upload` keeps running across an await, and by the
  // time it resolves this render's `attachments` closure is stale (the "add placeholder" update
  // it made itself has already moved the real state on); reading `prev` fresh each time is what
  // makes the upload's own placeholder reliably findable afterwards.
  const setOne = (id: string, patch: Partial<MediaAttachment>) => onChange((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const remove = (id: string) => {
    const a = attachments.find((x) => x.id === id);
    if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
    if (a && a.status !== 'uploading' && !a.id.startsWith('tmp-')) void api.discardNoteMedia(a.id).catch(() => {});
    onChange((prev) => prev.filter((x) => x.id !== id));
  };

  const upload = async (uploadKind: NoteMediaKind, file: Blob, filename: string, previewUrl: string | null) => {
    const tmp = `tmp-${Math.random().toString(36).slice(2)}`;
    onChange((prev) => [...prev, { id: tmp, kind: uploadKind, status: 'uploading', previewUrl, error: null }]);
    try {
      const uploaded = await api.uploadNoteMedia(bookId, uploadKind, file, filename);
      setOne(tmp, { id: uploaded.id, status: uploaded.status === 'ready' ? 'ready' : 'failed', error: uploaded.error });
    } catch (err) {
      setOne(tmp, { status: 'failed', error: err instanceof ApiError ? err.message : 'That upload failed.' });
    }
  };

  const onVoiceUse = (blob: Blob, mimeType: string, _durationMs: number) => {
    setRecording(false);
    void upload('voice', blob, suggestedFilename('voice', mimeType), URL.createObjectURL(blob));
  };

  const onPhotos = (files: FileList | null) => {
    if (!files) return;
    const room = LIMITS.photosPerNote - attachments.length;
    for (const file of Array.from(files).slice(0, Math.max(0, room))) {
      const check = checkPhotoFile(file);
      if (!check.ok) {
        onChange((prev) => [...prev, { id: `tmp-${Math.random().toString(36).slice(2)}`, kind: 'photo', status: 'failed', previewUrl: null, error: check.message }]);
        continue;
      }
      void upload('photo', file, file.name, URL.createObjectURL(file));
    }
  };

  const onVideo = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const check = await checkVideoFile(file);
    if (!check.ok) {
      onChange((prev) => [...prev, { id: `tmp-${Math.random().toString(36).slice(2)}`, kind: 'video', status: 'failed', previewUrl: null, error: check.message }]);
      return;
    }
    void upload('video', file, file.name, URL.createObjectURL(file));
  };

  const canAddMorePhotos = kind === 'photo' && attachments.length < LIMITS.photosPerNote;
  const showPicker = !locked && !recording && (kind === null || (kind === 'photo' && canAddMorePhotos));

  return (
    <div className="note-media-composer" data-testid="note-media-composer">
      {offline ? <p className="muted small" data-testid="media-offline-notice">No connection: voice, photo and video notes need one. Text still works offline.</p> : null}
      {attachments.length > 0 ? (
        <ul className="media-attachments" aria-label="Attached media">
          {attachments.map((a) => (
            <li key={a.id} className={`media-attachment media-attachment-${a.kind}`} data-testid="media-attachment" data-status={a.status}>
              {a.kind === 'photo' && a.previewUrl ? <img src={a.previewUrl} alt="" /> : null}
              {a.kind === 'video' && a.previewUrl ? <video src={a.previewUrl} muted /> : null}
              {a.kind === 'voice' && a.previewUrl ? <audio src={a.previewUrl} controls /> : null}
              {a.status === 'uploading' ? <span className="media-uploading small">Uploading…</span> : null}
              {a.status === 'failed' ? <span className="media-failed small" role="alert">{a.error ?? 'That failed.'}</span> : null}
              <button type="button" className="icon-btn media-remove" aria-label="Remove" onClick={() => remove(a.id)} data-testid="media-remove">
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {recording ? (
        <VoiceRecorder onUse={onVoiceUse} onCancel={() => setRecording(false)} />
      ) : showPicker ? (
        // Reached only when nothing of a different kind is attached yet (showPicker's own gate,
        // just above): kind is null here, or 'photo' with room for more — never 'voice' or
        // 'video', which lock out every other button the moment one is attached.
        <div className="media-picker row" role="group" aria-label="Attach media">
          {kind === null ? (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setRecording(true)} disabled={!supportsVoiceRecording()} data-testid="attach-voice">
              <Icon name="mic" size={16} /> Voice
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-small" onClick={() => photoInputRef.current?.click()} data-testid="attach-photo">
            <Icon name="camera" size={16} /> Photo
          </button>
          <input ref={photoInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => onPhotos(e.target.files)} data-testid="attach-photo-input" />
          {kind === null ? (
            <>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => videoInputRef.current?.click()} data-testid="attach-video">
                <Icon name="video" size={16} /> Video
              </button>
              <input ref={videoInputRef} type="file" accept="video/*" hidden onChange={(e) => void onVideo(e.target.files)} data-testid="attach-video-input" />
            </>
          ) : null}
        </div>
      ) : null}
      {busy ? <p className="muted small" aria-live="polite">Uploading…</p> : null}
    </div>
  );
}

/** The ids a note may be posted with: only what finished processing; nothing still in flight. */
export function mediaIdsOf(attachments: readonly MediaAttachment[]): string[] {
  return attachments.filter((a) => a.status === 'ready').map((a) => a.id);
}

/** Whether any attachment is still uploading: submitting would leave it out silently. */
export function mediaBusy(attachments: readonly MediaAttachment[]): boolean {
  return attachments.some((a) => a.status === 'uploading');
}

/** Give back an upload nobody will post after all (the composer was cancelled or closed). */
export function discardAllMedia(attachments: readonly MediaAttachment[]): void {
  for (const a of attachments) {
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    if (a.status !== 'uploading' && !a.id.startsWith('tmp-')) void api.discardNoteMedia(a.id).catch(() => {});
  }
}
