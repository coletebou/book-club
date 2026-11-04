import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type BookMatch, formatBytes } from '@bookclub/shared';
import { Field, errorMessage } from '../components/Form';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { keys } from '../lib/queries';
import { holdScreenOn } from '../lib/wake-lock';
import { type Draft, draftFromFiles } from './metadata';
import {
  type FileJob,
  type UploadStatus,
  clearPending,
  finishImport,
  forgetFingerprints,
  loadPending,
  resumableImport,
  savePending,
  startImport,
  uploadAll,
} from './uploader';

const KIND_LABEL = { epub: 'EPUB', pdf: 'PDF', audio: 'Audiobook' } as const;
/** The format as a noun inside a sentence: "the PDF", "the audiobook". */
const KIND_NOUN = { epub: 'EPUB', pdf: 'PDF', audio: 'audiobook' } as const;
/**
 * An upload this large takes minutes on a phone's Wi-Fi: the dialog says to keep the screen on
 * (a locked iPhone stops Safari's page, and the upload with it). Smaller ones finish before a
 * phone locks; the screen is kept on for every upload where the browser can (D107).
 */
const LONG_UPLOAD_BYTES = 20 * 1024 * 1024;

interface Props {
  readonly clubId: string;
  /** Add a format to this book instead of creating a new one. */
  readonly bookId?: string;
  readonly onClose: () => void;
}

/**
 * Bring a book in: drop or choose an EPUB, a PDF or a folder of tracks. Title, author, cover and
 * track order are read from the files right away; the upload survives dropped connections and,
 * if the page reloads, picks up where it stopped once the same files are chosen again.
 */
export default function UploadModal({ clubId, bookId, onClose }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [order, setOrder] = useState<number[]>([]);
  const [attachTo, setAttachTo] = useState<string | null>(bookId ?? null);
  /** The member picked new-or-existing themselves; until then a matching book is the default. */
  const [attachChosen, setAttachChosen] = useState(false);
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [phase, setPhase] = useState<'pick' | 'confirm' | 'uploading' | 'finishing'>('pick');
  const [dragging, setDragging] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const current = useRef<string | null>(null);
  // "Stop this upload?" is about the upload going on: it is taken back when that ends, by itself.
  const stopQuestion = useRef<AbortController | null>(null);
  useEffect(() => () => stopQuestion.current?.abort(), []);
  // For the notice only: start() asks the server about the unfinished upload when it begins.
  const pending = useMemo(() => loadPending(clubId), [clubId]);
  const coverUrl = useMemo(() => (draft?.cover ? URL.createObjectURL(draft.cover) : null), [draft]);
  useEffect(() => () => (coverUrl ? URL.revokeObjectURL(coverUrl) : undefined), [coverUrl]);
  // While files go up, the screen stays on where the browser can keep it on: let go once they
  // are in, the upload fails or is stopped, and asked for again whenever the page is seen again.
  const sending = phase === 'uploading' || phase === 'finishing';
  useEffect(() => (sending ? holdScreenOn() : undefined), [sending]);

  const matches = useQuery({
    queryKey: ['book-matches', clubId, title, author],
    queryFn: () => api.bookMatches(clubId, title, author),
    enabled: !bookId && phase === 'confirm' && title.trim().length > 2,
    staleTime: 60_000,
  });
  const usefulMatches = (matches.data ?? []).filter((m: BookMatch) => draft && !m.kinds.includes(draft.kind));
  // The club has this very format of the book already: a second copy would be a second book, with
  // its own notes and progress, so it is said, and done only when asked for.
  const alreadyHave = usefulMatches.length === 0 ? ((matches.data ?? []).find((m: BookMatch) => draft && m.kinds.includes(draft.kind)) ?? null) : null;
  const [separate, setSeparate] = useState(false);
  // Another format of a book the club already has joins it unless the member says otherwise: one
  // missed tap must not split a book's discussion in two.
  const firstMatch = usefulMatches[0]?.bookId ?? null;
  useEffect(() => {
    if (!bookId && !attachChosen) setAttachTo(firstMatch);
  }, [bookId, attachChosen, firstMatch]);

  const pick = async (files: File[]) => {
    setError(null);
    setReading(true);
    try {
      const d = await draftFromFiles(files);
      setDraft(d);
      setTitle(d.title);
      setAuthor(d.author);
      setOrder(d.tracks.map((_, i) => i));
      setPhase('confirm');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReading(false);
    }
  };

  const jobsFor = (d: Draft): FileJob[] => {
    const jobs: FileJob[] = [];
    if (d.kind === 'audio') order.forEach((i) => jobs.push({ index: jobs.length, file: d.tracks[i]!.file, name: d.tracks[i]!.file.name, role: 'track' }));
    else if (d.main) jobs.push({ index: 0, file: d.main, name: d.main.name, role: 'main' });
    // EPUB covers are taken from the book itself on the server; PDFs and folders send theirs.
    if (d.cover && d.kind !== 'epub') jobs.push({ index: jobs.length, file: d.cover, name: d.coverName ?? 'cover.jpg', role: 'cover' });
    return jobs;
  };

  const start = async () => {
    if (!draft) return;
    const jobs = jobsFor(draft);
    abort.current = new AbortController();
    const signal = abort.current.signal;
    setPhase('uploading');
    setError(null);
    try {
      const shape = jobs.map((j) => ({ name: j.name, size: j.file.size, role: j.role }));
      // Same files as an unfinished upload: continue it, sending only what the server lacks.
      const resumed = await resumableImport(clubId, shape);
      let importId: string;
      if (resumed) {
        importId = resumed.id;
      } else {
        const imp = await startImport(clubId, draft.kind, jobs);
        importId = imp.id;
        savePending({ importId, clubId, kind: draft.kind, files: shape, startedAt: Date.now() });
      }
      current.current = importId;
      if (resumed?.status !== 'finalized') {
        await uploadAll(importId, jobs, setStatus, signal, new Set(resumed?.files.filter((f) => f.complete).map((f) => f.index)));
      }
      setPhase('finishing');
      const trackJobs = jobs.filter((j) => j.role === 'track');
      const result = await finishImport(
        importId,
        {
          title: title.trim() || 'Untitled',
          author: author.trim(),
          ...(attachTo ? { bookId: attachTo } : {}),
          ...(draft.kind === 'audio' ? { trackOrder: trackJobs.map((j) => j.index), trackTitles: order.map((i) => draft.tracks[i]!.title) } : {}),
        },
        signal,
      );
      clearPending(clubId);
      forgetFingerprints(importId);
      current.current = null;
      stopQuestion.current?.abort();
      await qc.invalidateQueries({ queryKey: keys.books(clubId) });
      await qc.invalidateQueries({ queryKey: keys.book(result.bookId) });
      toast.show(`${KIND_LABEL[draft.kind]} added. Preparing it now…`);
      onClose();
      void navigate(`/books/${result.bookId}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      stopQuestion.current?.abort();
      setError(errorMessage(err));
      setPhase('confirm');
    }
  };

  const cancel = async () => {
    if (phase === 'uploading' || phase === 'finishing') {
      stopQuestion.current = new AbortController();
      const stop = await confirmAction({
        title: 'Stop this upload?',
        body: 'What was sent so far is discarded.',
        confirm: 'Stop',
        cancel: 'Keep uploading',
        danger: true,
        signal: stopQuestion.current.signal,
      });
      stopQuestion.current = null;
      if (!stop) return;
      abort.current?.abort();
      const importId = current.current;
      if (importId) {
        void api.cancelImport(importId).catch(() => undefined);
        clearPending(clubId);
        forgetFingerprints(importId);
      }
    }
    onClose();
  };

  const move = (from: number, to: number) => {
    setOrder((o) => {
      if (to < 0 || to >= o.length) return o;
      const next = [...o];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  };

  const percent = status && status.total > 0 ? Math.floor((status.sent / status.total) * 100) : 0;

  return (
    <Modal title={bookId ? 'Add a format' : 'Add a book'} onClose={() => void cancel()} wide>
      {phase === 'pick' ? (
        <div className="stack">
          {pending ? (
            <p className="notice" data-testid="resume-notice">
              An upload of {pending.files.length} {pending.files.length === 1 ? 'file' : 'files'} did not finish. Choose the same {pending.kind === 'audio' ? 'tracks' : 'file'} again to continue where it stopped.
            </p>
          ) : null}
          <div
            className={`dropzone${dragging ? ' is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void pick([...e.dataTransfer.files]);
            }}
          >
            <Icon name="upload" size={30} />
            {/* A touch screen has nothing to drop: it chooses (an audiobook's tracks all at once). */}
            <p className="drop-hint">Drop an EPUB, a PDF, or audiobook tracks here</p>
            <p className="touch-hint">Choose an EPUB, a PDF, or all of an audiobook’s tracks at once</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={reading}>
                Choose files
              </button>
              <button type="button" className="btn" onClick={() => folderInput.current?.click()} disabled={reading}>
                Choose a folder
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".epub,.pdf,audio/*,.mp3,.m4a,.m4b,.ogg,.opus,.flac,image/*"
              className="visually-hidden"
              data-testid="file-input"
              aria-label="Choose files"
              onChange={(e) => void pick([...(e.target.files ?? [])])}
            />
            <input
              ref={folderInput}
              type="file"
              multiple
              className="visually-hidden"
              data-testid="folder-input"
              aria-label="Choose a folder"
              {...{ webkitdirectory: '', directory: '' }}
              onChange={(e) => void pick([...(e.target.files ?? [])])}
            />
          </div>
          {reading ? (
            <p className="muted" role="status">
              <span className="spinner spinner-inline" aria-hidden="true" /> Reading the files…
            </p>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {phase !== 'pick' && draft ? (
        <div className="upload-confirm">
          <div className="upload-preview">
            {coverUrl ? (
              <img src={coverUrl} alt="Cover found in the files" width={120} height={180} data-testid="upload-cover" />
            ) : (
              // A PDF's first page blank here (D103): the server draws it, or makes a cover.
              <div className="cover-placeholder" data-testid="upload-no-cover">
                {draft.kind === 'pdf' ? 'The cover is made from the PDF once it is uploaded.' : 'No cover in the files: one will be made.'}
              </div>
            )}
            <span className="chip chip-gold">{KIND_LABEL[draft.kind]}</span>
            <span className="small faint">{formatBytes(jobsFor(draft).reduce((s, j) => s + j.file.size, 0))}</span>
          </div>
          <div className="stack">
            {/* A format added to a book is that book's: its title and author are the book's own. */}
            {bookId ? null : (
              <>
                <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="upload-title" disabled={phase !== 'confirm'} />
                <Field label="Author" value={author} onChange={(e) => setAuthor(e.target.value)} data-testid="upload-author" disabled={phase !== 'confirm'} />
              </>
            )}
            {!bookId && usefulMatches.length > 0 && phase === 'confirm' ? (
              <fieldset className="match-box">
                <legend>Is this another format of a book you already have?</legend>
                {usefulMatches.map((m) => (
                  <label key={m.bookId}>
                    <input
                      type="radio"
                      name="attach"
                      checked={attachTo === m.bookId}
                      onChange={() => {
                        setAttachChosen(true);
                        setAttachTo(m.bookId);
                      }}
                      data-testid="attach-match"
                    />
                    Add as the {KIND_NOUN[draft.kind]} of “{m.title}”
                  </label>
                ))}
                <label>
                  <input
                    type="radio"
                    name="attach"
                    checked={attachTo === null}
                    onChange={() => {
                      setAttachChosen(true);
                      setAttachTo(null);
                    }}
                    data-testid="attach-new"
                  />{' '}
                  A new book
                </label>
              </fieldset>
            ) : null}
            {!bookId && alreadyHave && phase === 'confirm' ? (
              <div className="notice already-have" role="note" data-testid="already-have">
                <p>
                  The club already has the {KIND_NOUN[draft.kind]} of “{alreadyHave.title}”.{' '}
                  <Link to={`/books/${alreadyHave.bookId}`} onClick={onClose}>
                    Open it
                  </Link>
                  , or add this one as a separate book, with notes and progress of its own.
                </p>
                <label>
                  <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} data-testid="add-separately" /> Add it as a separate book
                </label>
              </div>
            ) : null}
            {draft.kind === 'audio' ? (
              <div>
                <h3 className="small-title">Tracks, in play order</h3>
                <ol className="track-order" data-testid="track-order">
                  {order.map((i, pos) => (
                    <li key={i} data-testid="track-row">
                      <span className="track-pos">{pos + 1}</span>
                      <span className="track-name">
                        {draft.tracks[i]!.title}
                        <span className="faint small"> · {draft.tracks[i]!.file.name}</span>
                      </span>
                      <button type="button" className="icon-btn" aria-label={`Move ${draft.tracks[i]!.title} up`} onClick={() => move(pos, pos - 1)} disabled={pos === 0 || phase !== 'confirm'}>
                        ↑
                      </button>
                      <button type="button" className="icon-btn" aria-label={`Move ${draft.tracks[i]!.title} down`} onClick={() => move(pos, pos + 1)} disabled={pos === order.length - 1 || phase !== 'confirm'}>
                        ↓
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {phase === 'uploading' || phase === 'finishing' ? (
              <div className="upload-progress" role="status" aria-live="polite">
                <progress max={100} value={percent} aria-label="Upload progress" data-testid="upload-progress" data-sent={status?.sent ?? 0} />
                <p className="small muted">
                  {phase === 'finishing'
                    ? 'Finishing…'
                    : status?.waiting
                      ? `Paused at ${percent}%: waiting for the connection. It will continue by itself.`
                      : `${percent}% · ${formatBytes(status?.sent ?? 0)} of ${formatBytes(status?.total ?? 0)}`}
                </p>
                {(status?.total ?? 0) >= LONG_UPLOAD_BYTES ? (
                  <p className="small muted" data-testid="keep-screen-on">
                    Keep this screen on until it finishes. If your phone locks, the upload pauses and goes on when you come back.
                  </p>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => void cancel()}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={phase !== 'confirm' || !title.trim() || (!!alreadyHave && !separate)} data-testid="upload-start">
                {phase === 'confirm' ? 'Upload' : 'Uploading…'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
