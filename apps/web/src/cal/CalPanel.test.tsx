import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalConversationDetail, CalConversationSummary, CalMessage } from '../lib/cal-api';

/**
 * Cal's panel with threads (D183): it opens on the latest thread (about the book it was opened
 * from, if any), lists every earlier one to carry on in, starts a new one only at its first
 * question, and carries no spoiler control of its own — the scope lives in his settings.
 */

const api = vi.hoisted(() => ({
  status: vi.fn(),
  settings: vi.fn(),
  conversations: vi.fn(),
  conversation: vi.fn(),
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  stream: vi.fn(),
}));

vi.mock('../lib/cal-api', () => ({
  calApi: {
    status: api.status,
    settings: api.settings,
    conversations: api.conversations,
    conversation: api.conversation,
    createConversation: api.createConversation,
    deleteConversation: api.deleteConversation,
    shelf: vi.fn(() => Promise.resolve([])),
  },
  streamCalMessage: api.stream,
}));
vi.mock('../player/pauseWhile', () => ({ usePauseAudiobookWhile: () => undefined }));

/** A stand-in for push-to-talk (jsdom has no microphone): a turn's state is set by each test. */
const voice = vi.hoisted(() => ({
  state: { supported: true, recording: false, speaking: false, replying: false, transcript: null as string | null, error: null as string | null, busy: false },
  start: vi.fn((_inConversation?: string) => Promise.resolve()),
}));
vi.mock('./useCalVoice', () => ({
  useCalVoice: () => ({ ...voice.state, start: voice.start, stop: vi.fn(), bargeIn: vi.fn() }),
}));

import { CalPanel, replyVoiceLine } from './CalPanel';

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

function message(id: string, role: 'user' | 'assistant', text: string): CalMessage {
  return { id, role, content: [{ type: 'text', text }], wholeSeries: false, createdAt: iso(1) };
}

const rabbit: CalConversationSummary = { id: 'c_rabbit', title: 'What does the White Rabbit say?', bookId: 'b_alice', bookTitle: 'Alice', shared: false, createdAt: iso(90), updatedAt: iso(5) };
const cat: CalConversationSummary = { id: 'c_cat', title: 'Who is the Cheshire Cat?', bookId: null, bookTitle: null, shared: false, createdAt: iso(3000), updatedAt: iso(2000) };

const details: Record<string, CalConversationDetail> = {
  c_rabbit: { ...rabbit, messages: [message('m1', 'user', 'What does the White Rabbit say?'), message('m2', 'assistant', 'He is late.')] },
  c_cat: { ...cat, messages: [message('m3', 'user', 'Who is the Cheshire Cat?'), message('m4', 'assistant', 'A grinning cat.')] },
};

function renderPanel(bookId: string | null = null) {
  return render(
    <MemoryRouter>
      <CalPanel clubId="club_1" bookId={bookId} onClose={() => undefined} />
    </MemoryRouter>,
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  api.status.mockResolvedValue({ enabled: true, webSearch: false });
  api.settings.mockResolvedValue({ wholeSeries: false });
  api.conversations.mockResolvedValue([rabbit, cat]);
  api.conversation.mockImplementation((id: string) => Promise.resolve(details[id]));
  api.createConversation.mockResolvedValue({ id: 'c_new', title: '', bookId: null, bookTitle: null, shared: false, updatedAt: iso(0) });
  api.deleteConversation.mockResolvedValue(undefined);
  api.stream.mockImplementation(async (_id: string, text: string, handlers: { onDone?: (m: CalMessage) => void }) => {
    handlers.onDone?.(message(`reply-${text}`, 'assistant', `Answer to ${text}`));
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  voice.state = { supported: true, recording: false, speaking: false, replying: false, transcript: null, error: null, busy: false };
  // jsdom lays nothing out, so it has no scrollTo for the panel's keep-the-latest-in-view effect.
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Cal panel threads (D183)', () => {
  it('opens on the latest thread, with its full history, and has no spoiler checkbox in the chat', async () => {
    renderPanel();
    await settle();
    expect(api.conversation).toHaveBeenCalledWith('c_rabbit');
    expect(screen.getByTestId('cal-thread-current').textContent).toBe('What does the White Rabbit say?');
    expect(screen.getByText('He is late.')).toBeTruthy();
    expect(screen.queryByTestId('cal-whole-series')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    // The hint says where the scope is chosen instead.
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-new-chat'));
    });
    expect(screen.getByTestId('cal-hint').textContent).toMatch(/open his settings/);
  });

  it('opened from a book, carries on in that book’s latest thread', async () => {
    renderPanel('b_alice');
    await settle();
    expect(api.conversation).toHaveBeenCalledWith('c_rabbit');
    expect(api.conversation).not.toHaveBeenCalledWith('c_cat');
  });

  it('opened from a book with no thread yet, waits on a new chat and creates nothing until the first question', async () => {
    renderPanel('b_other');
    await settle();
    expect(api.conversation).not.toHaveBeenCalled();
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(screen.getByTestId('cal-thread-current').textContent).toBe('New chat');
  });

  it('lists every thread, most recent first, with when; switching shows that thread’s own history', async () => {
    renderPanel();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-threads-open'));
    });
    await settle();
    const rows = screen.getAllByTestId('cal-thread');
    expect(rows.map((r) => within(r).getByText(/\?$/).textContent)).toEqual(['What does the White Rabbit say?', 'Who is the Cheshire Cat?']);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
    expect(rows[0]!.textContent).toContain('5 min ago');
    expect(rows[0]!.textContent).toContain('Alice');

    await act(async () => {
      fireEvent.click(rows[1]!);
    });
    await settle();
    expect(screen.getByTestId('cal-thread-current').textContent).toBe('Who is the Cheshire Cat?');
    expect(screen.getByText('A grinning cat.')).toBeTruthy();
    expect(screen.queryByText('He is late.')).toBeNull();
  });

  it('a new chat is created at its first question, and later questions go to the same thread', async () => {
    renderPanel();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-new-chat'));
    });
    expect(screen.queryByText('He is late.')).toBeNull();
    expect(api.createConversation).not.toHaveBeenCalled();

    const input = screen.getByTestId('cal-input');
    fireEvent.change(input, { target: { value: 'Is the Hatter mad?' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-send'));
    });
    await settle();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.createConversation).toHaveBeenCalledWith('club_1', { bookId: null });
    expect(api.stream).toHaveBeenLastCalledWith('c_new', 'Is the Hatter mad?', expect.anything());
    expect(screen.getByText('Answer to Is the Hatter mad?')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'And the March Hare?' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-send'));
    });
    await settle();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.stream).toHaveBeenLastCalledWith('c_new', 'And the March Hare?', expect.anything());
  });

  it('a question in an existing thread goes to that thread, with no spoiler scope sent', async () => {
    renderPanel();
    await settle();
    fireEvent.change(screen.getByTestId('cal-input'), { target: { value: 'Why is he late?' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-send'));
    });
    await settle();
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.stream).toHaveBeenCalledWith('c_rabbit', 'Why is he late?', expect.anything());
    // Exactly three arguments: the thread, the text, the handlers — no per-question scope.
    expect(api.stream.mock.calls[0]).toHaveLength(3);
  });

  it('deleting the open thread, after confirming, leaves a new chat and the others listed', async () => {
    renderPanel();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-threads-open'));
    });
    await settle();
    api.conversations.mockResolvedValue([cat]);
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('cal-thread-delete')[0]!);
    });
    const confirm = screen.getByRole('alertdialog', { name: 'Delete this chat?' });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    });
    await settle();
    expect(api.deleteConversation).toHaveBeenCalledWith('c_rabbit');
    expect(screen.getAllByTestId('cal-thread').map((r) => r.textContent)).toEqual([expect.stringContaining('Who is the Cheshire Cat?')]);
    expect(screen.getByTestId('cal-thread-new')).toBeTruthy();
  });

  it('a send and a mic tap at once in a new chat make one thread, not two', async () => {
    let finishCreate: (v: CalConversationSummary) => void = () => undefined;
    api.createConversation.mockImplementation(() => new Promise((resolve) => (finishCreate = resolve)));
    api.conversations.mockResolvedValue([]);
    renderPanel();
    await settle();

    fireEvent.change(screen.getByTestId('cal-input'), { target: { value: 'Is the Hatter mad?' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-send'));
      fireEvent.click(screen.getByRole('button', { name: 'Talk to Cal' }));
      fireEvent.click(screen.getByRole('button', { name: 'Talk to Cal' }));
    });
    await act(async () => {
      finishCreate({ id: 'c_once', title: '', bookId: null, shared: false, updatedAt: iso(0) });
    });
    await settle();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.stream).toHaveBeenCalledWith('c_once', 'Is the Hatter mad?', expect.anything());
    expect(voice.start).toHaveBeenCalledWith('c_once');
    expect(voice.start.mock.calls.every(([id]) => id === 'c_once')).toBe(true);
  });

  it('while a voice turn is under way, the thread stays fixed: no new chat, switching or deleting', async () => {
    renderPanel();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-threads-open'));
    });
    await settle();
    voice.state = { ...voice.state, busy: true, recording: true };
    // Re-render with the turn under way (the real hook re-renders its panel the same way).
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-threads-open'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-threads-open'));
    });
    expect(screen.getByTestId<HTMLButtonElement>('cal-new-chat').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('cal-thread-new').disabled).toBe(true);
    for (const row of screen.getAllByTestId<HTMLButtonElement>('cal-thread')) expect(row.disabled).toBe(true);
    for (const bin of screen.getAllByTestId<HTMLButtonElement>('cal-thread-delete')) expect(bin.disabled).toBe(true);
  });

  it('the voice transcript belongs to the thread it was spoken in', async () => {
    renderPanel();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Talk to Cal' }));
    });
    await settle();
    expect(voice.start).toHaveBeenCalledWith('c_rabbit');
    voice.state = { ...voice.state, transcript: 'Why is he late?' };
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-threads-open'));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('cal-thread')[0]!);
    });
    await settle();
    expect(screen.getByText('You said: “Why is he late?”')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cal-new-chat'));
    });
    expect(screen.queryByText(/You said/)).toBeNull();
  });
});

describe('saying whose voice Cal answers in (D223)', () => {
  it('never calls a voice made to match a narrator the narrator’s own; only a consented clone is theirs', () => {
    expect(replyVoiceLine({ kind: 'narrator', narrator: 'Kris Reader', source: 'designed' })).toBe('Cal is answering in a voice made to sound like Kris Reader, the narrator. It isn’t Kris Reader.');
    expect(replyVoiceLine({ kind: 'narrator', narrator: '', source: 'designed' })).toBe('Cal is answering in a voice made to sound like the narrator.');
    expect(replyVoiceLine({ kind: 'narrator', narrator: 'Kris Reader', source: 'clone' })).toBe('Cal is answering in Kris Reader’s voice, with their permission.');
    expect(replyVoiceLine({ kind: 'narrator', narrator: 'Kris Reader', source: 'narration' })).toBe('Cal is answering in the voice that reads this audiobook.');
  });
});

describe('the rate a reply in a narrator’s voice plays at (D223)', () => {
  it('is the listener’s own speed times the server’s correction for the narrator’s pace', async () => {
    const { narratorReplyRate } = await import('./CalPanel');
    expect(narratorReplyRate({ kind: 'narrator', narrator: '', source: 'designed', rate: 0.83 }, 1.5)).toBeCloseTo(1.245, 5);
    expect(narratorReplyRate({ kind: 'narrator', narrator: '', source: 'designed' }, 1.25)).toBe(1.25);
    expect(narratorReplyRate({ kind: 'cal' }, 1.5)).toBe(1);
  });
});

