import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BookProgress, CommentView, MemberProgress } from '@bookclub/shared';
import { keys } from '../lib/queries';
import { afterEach, describe, expect, it } from 'vitest';
import { Replies, heldReply } from './Thread';

afterEach(cleanup);

const at = { bookId: 'book_1', color: '#D6B85E', t: 0.05, editionId: 'edition_1', kind: 'epub' as const, locator: { kind: 'epub' as const, section: 2, offset: 200 }, createdAt: '2026-10-24T10:00:00.000Z' };
const words = { endLocator: null, endT: null, quote: null };
const note: CommentView = { ...at, ...words, id: 'note_1', userId: 'user_ana', authorName: 'Ana', reaction: null, parentId: null, hidden: false, text: 'Down, down, down' };
const nearby: CommentView = { ...at, ...words, id: 'reply_1', userId: 'user_ben', authorName: 'Ben', reaction: null, parentId: 'note_1', hidden: false, text: 'The marmalade jar!' };
/** As the server sends an answer written from chapter 9 to someone who has read only the note's place (D69). */
const fromFurther: CommentView = { ...at, id: 'reply_2', userId: 'user_cleo', authorName: 'Cleo', reaction: '😱', parentId: 'note_1', hidden: true, hasText: true, horizon: 'Chapter 9' };

function conversation(replies: CommentView[], qc = new QueryClient()) {
  return render(
    <QueryClientProvider client={qc}>
      <Replies note={note} replies={replies} selfId="user_cole" canModerate={false} />
    </QueryClientProvider>,
  );
}

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

/** A cache where Cole has read to `furthest`, and his friends as far as they have. */
function readTo(furthest: number, friends: MemberProgress[] = [member('user_ana', 'Ana', 0.05)]): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData<BookProgress>(keys.progress('book_1'), { mine: null, members: [member('user_cole', 'Cole', furthest), ...friends] });
  return qc;
}

describe('answering from further on', () => {
  it('asks at Send, when you have read well past the note and a friend has not, whether the answer is only about this passage, and not otherwise', () => {
    conversation([], readTo(0.6));
    fireEvent.click(screen.getByRole('button', { name: /Reply/ }));
    expect(screen.getByTestId('reply-from-further').textContent).toBe('Ana has not read as far as you: your answer waits until they have, unless it is only about this passage.');
    expect(screen.getByTestId('reply-send-about-here').textContent).toBe('Send, only about this passage');
    expect(screen.getByTestId('reply-send')).toBeTruthy();
    cleanup();
    conversation([], readTo(0.051));
    fireEvent.click(screen.getByRole('button', { name: /Reply/ }));
    expect(screen.queryByTestId('reply-from-further')).toBeNull();
    expect(screen.queryByTestId('reply-send-about-here')).toBeNull();
  });

  it('asks nothing when every friend has read further than you: one Send, the answer waiting for nobody now (fidelity review round 16)', () => {
    // Cole at 16 %, answering a note at 5 %; Ana at 58 %, Ben at 18 %, Cleo at 71 %.
    conversation([], readTo(0.16, [member('user_ana', 'Ana', 0.58), member('user_ben', 'Ben', 0.18), member('user_cleo', 'Cleo', 0.71)]));
    fireEvent.click(screen.getByRole('button', { name: /Reply/ }));
    expect(screen.queryByTestId('reply-from-further')).toBeNull();
    expect(screen.queryByTestId('reply-send-about-here')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Send/ })).toHaveLength(1);
  });

  it('names who is not as far', () => {
    conversation([], readTo(0.6, [member('user_ana', 'Ana', 0.58), member('user_ben', 'Ben', 0.18), member('user_dee', 'Dee', 0)]));
    fireEvent.click(screen.getByRole('button', { name: /Reply/ }));
    expect(screen.getByTestId('reply-from-further').textContent).toMatch(/^Ana, Ben and Dee have not read as far as you:/);
  });
});

describe('the answers under a note', () => {
  // Cole did not want the writer told this under their own answer (fidelity feedback, round
  // 2026-10-28): neither a held nor an open answer shows an explanatory line about it.
  it('no longer tells its writer when friends will read an answer written from further on (D69)', () => {
    const mine: CommentView = { ...nearby, id: 'reply_3', userId: 'user_cole', authorName: 'Cole', horizon: 'Chapter 6' };
    conversation([mine, nearby]);
    expect(screen.queryByTestId('reply-held-for')).toBeNull();
  });

  it('an answer from further on says who wrote it and from where, and nothing of what it says', () => {
    conversation([nearby, fromFurther]);
    const [read, waiting] = screen.getAllByTestId('reply');
    expect(within(read!).getByText(/The marmalade jar!/)).toBeTruthy();
    expect(within(read!).queryByTestId('reply-held')).toBeNull();
    expect(within(waiting!).getByTestId('reply-held').textContent).toBe('😱 Cleo replied from Chapter 9 · it opens when you get there');
    // Only the label, the name and when: no words of the answer, which never came.
    expect(waiting!.querySelectorAll('.reply-text')).toHaveLength(1);
    expect(waiting!.textContent).not.toContain('marmalade');
  });

  it('says only that it opens when you get there where the note’s own place is ahead of you', () => {
    expect(heldReply({ authorName: 'Ben' })).toBe('Ben replied · it opens when you get there');
    expect(heldReply({ authorName: 'Ben', horizon: null })).toBe('Ben replied · it opens when you get there');
    expect(heldReply({ authorName: 'Cleo', horizon: 'Chapter 9' })).toBe('Cleo replied from Chapter 9 · it opens when you get there');
  });

  it('shows nothing under a note you cannot read', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Replies note={{ ...fromFurther, id: 'note_2', parentId: null }} replies={[nearby]} selfId="user_cole" canModerate={false} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('replies')).toBeNull();
  });
});
