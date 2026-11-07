import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatHistory, ChatMessageView, ClubDetail } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { ana, ben, hidden, message, quote, reply } from '../lib/chat-test-data';
import { keys } from '../lib/queries';
import { ChatPanel } from './ChatPanel';

const CLUB = 'club_1';
const member = (userId: string, displayName: string) => ({ userId, displayName, color: '#5c7bb8', role: 'member' as const, joinedAt: '2026-01-01T00:00:00.000Z', source: 'local' as const });
const club: ClubDetail = {
  id: CLUB,
  name: 'Thursday Readers',
  description: '',
  members: [member(ana.userId, 'Ana'), member(ben.userId, 'Ben Carter'), member('user_gs', 'Grant Smith'), member('user_gl', 'Grant Lee')],
  invite: null,
  createdAt: '2026-01-01T00:00:00.000Z',
} as unknown as ClubDetail;

let posted: Record<string, unknown>[];

beforeEach(() => {
  posted = [];
  vi.spyOn(api, 'markChatRead').mockResolvedValue(undefined);
  vi.spyOn(api, 'postChat').mockImplementation(async (_club, body) => {
    posted.push(body);
    return message('sent', 30, { text: body.text });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The panel over a cache holding these General messages (newest first, as the server sends them). */
function panel(messages: ChatMessageView[], selfId = ana.userId, focusMessageId: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData<ChatHistory>(keys.chat(CLUB, 'general'), { messages, hasMore: false });
  qc.setQueryData(keys.club(CLUB), club);
  render(
    <QueryClientProvider client={qc}>
      <ChatPanel clubId={CLUB} books={[]} selfId={selfId} focusMessageId={focusMessageId} />
    </QueryClientProvider>,
  );
  return qc;
}

const bubble = (id: string) => screen.getAllByTestId('chat-message').find((li) => li.getAttribute('data-message-id') === id)!;
const input = () => screen.getByTestId<HTMLTextAreaElement>('chat-input');
function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

describe('replies (D200)', () => {
  it('answers a message from its menu: the composer says whom, and the send carries it', async () => {
    const root = message('root', 0, { text: 'Who is the White Rabbit late for?' });
    panel([root], ben.userId);
    fireEvent.click(within(bubble('root')).getByTestId('chat-message-menu-btn'));
    fireEvent.click(within(bubble('root')).getByTestId('chat-message-reply'));
    const bar = screen.getByTestId('chat-reply-bar');
    expect(bar.textContent).toContain('Replying to Ana');
    expect(bar.textContent).toContain('Who is the White Rabbit late for?');
    type('The Duchess');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ text: 'The Duchess', parentId: 'root', bookId: null });
    await waitFor(() => expect(screen.queryByTestId('chat-reply-bar')).toBeNull());
  });

  it('stops answering with the bar’s close button or Escape', () => {
    panel([message('root', 0)]);
    fireEvent.click(within(bubble('root')).getByTestId('chat-message-menu-btn'));
    fireEvent.click(within(bubble('root')).getByTestId('chat-message-reply'));
    fireEvent.click(screen.getByTestId('chat-reply-cancel'));
    expect(screen.queryByTestId('chat-reply-bar')).toBeNull();
    fireEvent.click(within(bubble('root')).getByTestId('chat-message-menu-btn'));
    fireEvent.click(within(bubble('root')).getByTestId('chat-message-reply'));
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByTestId('chat-reply-bar')).toBeNull();
  });

  it('shows a quote of what a reply answers, and a tap on it goes to that message', () => {
    const root = message('root', 0, { text: 'Who is late?' });
    panel([reply('r1', 1, root, { author: ben, text: 'The Duchess' }), root]);
    const q = within(bubble('r1')).getByTestId('chat-quote');
    expect(q.textContent).toContain('Ana');
    expect(q.textContent).toContain('Who is late?');
    fireEvent.click(q);
    expect(bubble('root').className).toContain('is-highlighted');
  });

  it('shows only where a gated parent opens, never its words', () => {
    const fenced = hidden('fenced', 0);
    panel([reply('r1', 1, fenced, { text: 'and then?' }), fenced]);
    const q = within(bubble('r1')).getByTestId('chat-quote');
    expect(q.getAttribute('data-hidden')).toBe('true');
    expect(q.textContent).toContain('Spoiler up to Chapter 9');
  });

  it('opens the thread on its own when the quoted message is not on screen', async () => {
    const root = message('root', 0, { text: 'An older question' });
    const answer = reply('r1', 1, root, { author: ben });
    vi.spyOn(api, 'chatThread').mockResolvedValue({ root: { ...root, replyCount: 1 }, replies: [answer], hasMore: false, channel: 'general' });
    panel([answer]);
    fireEvent.click(within(bubble('r1')).getByTestId('chat-quote'));
    const view = await screen.findByTestId('chat-thread');
    await waitFor(() => expect(within(view).getAllByTestId('chat-message').map((li) => li.getAttribute('data-message-id'))).toEqual(['root', 'r1']));
    await waitFor(() => expect(bubble('root').className).toContain('is-highlighted'));
    expect(screen.getByTestId('chat-thread-note').textContent).toContain('Replying in the thread');
    // Answering from the thread with nothing picked replies to its first message.
    type('Found it');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(posted[0]).toMatchObject({ text: 'Found it', parentId: 'root' }));
    fireEvent.click(screen.getByTestId('chat-thread-close'));
    expect(screen.queryByTestId('chat-thread')).toBeNull();
  });

  it('opens a thread from its root’s reply count', async () => {
    const root = message('root', 0, { replyCount: 2 });
    vi.spyOn(api, 'chatThread').mockResolvedValue({ root, replies: [reply('r1', 1, root), reply('r2', 2, root)], hasMore: false, channel: 'general' });
    panel([root]);
    const link = within(bubble('root')).getByTestId('chat-replies');
    expect(link.textContent).toContain('2 replies');
    fireEvent.click(link);
    const view = await screen.findByTestId('chat-thread');
    await waitFor(() => expect(within(view).getAllByTestId('chat-message')).toHaveLength(3));
    // No link to the thread already open.
    expect(within(view).queryByTestId('chat-replies')).toBeNull();
  });
});

describe('@-mentions (D201)', () => {
  it('offers members as you type @, never yourself, and writes the pick', () => {
    panel([]);
    act(() => input().focus());
    type('hi @gr');
    const options = () => screen.getAllByTestId('chat-mention-option').map((o) => o.querySelector('.chat-mention-name')!.textContent);
    expect(options()).toEqual(['Grant Lee', 'Grant Smith']);
    expect(input().getAttribute('aria-activedescendant')).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    // Grant alone would name two people: the whole name is written.
    expect(input().value).toBe('hi @Grant Smith ');
    expect(screen.queryByTestId('chat-mention-picker')).toBeNull();
    type('hi @Grant Smith and @a');
    expect(screen.queryAllByTestId('chat-mention-option').map((o) => o.querySelector('.chat-mention-name')!.textContent)).not.toContain('Ana');
  });

  it('picks with a tap, closes with Escape, and leaves Enter alone while an input method composes', () => {
    panel([]);
    act(() => input().focus());
    type('@b');
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(input().value).toBe('@b');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByTestId('chat-mention-picker')).toBeNull();
    type('@be');
    expect(screen.queryByTestId('chat-mention-picker')).toBeNull();
    type('');
    type('@B');
    fireEvent.click(screen.getByText('Ben Carter'));
    expect(input().value).toBe('@Ben ');
    expect(posted).toHaveLength(0);
  });

  it('picks with Enter as the very next key after the name, however the name got there', () => {
    panel([]);
    act(() => input().focus());
    // Text that arrived without keys (pasted, dictated, a phone's suggestion): the caret moved.
    type('@Be');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().value).toBe('@Ben ');
    expect(screen.queryByTestId('chat-mention-picker')).toBeNull();
    expect(posted).toHaveLength(0);
  });

  it('hides the picker while the field has no focus', () => {
    panel([]);
    act(() => input().focus());
    type('@g');
    expect(screen.getByTestId('chat-mention-picker')).toBeTruthy();
    act(() => input().blur());
    expect(screen.queryByTestId('chat-mention-picker')).toBeNull();
    act(() => input().focus());
    expect(screen.getByTestId('chat-mention-picker')).toBeTruthy();
  });

  it('highlights the mentions the server read, and marks a message that names you', () => {
    const text = 'hey @Ana and @Ben';
    panel(
      [
        message('m1', 0, {
          author: ben,
          text,
          mentions: [
            { start: 4, end: 8, userId: ana.userId, agent: null },
            { start: 13, end: 17, userId: ben.userId, agent: null },
          ],
        }),
      ],
      ana.userId,
    );
    const marks = within(bubble('m1')).getAllByTestId('chat-mention');
    expect(marks.map((m) => [m.textContent, m.getAttribute('data-me')])).toEqual([
      ['@Ana', 'true'],
      ['@Ben', null],
    ]);
    expect(bubble('m1').getAttribute('data-mentions-me')).toBe('true');
    expect(bubble('m1').textContent).toContain(text);
  });
});

describe('quote of a deleted parent', () => {
  it('says the message was deleted', () => {
    const root = message('root', 0);
    panel([reply('r1', 1, root, { replyTo: quote(root, { deleted: true, text: null }) })]);
    expect(within(bubble('r1')).getByTestId('chat-quote').textContent).toContain('Message deleted');
  });
});

describe('review fixes (D200, D201)', () => {
  it('answers the newest live reply in a thread whose first message is deleted', async () => {
    const root = message('root', 0, { deleted: true, text: null, replyCount: 2 });
    const one = reply('r1', 1, root);
    const two = reply('r2', 2, root);
    vi.spyOn(api, 'chatThread').mockResolvedValue({ root, replies: [one, two], hasMore: false, channel: 'general' });
    panel([root]);
    fireEvent.click(within(bubble('root')).getByTestId('chat-replies'));
    await waitFor(() => expect(within(screen.getByTestId('chat-thread')).getAllByTestId('chat-message')).toHaveLength(3));
    type('still here');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(posted[0]).toMatchObject({ parentId: 'r2' }));
  });

  it('keeps the caret where a pick left it when the pick changed nothing', () => {
    panel([]);
    act(() => input().focus());
    type('@Ben ');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().value).toBe('@Ben ');
    expect(input().selectionEnd).toBe(5);
    type('@Ben hello');
    expect(input().selectionEnd).toBe(10);
  });

  it('forgets the message being answered when a link opens another', async () => {
    const root = message('root', 0);
    vi.spyOn(api, 'chatThread').mockResolvedValue({ root, replies: [], hasMore: false, channel: 'general' });
    const qc = panel([root]);
    fireEvent.click(within(bubble('root')).getByTestId('chat-message-menu-btn'));
    fireEvent.click(within(bubble('root')).getByTestId('chat-message-reply'));
    expect(screen.getByTestId('chat-reply-bar')).toBeTruthy();
    cleanup();
    render(
      <QueryClientProvider client={qc}>
        <ChatPanel clubId={CLUB} books={[]} selfId={ana.userId} focusMessageId="root" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(bubble('root').className).toContain('is-highlighted'));
    expect(screen.queryByTestId('chat-reply-bar')).toBeNull();
  });

  it('draws a page kept from before a deploy, without the fields added since', () => {
    const old = { ...message('old', 0) } as Record<string, unknown>;
    delete old.mentions;
    delete old.replyTo;
    delete old.replyCount;
    delete old.threadId;
    delete old.attachments;
    panel([old as unknown as ChatMessageView]);
    expect(bubble('old').textContent).toContain('message old');
  });
});

describe('pictures (D203)', () => {
  const png = (name = 'shot.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
  let uploads: string[];
  let discarded: string[];

  beforeEach(() => {
    uploads = [];
    discarded = [];
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(api, 'uploadChatImage').mockImplementation(async (_club, _file, name) => {
      uploads.push(name);
      return { id: `up_${uploads.length}`, kind: 'image', status: 'ready', width: 800, height: 600, error: null };
    });
    vi.spyOn(api, 'discardChatImage').mockImplementation(async (id) => {
      discarded.push(id);
    });
  });

  const chips = () => screen.queryAllByTestId('chat-attachment');

  it('adds pictures from the picker, and sends them with or without words', async () => {
    panel([]);
    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [png('a.png'), png('b.png')] } });
    await waitFor(() => expect(chips().map((c) => c.getAttribute('data-status'))).toEqual(['ready', 'ready']));
    expect(uploads).toEqual(['a.png', 'b.png']);
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(posted[0]).toMatchObject({ text: '', attachmentIds: ['up_1', 'up_2'] }));
    await waitFor(() => expect(chips()).toHaveLength(0));
  });

  it('adds a pasted picture, and one dropped on the chat', async () => {
    panel([]);
    const clipboard = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => png('pasted.png') }], files: [], getData: () => '' };
    fireEvent.paste(input(), { clipboardData: clipboard });
    fireEvent.drop(screen.getByTestId('chat-panel'), { dataTransfer: { files: [png('dropped.png')], items: [], types: ['Files'] } });
    await waitFor(() => expect(uploads).toEqual(['pasted.png', 'dropped.png']));
    await waitFor(() => expect(chips()).toHaveLength(2));
  });

  it('takes a picture back from the server when it is removed', async () => {
    panel([]);
    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [png()] } });
    await waitFor(() => expect(chips()[0]!.getAttribute('data-status')).toBe('ready'));
    fireEvent.click(screen.getByTestId('chat-attachment-remove'));
    await waitFor(() => expect(discarded).toEqual(['up_1']));
    expect(chips()).toHaveLength(0);
    expect(screen.getByTestId<HTMLButtonElement>('chat-send').disabled).toBe(true);
  });

  it('shows a message’s pictures and opens one full size, with the next one a tap away', async () => {
    const image = (id: string) => ({ id, kind: 'image' as const, url: `/media/chat/${id}`, thumbUrl: `/media/chat/${id}/thumb`, width: 800, height: 600 });
    panel([message('m1', 0, { text: '', attachments: [image('p1'), image('p2')] })]);
    const thumbs = within(bubble('m1')).getAllByTestId('chat-image');
    expect(thumbs.map((t) => t.querySelector('img')!.getAttribute('src'))).toEqual(['/media/chat/p1/thumb', '/media/chat/p2/thumb']);
    fireEvent.click(thumbs[0]!);
    expect(screen.getByTestId('chat-lightbox-image').getAttribute('src')).toBe('/media/chat/p1');
    fireEvent.click(screen.getByTestId('chat-lightbox-next'));
    expect(screen.getByTestId('chat-lightbox-image').getAttribute('src')).toBe('/media/chat/p2');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('chat-lightbox-image').getAttribute('src')).toBe('/media/chat/p1');
  });

  it('says only how many pictures a fenced message holds', () => {
    panel([hidden('h1', 0, { attachments: [{ kind: 'image' }, { kind: 'image' }] })]);
    expect(within(bubble('h1')).getByTestId('chat-spoiler-marker').textContent).toContain('2 pictures');
    expect(within(bubble('h1')).queryByTestId('chat-image')).toBeNull();
  });
});
