import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  type Chapter,
  type ChapterLike,
  type CommentView,
  type HiddenComment,
  type MemberProgress,
  formatNames,
  LIMITS,
  REACTIONS,
  REACTION_LABELS,
  type Reaction,
  formatPercent,
  chapterNameAt,
  chapterNames,
  formatWhen,
} from '@bookclub/shared';
import { MeetingReachedCard, type MeetingReachedInfo } from '../components/Meeting';
import { Modal } from '../components/Modal';
import { type MediaAttachment, NoteMediaComposer, discardAllMedia, mediaBusy, mediaIdsOf } from '../components/NoteMediaComposer';
import { askToDelete, confirmAction } from '../lib/confirm';
import { type Closed, fromFurtherOn, nearButClosed, notAsFar, notAsFarLine, placeName, reactionAlone, reactionOnly, readRangesOf, whyClosed } from '../lib/further';
import { Replies } from '../components/Thread';
import { NoteMedia } from '../components/NoteMediaView';
import { NO_REPLIES } from '../lib/threads';
import { Avatar } from '../components/People';
import { Icon } from '../components/Icon';
import { errorMessage } from '../components/Form';
import { newClientId } from '../lib/api';
import { FONTS, FONT_SCALES, type FontChoice, type ReaderSettings, THEMES, type ThemeName } from './epub/layout';

/**
 * This book's audiobook in the reader (D197): its own choice over your default (Settings), for a
 * book with an audiobook you do not listen to. `book` is the choice made here (null: as the default).
 */
export interface AudioControlsChoice {
  readonly book: boolean | null;
  readonly byDefault: boolean;
  readonly onChange: (hidden: boolean | null) => void;
}

export function SettingsPanel({ settings, onChange, onClose, audio }: { settings: ReaderSettings; onChange: (s: ReaderSettings) => void; onClose: () => void; audio?: AudioControlsChoice }) {
  const i = FONT_SCALES.indexOf(settings.fontScale as (typeof FONT_SCALES)[number]);
  const step = (d: number) => {
    const next = FONT_SCALES[Math.max(0, Math.min(FONT_SCALES.length - 1, (i === -1 ? 2 : i) + d))]!;
    onChange({ ...settings, fontScale: next });
  };
  return (
    <Modal title="Reading settings" onClose={onClose}>
      <div className="stack">
        <div className="setting-row">
          <span id="size-label">Text size</span>
          <div className="stepper" role="group" aria-labelledby="size-label">
            <button type="button" className="btn btn-small" onClick={() => step(-1)} data-testid="font-smaller" disabled={i === 0}>
              A−<span className="visually-hidden"> smaller text</span>
            </button>
            <output aria-live="polite" data-testid="font-scale">
              {settings.fontScale}%
            </output>
            <button type="button" className="btn btn-small" onClick={() => step(1)} data-testid="font-larger" disabled={i === FONT_SCALES.length - 1}>
              A+<span className="visually-hidden"> larger text</span>
            </button>
          </div>
        </div>
        <fieldset className="setting-row">
          <legend>Theme</legend>
          <div className="swatches">
            {(Object.keys(THEMES) as ThemeName[]).map((name) => (
              <label key={name} className="swatch" style={{ background: THEMES[name].bg, color: THEMES[name].text }}>
                <input type="radio" name="theme" value={name} checked={settings.theme === name} onChange={() => onChange({ ...settings, theme: name })} />
                <span>{THEMES[name].label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="setting-row">
          <legend>Font</legend>
          <div className="segmented">
            {(Object.keys(FONTS) as FontChoice[]).map((f) => (
              <label key={f}>
                <input type="radio" name="font" value={f} checked={settings.font === f} onChange={() => onChange({ ...settings, font: f })} />
                <span>{FONTS[f].label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="setting-row">
          <legend>Line spacing</legend>
          <div className="segmented">
            {[1.4, 1.6, 1.8].map((lh) => (
              <label key={lh}>
                <input type="radio" name="lh" value={lh} checked={settings.lineHeight === lh} onChange={() => onChange({ ...settings, lineHeight: lh })} />
                <span>{lh === 1.4 ? 'Tight' : lh === 1.6 ? 'Normal' : 'Loose'}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {audio ? (
          <fieldset className="setting-row">
            <legend>The audiobook in this book</legend>
            <div className="segmented">
              {(
                [
                  [null, `As in Settings (${audio.byDefault ? 'hidden' : 'shown'})`, 'default'],
                  [false, 'Show', 'show'],
                  [true, 'Hide', 'hide'],
                ] as const
              ).map(([value, label, id]) => (
                <label key={id}>
                  <input type="radio" name="audio-controls" value={id} checked={audio.book === value} onChange={() => audio.onChange(value)} data-testid={`audio-controls-${id}`} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <p className="small muted">Hidden, the book offers no Listen and shows no audiobook controls, unless the audiobook is playing.</p>
          </fieldset>
        ) : null}
      </div>
    </Modal>
  );
}

export interface TocItem {
  readonly title: string;
  readonly depth: number;
  readonly current: boolean;
  readonly ahead: boolean;
  /** The book's own matter after the story (D109): listed apart, after it. */
  readonly after?: boolean;
  readonly onSelect: () => void;
  readonly pageLabel?: string | undefined;
}

export function TocPanel({ items, onClose, onReadUpToHere }: { items: readonly TocItem[]; onClose: () => void; onReadUpToHere?: () => void }) {
  const list = (group: readonly TocItem[], labelledBy?: string) => (
    <ol className="toc-list" aria-labelledby={labelledBy}>
      {group.map((it, i) => (
        <li key={i} style={{ paddingInlineStart: `${it.depth * 16}px` }}>
          <button
            type="button"
            className={`toc-item${it.ahead && !it.current ? ' is-ahead' : ''}`}
            aria-current={it.current ? 'true' : undefined}
            onClick={() => {
              it.onSelect();
              onClose();
            }}
          >
            <span>
              {it.title}
              {it.ahead && !it.current ? <span className="visually-hidden"> (ahead of you)</span> : null}
            </span>
            {it.pageLabel ? <span className="faint small">{it.pageLabel}</span> : null}
          </button>
        </li>
      ))}
    </ol>
  );
  const after = items.filter((it) => it.after);
  return (
    <Modal title="Contents" onClose={onClose} initialFocus="[aria-current='true']">
      <nav aria-label="Table of contents">
        {list(items.filter((it) => !it.after))}
        {/* The book's own matter after the story (its colophon, its notes), apart from it (D109). */}
        {after.length > 0 ? (
          <>
            <h3 className="section-title" id="toc-after" style={{ marginTop: 16, marginBottom: 4 }} data-testid="toc-after">
              After the story
            </h3>
            {list(after, 'toc-after')}
          </>
        ) : null}
      </nav>
      <p className="faint small toc-note">Jumping ahead does not count as reading: notes in the pages you skip stay hidden until you read them.</p>
      {onReadUpToHere ? (
        <button
          type="button"
          className="btn btn-small btn-ghost"
          data-testid="read-up-to-here"
          onClick={() =>
            void confirmAction({ title: 'Mark everything up to this page as read?', body: 'Friends’ notes before here will show in full.', confirm: 'Mark as read' }).then((yes) => {
              if (!yes) return;
              onReadUpToHere();
              onClose();
            })
          }
        >
          I’ve already read up to here
        </button>
      ) : null}
    </Modal>
  );
}

/** Reactions and "Note" for a selected passage, floating near it. */
export function SelectionMenu({
  rect,
  onReact,
  onNote,
}: {
  rect: { left: number; top: number; width: number; height: number };
  onReact: (r: Reaction) => void;
  onNote: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Measured, so the whole menu stays on screen wherever the passage is (a phone is barely wider
  // than it). On a touch screen the system's own menu sits above a selection: this one goes below.
  useLayoutEffect(() => {
    const el = ref.current;
    const area = el?.offsetParent;
    if (!el || !area) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    // Within the part of the area on screen: a zoomed-in PDF page scrolls inside it.
    const { scrollLeft, scrollTop, clientWidth, clientHeight } = area;
    const centre = rect.left + rect.width / 2;
    const left = Math.max(scrollLeft + 8, Math.min(centre - width / 2, scrollLeft + clientWidth - width - 8));
    const above = rect.top - height - 10;
    const below = rect.top + rect.height + 10;
    const fitsBelow = below + height <= scrollTop + clientHeight - 8;
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const top = touch ? (fitsBelow ? below : Math.max(scrollTop + 8, above)) : above >= scrollTop + 8 ? above : below;
    setPlace({ left, top });
  }, [rect.left, rect.top, rect.width, rect.height]);
  return (
    <div
      ref={ref}
      className="selection-menu"
      role="toolbar"
      aria-label="React to the selected passage"
      style={place ? { left: `${place.left}px`, top: `${place.top}px` } : { left: 0, top: 0, visibility: 'hidden' }}
      data-testid="selection-menu"
    >
      {REACTIONS.map((r) => (
        <button key={r} type="button" className="reaction-btn" onClick={() => onReact(r)} aria-label={REACTION_LABELS[r]} data-testid={`react-${REACTION_LABELS[r].toLowerCase().replace(/\s+/g, '-')}`}>
          {r}
        </button>
      ))}
      <button type="button" className="btn btn-small btn-primary" onClick={onNote} data-testid="note-from-selection">
        <Icon name="comment" size={16} /> Note
      </button>
    </div>
  );
}

export interface ComposerTarget {
  readonly quote: string | null;
  readonly where: string;
  /**
   * Where what you have in front of you as you write ends, on the timeline: the page's end, or the
   * moment heard. It is read as the note is written (D12): only reading further than it holds the
   * note for friends (D69).
   */
  readonly upTo: number;
}

export function NoteComposer({
  bookId,
  target,
  chapters,
  furthest,
  members,
  selfId,
  onSubmit,
  onClose,
}: {
  /** Where an attached voice recording, photo or video uploads to (D140). */
  bookId: string;
  target: ComposerTarget;
  /** The book's chapters, to say where you have read to. */
  chapters: readonly Chapter[];
  /** The furthest you have read, on the timeline. */
  furthest: number;
  /** Where everyone in the club has read to, as last heard: who a note from further on would wait for. */
  members: readonly MemberProgress[];
  selfId: string | undefined;
  /** `aboutHere`: having read further, you said the note is only about this passage (D69). */
  onSubmit: (input: { text: string | undefined; reaction: Reaction | undefined; clientId: string; aboutHere: boolean; mediaIds: string[] }) => Promise<unknown>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [reaction, setReaction] = useState<Reaction | undefined>(undefined);
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  // One id for this note however many times Post is pressed (a retry after a lost answer).
  const [clientId] = useState(newClientId);
  const mediaIds = mediaIdsOf(attachments);
  const submit = useMutation({
    mutationFn: (aboutHere: boolean) => onSubmit({ text: text.trim() || undefined, reaction, clientId, aboutHere, mediaIds }),
    onSuccess: onClose,
  });
  const busy = mediaBusy(attachments);
  const empty = !text.trim() && !reaction && mediaIds.length === 0;
  const close = () => {
    discardAllMedia(attachments);
    onClose();
  };
  // Read well past what you have in front of you: your words wait for friends to read as far,
  // unless they are only about this passage, which you may say as you post (D69). Asked only while
  // some friend has not read as far, saying who: with everyone as far, it would wait for nobody.
  const behind = fromFurtherOn(furthest, target.upTo) ? notAsFar(members, selfId, furthest) : [];
  const further = behind.length > 0 ? placeName(chapters, furthest) : null;
  return (
    <Modal title="Leave a note" onClose={close} initialFocus="textarea">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!empty && !busy) submit.mutate(false);
        }}
      >
        {further ? (
          <p className="muted small" data-testid="note-from-further">
            Pinned at {target.where}. You have read on to {further}. {notAsFarLine(behind)}: your note waits until they have, unless it is only about this
            passage. Nothing from later reaches them early.
          </p>
        ) : (
          <p className="muted small">
            Pinned at {target.where}. Friends who have not read this far see only {reaction ? `your ${reaction}` : 'a marker'}, never your words.
          </p>
        )}
        {target.quote ? <blockquote className="note-quote">{target.quote}</blockquote> : null}
        <div className="reaction-picker" role="group" aria-label="Reaction (optional)">
          {REACTIONS.map((r) => (
            <button
              key={r}
              type="button"
              className={`reaction-btn${reaction === r ? ' is-selected' : ''}`}
              aria-pressed={reaction === r}
              aria-label={REACTION_LABELS[r]}
              onClick={() => setReaction(reaction === r ? undefined : r)}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="note-text">Your note</label>
          <textarea id="note-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.commentText} placeholder="What did you think? (optional with a reaction or media)" data-testid="note-text" />
        </div>
        <NoteMediaComposer bookId={bookId} attachments={attachments} onChange={setAttachments} disabled={submit.isPending} />
        {submit.error ? (
          <div className="form-error" role="alert">
            {errorMessage(submit.error)}
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={empty || busy || submit.isPending} data-testid="note-submit">
          {submit.isPending && !submit.variables ? 'Posting…' : 'Post'}
        </button>
        {further ? (
          <button type="button" className="btn" disabled={empty || busy || submit.isPending} onClick={() => submit.mutate(true)} data-testid="note-submit-about-here">
            {submit.isPending && submit.variables ? 'Posting…' : 'Post, only about this passage'}
          </button>
        ) : null}
      </form>
    </Modal>
  );
}

/**
 * The end-of-book card is a moment, not a nag: shown once per person, book and device, and once
 * more on finishing for real after reaching the end with parts skipped. Paging around the last
 * pages (or into a licence after the story) does not bring it back.
 */
export function firstTimeAtEnd(bookId: string, userId: string | undefined, finished: boolean): boolean {
  const key = `bookclub:end-card:${userId ?? '-'}:${bookId}`;
  try {
    const seen = localStorage.getItem(key);
    if (seen === 'finished' || (seen === 'end' && !finished)) return false;
    localStorage.setItem(key, finished ? 'finished' : 'end');
  } catch {
    // no storage: show it
  }
  return true;
}

/**
 * During a look (a chapter from the contents, a link, a friend's note): the way back to your place,
 * or to make this your place (D62). `elsewhere`: the place to go back to was saved on another device
 * while this one was open (D70), so it is said so: going there, or staying here. Never over the club
 * bar or the page (D91, app.css): on a computer both sit in the header, where the chapter's name
 * was; on a phone, where there is room for one of them in each, "Read from here" sits there and the
 * way back in the footer, where the page numbers were, between the page arrows. `onFollow`: the
 * audiobook is playing, lined up with this text: the second way out is back to the narrator.
 */
export function LookChip({ label, onBack, onStay, onFollow, elsewhere = false }: { label: string; onBack: () => void; onStay: () => void; onFollow?: () => void; elsewhere?: boolean }) {
  return (
    <div className="look-chip" role="group" aria-label={elsewhere ? 'You read on on another device' : 'Looking elsewhere in the book'} data-testid="look-chip" data-elsewhere={elsewhere ? 'true' : undefined}>
      <button type="button" className="btn btn-small look-back" data-testid="back-to-reading" onClick={onBack}>
        <Icon name="back" size={16} /> {elsewhere ? `Continue at ${label}` : `Back to ${label}`}
      </button>
      {onFollow ? (
        // Listening meanwhile: the other way out of the look is back to the narrator (D184, D186).
        <button type="button" className="btn btn-small look-stay" data-testid="follow-audio" onClick={onFollow}>
          <Icon name="headphones" size={16} /> Follow the narrator
        </button>
      ) : (
        <button type="button" className="btn btn-small look-stay" data-testid="read-from-here" onClick={onStay}>
          {elsewhere ? 'Stay here' : 'Read from here'}
        </button>
      )}
    </div>
  );
}

/** Who has the ending still to come: friends reading, and friends who have not started. */
export function stillToCome(reading: number, notStarted: number): string {
  if (reading === 0 && notStarted === 0) return ' Everyone is done: time to talk about the ending.';
  const r = reading > 0 ? `${reading} ${reading === 1 ? 'friend is' : 'friends are'} still reading` : null;
  const n = notStarted > 0 ? (r ? `${notStarted} ${notStarted === 1 ? 'has' : 'have'} not started` : `${notStarted} ${notStarted === 1 ? 'friend has' : 'friends have'} not started yet`) : null;
  return ` ${[r, n].filter(Boolean).join(' and ')}: keep it quiet.`;
}

/** The end of the book: a small celebration, and who else is done. */
export function FinishedCard({
  book,
  members,
  selfId,
  finished,
  coverage,
  notesClosed,
  onClose,
}: {
  book: { id: string; title: string };
  members: readonly MemberProgress[];
  selfId: string | undefined;
  /** The server counts the book as finished (the ending and nearly all of the rest read). */
  finished: boolean;
  /** How much of the book you have read, 0..1. */
  coverage: number;
  /** Notes still closed to you (in parts you have not read). */
  notesClosed: number;
  onClose: () => void;
}) {
  const others = members.filter((m) => m.userId !== selfId && m.finished).map((m) => m.displayName);
  const reading = members.filter((m) => m.userId !== selfId && !m.finished && m.updatedAt !== null).length;
  const notStarted = members.filter((m) => m.userId !== selfId && !m.finished && m.updatedAt === null).length;
  return (
    <Modal
      title={finished ? 'You finished the book' : 'You reached the end'}
      onClose={onClose}
      footer={
        <Link className="btn btn-primary" to={`/books/${book.id}`}>
          See the discussion
        </Link>
      }
    >
      <div className="finished" data-testid="finished-card" data-finished={finished ? 'true' : 'false'}>
        <p className="finished-title">{book.title}</p>
        {finished ? (
          <p className="muted">
            {others.length > 0 ? `${formatNames(others)} finished too.` : 'You are the first in the club to finish.'}
            {stillToCome(reading, notStarted)}
          </p>
        ) : (
          <p className="muted">
            You have read about {formatPercent(coverage)} of it, so it does not count as finished yet: read the parts you skipped, or mark them read from the
            contents.
          </p>
        )}
        <p className="muted small">
          {notesClosed === 0
            ? 'Every note in the book is open to you now.'
            : `${notesClosed} ${notesClosed === 1 ? 'note is' : 'notes are'} in parts you have not read; ${notesClosed === 1 ? 'it opens' : 'they open'} when you read there.`}
        </p>
      </div>
    </Modal>
  );
}

/** What friends said in a chapter that just ended, in whichever format (shown at the chapter's end). */
export interface ChapterEndInfo {
  readonly title: string;
  /** The chapter's name as the club says it ("Chapter 3", "Part 2, Chapter 1", D86). */
  readonly name: string;
  readonly ids: readonly string[];
  readonly names: readonly string[];
}

/** The friends' notes of chapter `index`, among `comments`, between two timeline points. */
export function chapterEndInfo(chapters: readonly ChapterLike[], index: number, comments: readonly CommentView[], selfId: string | undefined, from: number, to: number): ChapterEndInfo | null {
  const inChapter = comments.filter((c) => c.userId !== selfId && c.t >= from && c.t < to);
  if (inChapter.length === 0) return null;
  return { title: chapters[index]!.title, name: chapterNames(chapters)[index]!, ids: inChapter.map((c) => c.id), names: [...new Set(inChapter.map((c) => c.authorName))] };
}

export function ChapterEndCard({ info, onShow, onClose }: { info: ChapterEndInfo; onShow: () => void; onClose: () => void }) {
  return (
    <div className="chapter-end" role="status" data-testid="chapter-end">
      <span title={`End of ${info.title}`}>
        End of {info.name} · {info.ids.length} {info.ids.length === 1 ? 'note' : 'notes'} from {formatNames(info.names)}
      </span>
      <span className="row">
        <button type="button" className="btn btn-small btn-primary" onClick={onShow}>
          Show
        </button>
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </span>
    </div>
  );
}

/**
 * Just past a chapter's end or the club's next stop, in whichever format: the stop's card if you
 * have just reached it (offering the chapter's notes too, and closing both), or else the chapter's.
 */
export function StopOrChapterEndCard({
  atStop,
  chapterEnd,
  onShow,
  onCloseStop,
  onCloseChapterEnd,
}: {
  atStop: MeetingReachedInfo | null;
  chapterEnd: ChapterEndInfo | null;
  /** Open the friends' notes of the chapter that just ended. */
  onShow: (ids: string[]) => void;
  onCloseStop: () => void;
  onCloseChapterEnd: () => void;
}) {
  if (atStop) {
    const close = () => {
      onCloseStop();
      onCloseChapterEnd();
    };
    const notes = chapterEnd
      ? {
          count: chapterEnd.ids.length,
          names: chapterEnd.names,
          onShow: () => {
            onShow([...chapterEnd.ids]);
            close();
          },
        }
      : null;
    return <MeetingReachedCard meeting={atStop.meeting} others={atStop.others} finished={atStop.finished ?? []} notes={notes} onClose={close} />;
  }
  if (!chapterEnd) return null;
  return (
    <ChapterEndCard
      info={chapterEnd}
      onShow={() => {
        onShow([...chapterEnd.ids]);
        onCloseChapterEnd();
      }}
      onClose={onCloseChapterEnd}
    />
  );
}

/**
 * What a friend's note closed to you says in the note sheet instead of its words (D63, D69); a
 * reaction with no words, whose and which it is, as on the book page: nothing more is to come.
 */
function closedLine(c: HiddenComment, why: Closed): string {
  if (reactionOnly(c)) return reactionAlone(c, why);
  if (why === 'held') return `${c.authorName} wrote this from ${c.horizon} · it opens when you get there`;
  if (why === 'near') return nearButClosed(c);
  return why === 'skipped' ? 'You have not read this part yet.' : 'You have not read this far yet.';
}

/** A friend's note closed to you, in the note sheet: why, instead of its words; during a peek, a way to read here. */
function ClosedNote({ note, why, onReadHere }: { note: HiddenComment; why: Closed; onReadHere: (() => void) | undefined }) {
  const alone = reactionOnly(note);
  return (
    <>
      <p className="muted small" data-testid={alone ? 'sheet-reaction-alone' : why === 'held' ? 'sheet-note-held' : why === 'near' ? 'sheet-note-near' : undefined}>
        {alone ? null : <Icon name="lock" size={14} />} {closedLine(note, why)}
      </p>
      {/* Reading here does not bring a note held for where its writer had read to, and a reaction
          alone has nothing to open. */}
      {onReadHere && why !== 'held' && !alone ? (
        <button type="button" className="btn btn-small" onClick={onReadHere} data-testid="sheet-read-here">
          Read from here to open it
        </button>
      ) : null}
    </>
  );
}

/** Notes at one place in the book (a margin marker or a bar marker). */
export function MarkerSheet({
  comments,
  replies = NO_REPLIES,
  canModerate = false,
  chapters,
  selfId,
  onClose,
  onDelete,
  onGo,
  onReadHere,
}: {
  comments: readonly CommentView[];
  /**
   * During a peek far past where you have read (D72): read the page in front of you, which opens
   * the notes on it. Opening a note there is not reading there by itself (a marker sits where a
   * finger turns the page), so it is asked.
   */
  onReadHere?: () => void;
  /** The conversation under each note (D48). */
  replies?: ReadonlyMap<string, CommentView[]>;
  canModerate?: boolean;
  chapters: readonly Chapter[];
  selfId: string | undefined;
  onClose: () => void;
  onDelete?: (c: CommentView) => void;
  /** Offered for each note you may read when the sheet lists several (a group from the bar). */
  onGo?: (c: CommentView) => void;
}) {
  // Where the notes are: their chapter, or the chapters from the first to the last of them (a group
  // from the bar may hold several).
  const chapterOf = (c: CommentView) => chapterNameAt(chapters, c.t) ?? formatPercent(c.t);
  const ordered = [...comments].sort((a, b) => a.t - b.t);
  const first = ordered[0] ? chapterOf(ordered[0]) : '';
  const last = ordered.length > 1 ? chapterOf(ordered[ordered.length - 1]!) : first;
  const where = first === last ? first : `${first} to ${last}`;
  // Why a note is closed to you, by your reading as the server last said it: one whose place you
  // have read waits only until you are surely past it (D63), and says so.
  const qc = useQueryClient();
  const read = readRangesOf(qc, comments[0]?.bookId ?? '');
  return (
    <Modal title={where ? `Notes · ${where}` : 'Notes'} onClose={onClose}>
      <ul className="marker-sheet" data-testid="marker-sheet">
        {comments.map((c) => (
          <li key={c.id} className="note" data-testid="sheet-note" data-hidden={c.hidden ? 'true' : 'false'}>
            <Avatar name={c.authorName} color={c.color} size={30} />
            <div className="note-body">
              <div className="note-meta">
                <strong>{c.userId === selfId ? 'You' : c.authorName}</strong>
                {c.reaction ? (
                  <span className="note-reaction" role="img" aria-label={REACTION_LABELS[c.reaction]}>
                    {c.reaction}
                  </span>
                ) : null}
                <time className="faint small" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>
                  {formatWhen(c.createdAt)}
                </time>
              </div>
              {c.hidden ? (
                <>
                  <ClosedNote note={c} why={whyClosed(c, read)} onReadHere={onReadHere} />
                  <NoteMedia comment={c} />
                </>
              ) : (
                <>
                  {c.deleted ? <p className="muted small">This note was deleted.</p> : null}
                  {c.quote ? <blockquote className="note-quote">{c.quote}</blockquote> : null}
                  {c.text ? <p className="note-text" data-testid="sheet-note-text">{c.text}</p> : null}
                  <NoteMedia comment={c} />
                  <Replies
                    note={c}
                    replies={replies.get(c.id) ?? []}
                    selfId={selfId}
                    canModerate={canModerate}
                    actions={
                      <>
                        {onGo && comments.length > 1 ? (
                          <button type="button" className="btn btn-ghost btn-small" onClick={() => onGo(c)}>
                            Go to passage
                          </button>
                        ) : null}
                        {onDelete && c.userId === selfId && !c.deleted ? (
                          <button
                            type="button"
                            className="icon-btn note-action-btn btn-danger"
                            aria-label="Delete note"
                            title="Delete note"
                            onClick={() => void askToDelete(c, selfId).then((yes) => yes && onDelete(c))}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        ) : null}
                      </>
                    }
                  />
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
