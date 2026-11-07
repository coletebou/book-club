import { describe, expect, it } from 'vitest';
import { directoryOf, keepRevealed, mentionsMe, normalizeChatView, quoteOf, replyTargetOf, requote, spansOf } from './chat-model';
import { ana, ben, hidden, message, reply } from './chat-test-data';

describe('chat-model (D200, D201)', () => {
  it('quotes a parent as its own view shows it to this viewer', () => {
    expect(quoteOf(message('m1', 0, { text: 'Who is late?' }))).toMatchObject({ hidden: false, deleted: false, text: 'Who is late?' });
    expect(quoteOf(hidden('m2', 0))).toEqual({ id: 'm2', author: ben, hidden: true, deleted: false, text: null, spoilerLabel: 'Spoiler up to Chapter 9', imageCount: 0 });
    expect(quoteOf(message('m3', 0, { deleted: true, text: null }))).toMatchObject({ hidden: false, deleted: true, text: null });
    expect(quoteOf(message('m4', 0, { text: 'word '.repeat(60) })).text!.endsWith('…')).toBe(true);
  });

  it('requotes a reply from its parent, or marks the quote gone', () => {
    const root = message('root', 0, { text: 'before' });
    const child = reply('child', 1, root);
    expect(requote(child, { ...root, text: 'after' }).replyTo!.text).toBe('after');
    expect(requote(child, null).replyTo).toMatchObject({ deleted: true, text: null, hidden: false });
    expect(requote(message('plain', 0), null).replyTo).toBeNull();
  });

  it('fills in what a view kept from before a deploy lacks', () => {
    const old = { ...message('m', 0) } as Record<string, unknown>;
    for (const k of ['mentions', 'replyTo', 'replyCount', 'threadId', 'attachments']) delete old[k];
    expect(normalizeChatView(old as never)).toMatchObject({ mentions: [], replyTo: null, replyCount: 0, threadId: null, attachments: [] });
  });

  it('never lets a hidden copy replace a revealed one', () => {
    expect(keepRevealed(message('m', 0), hidden('m', 0))).toBe(true);
    expect(keepRevealed(hidden('m', 0), message('m', 0))).toBe(false);
  });

  it('reads the server’s mention spans, and whether one names the viewer', () => {
    const m = message('m', 0, {
      text: '@Ana and @cal',
      mentions: [
        { start: 0, end: 4, userId: ana.userId, agent: null },
        { start: 9, end: 13, userId: null, agent: 'cal' },
        { start: 5, end: 6, userId: null, agent: null },
      ],
    });
    expect(spansOf(m)).toEqual([
      { start: 0, end: 4, target: { kind: 'member', id: ana.userId } },
      { start: 9, end: 13, target: { kind: 'agent', handle: 'cal' } },
    ]);
    expect(mentionsMe(m, ana.userId)).toBe(true);
    expect(mentionsMe(m, ben.userId)).toBe(false);
    expect(mentionsMe(m, undefined)).toBe(false);
    expect(spansOf(hidden('h', 0))).toEqual([]);
  });

  it('builds the club’s directory and what the composer shows of a message being answered', () => {
    const directory = directoryOf([
      { userId: ana.userId, displayName: 'Ana', color: '#000', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z', source: 'local' },
      { userId: ben.userId, displayName: 'Ben Carter', color: '#000', role: 'member', joinedAt: '2026-01-01T00:00:00.000Z', source: 'local' },
    ]);
    expect(directory.candidates.map((c) => c.displayName)).toEqual(['Ana', 'Ben Carter']);
    expect(replyTargetOf(message('m', 0, { text: 'hello there' }))).toEqual({ id: 'm', authorName: 'Ana', authorColor: ana.color, text: 'hello there' });
    expect(replyTargetOf(hidden('h', 0)).text).toBeNull();
  });
});
