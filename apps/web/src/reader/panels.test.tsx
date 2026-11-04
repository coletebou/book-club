import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BookProgress, CommentView, MemberProgress, Reaction } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../lib/queries';
import { ChapterEndCard, MarkerSheet, NoteComposer, TocPanel, chapterEndInfo, firstTimeAtEnd, stillToCome } from './panels';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('the end-of-book card', () => {
  it('comes once per person and book: paging around the last pages does not bring it back', () => {
    expect(firstTimeAtEnd('b1', 'u1', false)).toBe(true);
    expect(firstTimeAtEnd('b1', 'u1', false)).toBe(false);
    expect(firstTimeAtEnd('b1', 'u1', false)).toBe(false);
    // Another book, another friend on this device: their own moment.
    expect(firstTimeAtEnd('b2', 'u1', false)).toBe(true);
    expect(firstTimeAtEnd('b1', 'u2', false)).toBe(true);
  });

  it('comes once more on finishing for real, after an end reached with parts skipped', () => {
    expect(firstTimeAtEnd('b1', 'u1', false)).toBe(true);
    expect(firstTimeAtEnd('b1', 'u1', true)).toBe(true);
    expect(firstTimeAtEnd('b1', 'u1', true)).toBe(false);
    expect(firstTimeAtEnd('b1', 'u1', false)).toBe(false);
  });

  it('shows anyway where the browser keeps nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(firstTimeAtEnd('b1', 'u1', false)).toBe(true);
    expect(firstTimeAtEnd('b1', 'u1', false)).toBe(true);
  });
});

describe('the contents (FR150)', () => {
  afterEach(cleanup);

  it('list the book’s own matter after the story apart, as no part of it still ahead of you', () => {
    const item = (title: string, extra: { ahead?: boolean; after?: boolean; current?: boolean } = {}) => ({ title, depth: 0, current: false, ahead: false, onSelect: vi.fn(), ...extra });
    const items = [item('Story of the Door', { current: true }), item('Search for Mr. Hyde', { ahead: true }), item('Colophon', { after: true }), item('Uncopyright', { after: true })];
    render(<TocPanel items={items} onClose={() => {}} />);
    const lists = within(screen.getByRole('navigation', { name: 'Table of contents' })).getAllByRole('list');
    expect(lists.map((l) => within(l).getAllByRole('button').map((b) => b.textContent))).toEqual([
      ['Story of the Door', 'Search for Mr. Hyde (ahead of you)'],
      ['Colophon', 'Uncopyright'],
    ]);
    expect(screen.getByRole('list', { name: 'After the story' })).toBe(lists[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Colophon' }));
    expect(items[2]!.onSelect).toHaveBeenCalled();
  });

  it('have no group after the story where the book has nothing of its own there (Gutenberg’s licence)', () => {
    render(<TocPanel items={[{ title: 'CHAPTER I.', depth: 0, current: true, ahead: false, onSelect: () => {} }]} onClose={() => {}} />);
    expect(screen.queryByTestId('toc-after')).toBeNull();
  });
});

describe('a chapter’s end in a book in parts (D86)', () => {
  afterEach(cleanup);
  // Crime and Punishment, as its contents give it: chapters numbered afresh in each part.
  const crime = [
    { title: 'PART I', t: 0.005 },
    { title: 'CHAPTER I', t: 0.0051 },
    { title: 'PART II', t: 0.15 },
    { title: 'CHAPTER I', t: 0.1501 },
    { title: 'CHAPTER II', t: 0.17 },
  ];
  const note = (id: string, t: number, authorName: string) => ({ id, t, userId: `user_${authorName}`, authorName }) as CommentView;

  it('names the chapter with its part, and the friends who wrote in it', () => {
    const info = chapterEndInfo(crime, 3, [note('c1', 0.16, 'Ana'), note('c2', 0.155, 'Ben'), note('c3', 0.18, 'Ana')], 'user_Cole', 0.1501, 0.17)!;
    expect(info).toMatchObject({ title: 'CHAPTER I', name: 'Part 2, Chapter 1', ids: ['c1', 'c2'], names: ['Ana', 'Ben'] });
    render(<ChapterEndCard info={info} onShow={() => undefined} onClose={() => undefined} />);
    expect(screen.getByTestId('chapter-end').textContent).toContain('End of Part 2, Chapter 1 · 2 notes from Ana and Ben');
    // Your own notes are no news to you.
    expect(chapterEndInfo(crime, 3, [note('c4', 0.16, 'Cole')], 'user_Cole', 0.1501, 0.17)).toBeNull();
  });
});

describe('who has the ending still to come', () => {
  it('counts the friends reading apart from those who have not started', () => {
    expect(stillToCome(0, 0)).toBe(' Everyone is done: time to talk about the ending.');
    expect(stillToCome(1, 0)).toBe(' 1 friend is still reading: keep it quiet.');
    expect(stillToCome(3, 0)).toBe(' 3 friends are still reading: keep it quiet.');
    expect(stillToCome(0, 1)).toBe(' 1 friend has not started yet: keep it quiet.');
    expect(stillToCome(0, 2)).toBe(' 2 friends have not started yet: keep it quiet.');
    expect(stillToCome(2, 1)).toBe(' 2 friends are still reading and 1 has not started: keep it quiet.');
  });
});


describe('the notes at a place', () => {
  afterEach(cleanup);
  const at = { bookId: 'book_1', color: '#D6B85E', t: 0.05, editionId: 'edition_1', kind: 'epub' as const, locator: { kind: 'epub' as const, section: 2, offset: 5000 }, createdAt: '2026-10-24T10:00:00.000Z', parentId: null };
  const chapters = [
    { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0 },
    { index: 1, title: 'CHAPTER IX. The Mock Turtle’s Story', t: 0.7 },
  ];
  /** As the server sends a note Cleo wrote while paging back from chapter 9, to someone who has read its place only (D69). */
  const lookedBack: CommentView = { ...at, id: 'note_1', userId: 'user_cleo', authorName: 'Cleo', reaction: '🤯', hidden: true, hasText: true, horizon: 'Chapter 9' };
  const ahead: CommentView = { ...at, id: 'note_2', userId: 'user_ben', authorName: 'Ben', reaction: null, hidden: true, hasText: true };

  it('a note held by where its writer had read to says where that was, never its words', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MarkerSheet comments={[lookedBack, ahead]} chapters={chapters} selfId="user_cole" onClose={() => undefined} />
      </QueryClientProvider>,
    );
    const [held, closed] = screen.getAllByTestId('sheet-note');
    expect(held!.getAttribute('data-hidden')).toBe('true');
    expect(screen.getByTestId('sheet-note-held').textContent?.trim()).toBe('Cleo wrote this from Chapter 9 · it opens when you get there');
    // The reaction shows, as on any marker; nothing of the note's words.
    expect(held!.textContent).toContain('🤯');
    expect(screen.queryByTestId('sheet-note-text')).toBeNull();
    // A note ahead of you says only that.
    expect(closed!.textContent).toContain('You have not read this far yet.');
    expect(closed!.querySelector('[data-testid="sheet-note-held"]')).toBeNull();
  });
});

describe('an open note’s own media and actions in the sheet (fidelity feedback, round 2026-10-28)', () => {
  afterEach(cleanup);
  const chapters = [{ index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0 }];
  const at = { bookId: 'book_1', color: '#D6B85E', t: 0.05, editionId: 'edition_1', kind: 'epub' as const, locator: { kind: 'epub' as const, section: 2, offset: 5000 }, createdAt: '2026-10-24T10:00:00.000Z', parentId: null, hidden: false as const, endLocator: null, endT: null, quote: null };
  const photo = { id: 'media_1', kind: 'photo' as const, status: 'ready' as const, mime: 'image/jpeg', url: 'https://cdn.example/photo.jpg', posterUrl: null, durationMs: null, width: 800, height: 600, transcript: null, transcriptStatus: 'none' as const };
  // Posted with a photo and no words, from further on than a friend has read.
  const withPhoto: CommentView = { ...at, id: 'note_photo', userId: 'user_cole', authorName: 'Cole', reaction: null, text: null, media: [photo], horizon: 'Chapter 12' };

  // Tapping a photo note's marker opens the sheet; before, it showed nothing of the photo at all
  // (panels.tsx never imported NoteMediaView) — the bug behind "no image shows" (item 3).
  it('shows the photo, tapped open from its marker, not just its marker-sheet entry', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MarkerSheet comments={[withPhoto]} chapters={chapters} selfId="user_cole" onClose={() => undefined} />
      </QueryClientProvider>,
    );
    const photos = screen.getByTestId('note-photos');
    expect(photos.querySelector('img')!.getAttribute('src')).toBe('https://cdn.example/photo.jpg');
  });

  // Cole did not want to be told, under his own open note, when friends would read it.
  it('says nothing of when friends will read your own note written from further on', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MarkerSheet comments={[withPhoto]} chapters={chapters} selfId="user_cole" onClose={() => undefined} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('sheet-note-held-for')).toBeNull();
    expect(screen.queryByText(/Friends read this once/)).toBeNull();
  });

  // Delete and Reply are small icon buttons beside the note, not big stacked text buttons (item 4):
  // both keep an accessible name a reader (or an existing spec) can still find them by.
  it('offers Delete and Reply as small icon buttons, not big stacked pills', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MarkerSheet comments={[withPhoto]} chapters={chapters} selfId="user_cole" onClose={() => undefined} onDelete={() => undefined} />
      </QueryClientProvider>,
    );
    const del = screen.getByRole('button', { name: 'Delete note' });
    expect(del.className).toContain('icon-btn');
    expect(del.querySelector('svg')).toBeTruthy();
    expect(del.textContent?.trim()).toBe('');
    const reply = screen.getByTestId('reply-open');
    expect(reply.getAttribute('aria-label')).toBe('Reply');
    expect(reply.className).toContain('icon-btn');
    expect(reply.querySelector('svg')).toBeTruthy();
  });
});

/** A cache where Cole's reading, as the server last said it, is `readRanges`. */
function readOnly(readRanges: [number, number][]): QueryClient {
  const qc = new QueryClient();
  const furthest = readRanges.length > 0 ? readRanges[readRanges.length - 1]![1] : 0;
  qc.setQueryData<BookProgress>(keys.progress('book_1'), {
    mine: { editionId: 'edition_1', locator: null, t: furthest, label: '', readRanges, furthest, finished: false, at: 1 },
    members: [],
  });
  return qc;
}

describe('a friend’s note closed although you have read its place (fidelity review round 13)', () => {
  afterEach(cleanup);
  const chapters = [
    { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0 },
    { index: 1, title: 'CHAPTER IX. The Mock Turtle’s Story', t: 0.7 },
  ];
  const at = { bookId: 'book_1', color: '#D6B85E', createdAt: '2026-10-24T10:00:00.000Z', parentId: null, hidden: true as const, hasText: true };
  /** Ben's 😢, made while listening, on the page Cole is reading: its place is read, but it opens a minute or two later (D63). */
  const heard: CommentView = { ...at, id: 'note_heard', userId: 'user_ben', authorName: 'Ben', reaction: '😢', t: 0.05, editionId: 'edition_audio', kind: 'audio', locator: { kind: 'audio', track: 0, ms: 90_000 } };
  /** Ana's note in a part Cole went past without reading. */
  const skipped: CommentView = { ...at, id: 'note_skipped', userId: 'user_ana', authorName: 'Ana', reaction: null, t: 0.3, editionId: 'edition_1', kind: 'epub', locator: { kind: 'epub', section: 4, offset: 10 } };
  /** Cleo's, further than Cole has read. */
  const ahead: CommentView = { ...at, id: 'note_ahead', userId: 'user_cleo', authorName: 'Cleo', reaction: '🤯', t: 0.8, editionId: 'edition_1', kind: 'epub', locator: { kind: 'epub', section: 10, offset: 10 } };

  function sheet(qc: QueryClient, onReadHere?: () => void) {
    render(
      <QueryClientProvider client={qc}>
        <MarkerSheet comments={[heard, skipped, ahead]} chapters={chapters} selfId="user_cole" onClose={() => undefined} {...(onReadHere ? { onReadHere } : {})} />
      </QueryClientProvider>,
    );
    const [near, passed, further] = screen.getAllByTestId('sheet-note');
    return { near: near!, passed: passed!, further: further! };
  }

  it('says it was made in another format about here and opens a little further on; only one really ahead is “not this far”', () => {
    const { near, passed, further } = sheet(readOnly([[0, 0.06], [0.5, 0.55]]));
    expect(within(near).getByTestId('sheet-note-near').textContent?.trim()).toBe('Ben wrote this while listening, about here · it opens a little further on, once you are surely past it');
    expect(near.textContent).not.toContain('You have not read this far yet.');
    // Nothing else about it: who, the reaction and when, as on any marker.
    expect(near.textContent).toContain('😢');
    expect(screen.queryByTestId('sheet-note-text')).toBeNull();
    expect(passed.textContent).toContain('You have not read this part yet.');
    expect(further.textContent).toContain('You have not read this far yet.');
    expect(within(passed).queryByTestId('sheet-note-near')).toBeNull();
    expect(within(further).queryByTestId('sheet-note-near')).toBeNull();
  });

  it('with nothing known of your reading, says only that it is ahead of you', () => {
    const { near } = sheet(new QueryClient());
    expect(near.textContent).toContain('You have not read this far yet.');
    expect(within(near).queryByTestId('sheet-note-near')).toBeNull();
  });

  it('a reaction with no words says whose and which it is, with nothing to open: no lock, no “Read from here to open it” (fidelity review round 16)', () => {
    const alone: CommentView = { ...ahead, id: 'note_alone', authorName: 'Ana', reaction: '🤯', hasText: false };
    const heardAlone: CommentView = { ...heard, id: 'note_heard_alone', hasText: false };
    render(
      <QueryClientProvider client={readOnly([[0, 0.06], [0.5, 0.55]])}>
        <MarkerSheet comments={[heardAlone, alone]} chapters={chapters} selfId="user_cole" onClose={() => undefined} onReadHere={() => undefined} />
      </QueryClientProvider>,
    );
    const [near, further] = screen.getAllByTestId('sheet-note');
    expect(within(near!).getByTestId('sheet-reaction-alone').textContent?.trim()).toBe('Ben reacted 😢 while listening, about here, with no words.');
    expect(within(further!).getByTestId('sheet-reaction-alone').textContent?.trim()).toBe('Ana reacted 🤯 here, with no words.');
    for (const note of [near!, further!]) {
      expect(note.querySelector('[data-testid="sheet-reaction-alone"] svg')).toBeNull();
      expect(within(note).queryByTestId('sheet-read-here')).toBeNull();
      expect(note.textContent).not.toMatch(/opens|not read this far/);
    }
  });

  it('during a peek, still offers to read here, as it did', () => {
    const onReadHere = vi.fn();
    const { near, passed, further } = sheet(readOnly([[0, 0.06], [0.5, 0.55]]), onReadHere);
    expect(within(near).getByTestId('sheet-read-here')).toBeTruthy();
    expect(within(passed).getByTestId('sheet-read-here')).toBeTruthy();
    fireEvent.click(within(further).getByTestId('sheet-read-here'));
    expect(onReadHere).toHaveBeenCalledTimes(1);
  });
});

describe('leaving a note from further on (fidelity review round 13, D69)', () => {
  afterEach(cleanup);
  const chapters = [
    { index: 0, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0.02 },
    { index: 1, title: 'CHAPTER XII. Alice’s Evidence', t: 0.92 },
  ];
  /** Page 4: it ends at 3.5 % of the book. */
  const target = { quote: null, where: 'Chapter 1 · 3%', upTo: 0.035 };
  type Input = { text: string | undefined; reaction: Reaction | undefined; clientId: string; aboutHere: boolean; mediaIds: string[] };

  const member = (userId: string, displayName: string, furthest: number): MemberProgress => ({
    userId,
    displayName,
    color: '#D6B85E',
    t: furthest,
    furthest,
    coverage: furthest,
    kind: 'epub',
    label: '',
    updatedAt: null,
    finished: false,
  });
  /** Cole writes; Hana is just starting. */
  const club = (furthest: number, ...friends: MemberProgress[]) => [member('user_cole', 'Cole', furthest), ...friends];
  const hana = member('user_hana', 'Hana', 0.03);

  function compose(furthest: number, members = club(furthest, hana)) {
    const onSubmit = vi.fn<(input: Input) => Promise<unknown>>(() => Promise.resolve());
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NoteComposer bookId="book_1" target={target} chapters={chapters} furthest={furthest} members={members} selfId="user_cole" onSubmit={onSubmit} onClose={onClose} />
      </QueryClientProvider>,
    );
    return { onSubmit, onClose };
  }

  it('tells a writer who has read on to the end who has not read as far, and offers to post it as only about this passage', async () => {
    const { onSubmit, onClose } = compose(1);
    expect(screen.getByTestId('note-from-further').textContent).toBe(
      'Pinned at Chapter 1 · 3%. You have read on to Chapter 12. Hana has not read as far as you: your note waits until they have, unless it is only about this passage. Nothing from later reaches them early.',
    );
    // Not what would be false here.
    expect(screen.queryByText(/Friends who have not read this far see only/)).toBeNull();
    fireEvent.change(screen.getByTestId('note-text'), { target: { value: 'Welcome to the club!' } });
    expect(screen.getByTestId('note-submit').textContent).toBe('Post');
    fireEvent.click(screen.getByTestId('note-submit-about-here'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ text: 'Welcome to the club!', reaction: undefined, aboutHere: true });
  });

  it('posted plainly, the note waits for friends to read as far', async () => {
    const { onSubmit, onClose } = compose(0.5);
    expect(screen.getByTestId('note-from-further').textContent).toContain('You have read on to Chapter 1. Hana has not read as far as you:');
    fireEvent.change(screen.getByTestId('note-text'), { target: { value: 'Wait until the trial!' } });
    fireEvent.click(screen.getByTestId('note-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ text: 'Wait until the trial!', aboutHere: false });
  });

  it('names everyone not as far, and only them (fidelity review round 16)', () => {
    compose(0.6, club(0.6, hana, member('user_ana', 'Ana', 0.598), member('user_ben', 'Ben', 0.18), member('user_cleo', 'Cleo', 0.71)));
    expect(screen.getByTestId('note-from-further').textContent).toContain('Hana and Ben have not read as far as you:');
  });

  it('with every friend as far as you, asks nothing: one way to post, which waits for anyone who joins later (fidelity review round 16)', async () => {
    // Cole at 16 %, writing at 3 %; Ana, Ben and Cleo all past him.
    const { onSubmit, onClose } = compose(0.16, club(0.16, member('user_ana', 'Ana', 0.58), member('user_ben', 'Ben', 0.18), member('user_cleo', 'Cleo', 0.71)));
    expect(screen.queryByTestId('note-from-further')).toBeNull();
    expect(screen.queryByTestId('note-submit-about-here')).toBeNull();
    expect(screen.getByText('Pinned at Chapter 1 · 3%. Friends who have not read this far see only a marker, never your words.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('note-text'), { target: { value: 'Mind the marmalade' } });
    fireEvent.click(screen.getByTestId('note-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ text: 'Mind the marmalade', aboutHere: false });
    cleanup();
    // A friend within a page of you has read as far.
    compose(0.16, club(0.16, member('user_ben', 'Ben', 0.157)));
    expect(screen.queryByTestId('note-from-further')).toBeNull();
  });

  it('on the page you are reading, says what it always said, with one way to post', async () => {
    const { onSubmit, onClose } = compose(0.035);
    expect(screen.queryByTestId('note-from-further')).toBeNull();
    expect(screen.getByText('Pinned at Chapter 1 · 3%. Friends who have not read this far see only a marker, never your words.')).toBeTruthy();
    expect(screen.queryByTestId('note-submit-about-here')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sad' }));
    expect(screen.getByText('Pinned at Chapter 1 · 3%. Friends who have not read this far see only your 😢, never your words.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('note-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ text: undefined, reaction: '😢', aboutHere: false });
  });
});
