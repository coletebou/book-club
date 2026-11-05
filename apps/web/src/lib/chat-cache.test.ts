import { QueryClient } from '@tanstack/react-query';
import type { ChatHistory } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { hidden, message, reply } from './chat-test-data';
import { type ChatThreadCache, keys, loadOlderChat, mergeChatMessage, removeChatMessage, toThreadCache } from './queries';

afterEach(() => {
  vi.restoreAllMocks();
});

const CLUB = 'club_1';

function seeded() {
  const qc = new QueryClient();
  const root = message('root', 0, { text: 'Who is late?' });
  qc.setQueryData<ChatHistory>(keys.chat(CLUB, 'general'), { messages: [root], hasMore: false });
  qc.setQueryData<ChatThreadCache>(keys.chatThread('root'), toThreadCache({ root, replies: [], hasMore: false, channel: 'general' }));
  return { qc, root };
}

const general = (qc: QueryClient) => qc.getQueryData<ChatHistory>(keys.chat(CLUB, 'general'))!;
const thread = (qc: QueryClient) => qc.getQueryData<ChatThreadCache>(keys.chatThread('root'));

describe('the chat cache (D199, D200)', () => {
  it('puts a live reply in its channel and its thread, counting it on the root', () => {
    const { qc, root } = seeded();
    const answer = reply('r1', 1, root);
    mergeChatMessage(qc, CLUB, null, answer);
    expect(general(qc).messages.map((m) => m.id)).toEqual(['r1', 'root']);
    expect(general(qc).messages.find((m) => m.id === 'root')!.replyCount).toBe(1);
    expect(thread(qc)!.messages.map((m) => m.id)).toEqual(['r1', 'root']);
    expect(thread(qc)!.messages.find((m) => m.id === 'root')!.replyCount).toBe(1);
    expect(thread(qc)!.rootId).toBe('root');
  });

  it('requotes replies when their parent is edited, and never un-reveals', () => {
    const { qc, root } = seeded();
    mergeChatMessage(qc, CLUB, null, reply('r1', 1, root));
    mergeChatMessage(qc, CLUB, null, { ...root, text: 'Who is very late?' });
    expect(general(qc).messages.find((m) => m.id === 'r1')!.replyTo!.text).toBe('Who is very late?');
    mergeChatMessage(qc, CLUB, null, hidden('root', 0, { bookId: null }));
    expect(general(qc).messages.find((m) => m.id === 'root')!.hidden).toBe(false);
  });

  it('removes a reply with its thread’s count, and a root gone for good takes its thread', () => {
    const { qc, root } = seeded();
    mergeChatMessage(qc, CLUB, null, reply('r1', 1, root));
    removeChatMessage(qc, CLUB, null, 'r1', 'root');
    expect(general(qc).messages.map((m) => m.id)).toEqual(['root']);
    expect(general(qc).messages[0]!.replyCount).toBe(0);
    expect(thread(qc)!.messages.map((m) => m.id)).toEqual(['root']);
    removeChatMessage(qc, CLUB, null, 'root', null);
    expect(general(qc).messages).toEqual([]);
    expect(thread(qc)).toBeUndefined();
  });

  it('loads the page before the oldest held, after it', async () => {
    const qc = new QueryClient();
    qc.setQueryData<ChatHistory>(keys.chat(CLUB, 'general'), { messages: [message('b', 1)], hasMore: true });
    const chat = vi.spyOn(api, 'chat').mockResolvedValue({ messages: [message('a', 0)], hasMore: false });
    await loadOlderChat(qc, CLUB, 'general');
    expect(chat).toHaveBeenCalledWith(CLUB, { channel: 'general', before: 'b' });
    expect(general(qc)).toEqual({ messages: [message('b', 1), message('a', 0)], hasMore: false });
    await loadOlderChat(qc, CLUB, 'general');
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
