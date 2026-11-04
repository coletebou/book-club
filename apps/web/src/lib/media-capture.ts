import { LIMITS } from '@bookclub/shared';

/**
 * Media notes (D140): capturing and checking a voice recording, photo or video in the browser,
 * before it is sent (api.uploadNoteMedia). Voice is recorded live (MediaRecorder); a photo or
 * video comes from the device's own picker (`<input type=file accept capture>`), which already
 * gives "from the library, or take one now" on a phone without any camera UI of our own to build
 * or maintain. The server is the real gate (content-sniffed, resized, transcoded); these checks
 * are only so a bad pick is never uploaded in the first place.
 */

/** Browsers that can record: MediaRecorder and mic access both exist. */
export function supportsVoiceRecording(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaRecorder === 'function' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * The mimeType to record voice in: iOS Safari/WKWebView only ever offers audio/mp4 (AAC); Chrome
 * and Firefox offer audio/webm with Opus. Tried in the order a browser is most likely to accept,
 * so the first supported one is used; undefined lets MediaRecorder pick its own default.
 */
export function pickVoiceMimeType(recorder: Pick<typeof MediaRecorder, 'isTypeSupported'> = MediaRecorder): string | undefined {
  for (const type of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    try {
      if (recorder.isTypeSupported(type)) return type;
    } catch {
      // isTypeSupported itself can throw on an unsupported string
    }
  }
  return undefined;
}

export interface MediaCheck {
  readonly ok: boolean;
  readonly message: string | null;
}

/** A picked photo, checked client-side before upload: only its size (its content is checked server-side). */
export function checkPhotoFile(file: File): MediaCheck {
  if (file.size > LIMITS.photoNoteBytes) return { ok: false, message: `That picture is larger than ${Math.round(LIMITS.photoNoteBytes / (1024 * 1024))} MB.` };
  return { ok: true, message: null };
}

/** How long a media file plays, read by loading it (no upload yet): rejects if it never loads. */
export function readMediaDurationMs(file: File, kind: 'audio' | 'video'): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind);
    const url = URL.createObjectURL(file);
    const done = (fn: () => void) => {
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      fn();
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(() => resolve(Number.isFinite(el.duration) ? el.duration * 1000 : 0));
    el.onerror = () => done(() => reject(new Error('That file could not be read.')));
    el.src = url;
  });
}

/** A picked video, checked client-side before upload: its size, and (once read) its length. */
export async function checkVideoFile(file: File): Promise<MediaCheck> {
  if (file.size > LIMITS.videoNoteBytes) return { ok: false, message: `That video is larger than ${Math.round(LIMITS.videoNoteBytes / (1024 * 1024))} MB.` };
  try {
    const durationMs = await readMediaDurationMs(file, 'video');
    if (durationMs > LIMITS.videoNoteSeconds * 1000 + 2000) return { ok: false, message: `That video is longer than ${Math.round(LIMITS.videoNoteSeconds / 60)} minutes.` };
  } catch {
    return { ok: false, message: 'That video could not be read.' };
  }
  return { ok: true, message: null };
}

/** A filename to send with an upload (the server never trusts it, but it helps logs and names). */
export function suggestedFilename(kind: 'voice' | 'photo' | 'video', mimeType: string | undefined): string {
  const ext = mimeType?.includes('mp4') ? (kind === 'voice' ? 'm4a' : 'mp4') : mimeType?.includes('webm') ? 'webm' : mimeType?.includes('ogg') ? 'ogg' : kind === 'voice' ? 'm4a' : 'bin';
  return `note-${kind}-${Date.now()}.${ext}`;
}
