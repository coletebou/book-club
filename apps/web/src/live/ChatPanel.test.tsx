import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BookSummary, ChatAgentView, ChatHistory, ChatMessageView, ClubDetail } from '@bookclub/shared';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toasts';
import { api } from '../lib/api';
import { ana, ben, cal, hidden, message, quote, reply } from '../lib/chat-test-data';
import { keys } from '../lib/queries';
import type * as Realtime from '../lib/realtime';
import { ChatPanel } from './ChatPanel';

/** Who is typing where, as the realtime client would hold it (`${clubId}:${bookId ?? ''}`): empty unless a test says. */
const typing = vi.hoisted(() => ({ byKey: new Map<string, Map<string, { displayName: string; until: number }>>() }));
vi.mock('../lib/realtime', async (importOriginal) => {
  const actual = await importOriginal<typeof Realtime>();
  return { ...actual, useChatTyping: (clubId: string | undefined, bookId: string | null) => typing.byKey.get(`${clubId}:${bookId ?? ''}`) ?? new Map() };
});

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
  typing.byKey.clear();
});

interface PanelOptions {
  /** The club's agents (D204), as `GET /chat/agents` lists them: none unless a test says. */
  readonly agents?: readonly ChatAgentView[];
  /** Leave the agents list to load (api.chatAgents, as a test mocks it). */
  readonly agentsPending?: boolean;
  readonly books?: readonly BookSummary[];
  /** Mount the app's toasts, to see what the panel says through them. */
  readonly toasts?: boolean;
}

/** The panel over a cache holding these General messages (newest first, as the server sends them). */
function panel(messages: ChatMessageView[], selfId = ana.userId, focusMessageId: string | null = null, options: PanelOptions = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData<ChatHistory>(keys.chat(CLUB, 'general'), { messages, hasMore: false });
  for (const b of options.books ?? []) qc.setQueryData<ChatHistory>(keys.chat(CLUB, b.id), { messages: [], hasMore: false });
  qc.setQueryData(keys.club(CLUB), club);
  if (!options.agentsPending) qc.setQueryData(keys.chatAgents(CLUB), { agents: options.agents ?? [] });
  const wrap = (children: ReactNode) => (options.toasts ? <ToastProvider>{children}</ToastProvider> : children);
  render(
    <QueryClientProvider client={qc}>
      {wrap(<ChatPanel clubId={CLUB} books={options.books ?? []} selfId={selfId} focusMessageId={focusMessageId} />)}
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

describe('agents in chat (D204)', () => {
  const CAL: ChatAgentView = { handle: 'cal', displayName: 'Cal', kind: 'cal', about: 'The club’s AI librarian. He answers in the thread, from what you have read, hidden from anyone who has not read as far.', avatar: null };
  const LUX: ChatAgentView = {
    handle: 'lux',
    displayName: 'Lux',
    kind: 'webhook',
    about: 'Takes requests for features and changes to Book Club. A message that names Lux is sent to it, outside Book Club, with the conversation it is in.',
    avatar: { kind: 'text', text: '🦊' },
  };
  const ALICE = { id: 'book_1', title: 'Alice' } as unknown as BookSummary;
  const names = () => screen.getAllByTestId('chat-mention-option').map((o) => o.querySelector('.chat-mention-name')!.textContent);

  it('offers Cal as you type @, says what he does before anything is sent, and a pick writes @cal', async () => {
    panel([], ana.userId, null, { agents: [CAL] });
    act(() => input().focus());
    type('@ca');
    // His name starts so: first; a word of Ben Carter's does: after him.
    expect(names()).toEqual(['Cal', 'Ben Carter']);
    const option = screen.getAllByTestId('chat-mention-option')[0]!;
    expect(within(option).getByTestId('chat-mention-about').textContent).toContain('from what you have read');
    expect(option.textContent).toContain('@cal');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().value).toBe('@cal ');
    type('@cal what does the Rabbit say?');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ text: '@cal what does the Rabbit say?' });
  });

  it('offers no agent where none is set up', () => {
    panel([], ana.userId, null, { agents: [] });
    act(() => input().focus());
    type('@cal');
    expect(screen.queryByTestId('chat-mention-picker')).toBeNull();
  });

  it('shows Cal’s answer as Cal: his own mark and an AI badge, never a person’s initials', () => {
    const root = message('ask', 0, { text: '@cal hello', mentions: [{ start: 0, end: 4, userId: null, agent: 'cal' }] });
    panel([message('answer', 1, { author: cal, text: 'Hello. [1]', parentId: 'ask', threadId: 'ask', replyTo: quote(root) }), root], ben.userId);
    const answer = bubble('answer');
    expect(answer.getAttribute('data-agent')).toBe('cal');
    expect(within(answer).getByTestId('chat-agent-badge').textContent).toBe('AI');
    expect(answer.querySelector('.chat-agent-avatar')).toBeTruthy();
    expect(answer.querySelector('.avatar:not(.chat-agent-avatar)')).toBeNull();
    // A person's message is not marked so.
    expect(within(bubble('ask')).queryByTestId('chat-agent-badge')).toBeNull();
    expect(bubble('ask').querySelector('.chat-mention.is-agent')?.textContent).toBe('@cal');
  });

  it('says Cal is typing in the channel he answers in, as well as who is typing anywhere', () => {
    typing.byKey.set(`${CLUB}:book_1`, new Map([[cal.userId, { displayName: 'Cal', until: Date.now() + 5000 }]]));
    typing.byKey.set(`${CLUB}:`, new Map([[ben.userId, { displayName: 'Ben Carter', until: Date.now() + 5000 }]]));
    panel([], ana.userId, null, { agents: [CAL], books: [ALICE] });
    expect(screen.getByTestId('chat-typing').textContent).toBe('Ben Carter is typing…');
    fireEvent.click(screen.getAllByTestId('chat-channel-chip').find((c) => c.textContent?.includes('Alice'))!);
    expect(screen.getByTestId('chat-typing').textContent).toBe('Ben Carter and Cal are typing…');
  });

  it('tells you, and only in this club’s chat, why Cal will not answer what you asked', async () => {
    panel([], ana.userId, null, { agents: [CAL], toasts: true });
    const notice = (clubId: string, text: string) =>
      act(() => {
        window.dispatchEvent(new CustomEvent('bc-chat-notice', { detail: { type: 'chat:notice', clubId, bookId: null, messageId: 'm1', agent: 'cal', text } }));
      });
    notice('another_club', 'Not for this chat.');
    notice(CLUB, 'You’ve asked Cal a lot in the last minute. Try again shortly.');
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toContain('You’ve asked Cal a lot in the last minute.'));
    expect(screen.getByTestId('toasts').textContent).not.toContain('Not for this chat.');
  });

  it('in a thread Cal has just answered, a follow-up goes to his answer: said in the reply bar, and as easily set aside', async () => {
    const ask = message('ask', 0, { text: '@cal who is late?', mine: true, replyCount: 1 });
    const answer = message('ans', 1, { author: cal, text: 'The White Rabbit.', parentId: 'ask', threadId: 'ask', replyTo: quote(ask) });
    vi.spyOn(api, 'chatThread').mockResolvedValue({ root: ask, replies: [answer], hasMore: false, channel: 'general' });
    panel([answer, ask], ana.userId, null, { agents: [CAL] });
    fireEvent.click(within(bubble('ask')).getByTestId('chat-replies'));
    await waitFor(() => expect(screen.getByTestId('chat-reply-bar').textContent).toContain('Replying to Cal'));
    type('and the caucus race?');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ text: 'and the caucus race?', parentId: 'ans' });
    // Set aside, it stays aside: the thread's own answer target is back.
    await waitFor(() => expect(screen.queryByTestId('chat-reply-bar')).toBeNull());
    type('thanks, all');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ parentId: 'ask' });
  });

  it('offers no one to mention until the club’s agents are known, then the agents with everyone', async () => {
    let known: (list: { agents: ChatAgentView[] }) => void = () => {};
    vi.spyOn(api, 'chatAgents').mockReturnValue(new Promise((resolve) => (known = resolve)));
    panel([], ana.userId, null, { agentsPending: true });
    act(() => input().focus());
    type('@ca');
    expect(screen.queryByTestId('chat-mention-picker')).toBeNull();
    await act(async () => known({ agents: [CAL] }));
    type('@ca ');
    type('@ca');
    await waitFor(() => expect(names()).toEqual(['Cal', 'Ben Carter']));
  });

  it('offers an agent of another service with its own mark, saying a message naming it leaves Book Club (D205)', () => {
    panel([], ana.userId, null, { agents: [CAL, LUX] });
    act(() => input().focus());
    type('@lu');
    const option = screen.getAllByTestId('chat-mention-option').find((o) => o.querySelector('.chat-mention-name')!.textContent === 'Lux')!;
    expect(option.querySelector('.chat-agent-avatar')!.textContent).toBe('🦊');
    expect(within(option).getByTestId('chat-mention-about').textContent).toContain('sent to it, outside Book Club');
    fireEvent.click(option);
    expect(input().value).toBe('@lux ');
  });

  it('shows an agent of another service’s message with its own mark and a Bot badge (D205)', () => {
    const lux = { userId: 'user_lux', displayName: 'Lux', color: '#4f8a7a', agent: 'lux' };
    const picture = { kind: 'image' as const, src: 'data:image/png;base64,iVBORw0KGgo=' };
    panel([message('m1', 0, { author: lux, text: 'Shipped.' })], ana.userId, null, { agents: [{ ...LUX, avatar: picture }] });
    const m = bubble('m1');
    expect(within(m).getByTestId('chat-agent-badge').textContent).toBe('Bot');
    expect(m.querySelector('.chat-agent-avatar img')!.getAttribute('src')).toBe(picture.src);
  });

  describe('a message that will leave Book Club says so before it goes (D205)', () => {
    const lux = { userId: 'user_lux', displayName: 'Lux', color: '#4f8a7a', agent: 'lux' };
    const note = () => screen.queryByTestId('chat-outside-note')?.textContent ?? null;

    it('when it names an agent of another service; never for Cal, nor for the club alone', () => {
      panel([], ana.userId, null, { agents: [CAL, LUX] });
      expect(note()).toBeNull();
      type('@lux could the chat show who reacted?');
      expect(note()).toBe('Sent to Lux, outside Book Club');
      type('@cal who is the White Rabbit late for?');
      expect(note()).toBeNull();
      type('just us here');
      expect(note()).toBeNull();
    });

    it('in a thread under such an agent’s own message: every reply goes to it, unless it names someone else', async () => {
      const root = message('lux1', 0, { author: lux, text: 'Shipped: reactions show who. Tell me what you think.', replyCount: 1 });
      const answer = message('r1', 1, { author: ben, text: 'Nice!', parentId: 'lux1', threadId: 'lux1', replyTo: quote(root) });
      vi.spyOn(api, 'chatThread').mockResolvedValue({ root, replies: [answer], hasMore: false, channel: 'general' });
      panel([answer, root], ana.userId, null, { agents: [CAL, LUX] });
      fireEvent.click(within(bubble('lux1')).getByTestId('chat-replies'));
      expect(screen.getByTestId('chat-thread-note').textContent).toContain('Replying in the thread');
      // Nothing picked: a reply answers the thread's first message, Lux's own (once the thread is in).
      await waitFor(() => expect(note()).toBe('Sent to Lux, outside Book Club'));
      type('@Ben Carter agreed?');
      expect(note()).toBeNull();
      type('love it');
      expect(note()).toBe('Sent to Lux, outside Book Club');
      fireEvent.keyDown(input(), { key: 'Enter' });
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({ text: 'love it', parentId: 'lux1' });
    });

    it('in such a thread even when the club’s agents could not be fetched: the message answered says who wrote it', async () => {
      vi.spyOn(api, 'chatAgents').mockRejectedValue(new Error('offline'));
      const root = message('lux1', 0, { author: lux, text: 'Shipped: reactions show who.', replyCount: 1 });
      const answer = message('r1', 1, { author: ben, text: 'Nice!', parentId: 'lux1', threadId: 'lux1', replyTo: quote(root) });
      vi.spyOn(api, 'chatThread').mockResolvedValue({ root, replies: [answer], hasMore: false, channel: 'general' });
      panel([answer, root], ana.userId, null, { agentsPending: true });
      fireEvent.click(within(bubble('lux1')).getByTestId('chat-replies'));
      await waitFor(() => expect(note()).toBe('Sent to Lux, outside Book Club'));
      // Naming a member addresses them instead, as the server reads it.
      type('@Ben Carter agreed?');
      expect(note()).toBeNull();
      type('love it');
      expect(note()).toBe('Sent to Lux, outside Book Club');
    });

    it('holds a message that may name an agent while the club’s agents could not be fetched; one that names none goes', async () => {
      vi.spyOn(api, 'chatAgents').mockRejectedValue(new Error('offline'));
      panel([], ana.userId, null, { agentsPending: true });
      type('@lux could the chat show who reacted?');
      await waitFor(() => expect(note()).toBe('Waiting to learn whether @lux is an agent outside Book Club before this is sent'));
      fireEvent.keyDown(input(), { key: 'Enter' });
      await act(async () => {});
      expect(posted).toHaveLength(0);
      // A member named is no agent: that goes.
      type('@Ben Carter just us');
      expect(note()).toBeNull();
      fireEvent.keyDown(input(), { key: 'Enter' });
      await waitFor(() => expect(posted).toHaveLength(1));
    });

    it('lets a held message go once the club’s agents are known, saying where it goes', async () => {
      let known: (list: { agents: ChatAgentView[] }) => void = () => {};
      vi.spyOn(api, 'chatAgents').mockReturnValue(new Promise((resolve) => (known = resolve)));
      panel([], ana.userId, null, { agentsPending: true });
      type('@lux could the chat show who reacted?');
      expect(note()).toBe('Waiting to learn whether @lux is an agent outside Book Club before this is sent');
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(posted).toHaveLength(0);
      await act(async () => known({ agents: [LUX] }));
      await waitFor(() => expect(note()).toBe('Sent to Lux, outside Book Club'));
      fireEvent.keyDown(input(), { key: 'Enter' });
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({ text: '@lux could the chat show who reacted?' });
    });

    it('when the reply picked answers such an agent, and not when it answers a person', () => {
      panel([message('ben1', 1, { author: ben, text: 'Me too.' }), message('lux2', 0, { author: lux, text: 'On it.' })], ana.userId, null, { agents: [LUX] });
      const replyTo = (id: string) => {
        fireEvent.click(within(bubble(id)).getByTestId('chat-message-menu-btn'));
        fireEvent.click(within(bubble(id)).getByTestId('chat-message-reply'));
      };
      replyTo('lux2');
      expect(screen.getByTestId('chat-reply-bar').textContent).toContain('Replying to Lux');
      expect(note()).toBe('Sent to Lux, outside Book Club');
      fireEvent.click(screen.getByTestId('chat-reply-cancel'));
      expect(note()).toBeNull();
      replyTo('ben1');
      expect(note()).toBeNull();
    });
  });
});
