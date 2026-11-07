import { describe, expect, it } from 'vitest';
import { findMentions } from '@bookclub/chat-core';
import type { ChatAgentView, Member } from '@bookclub/shared';
import { authorKind, directoryOf, keepRevealed, mentionsMe, normalizeChatView, possibleAgentHandles, quoteOf, replyTargetOf, requote, sentOutsideTo, spansOf } from './chat-model';
import { ana, ben, cal, hidden, message, quote, reply } from './chat-test-data';

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
    expect(replyTargetOf(message('m', 0, { text: 'hello there' }))).toEqual({ id: 'm', authorName: 'Ana', authorColor: ana.color, text: 'hello there', authorAgent: null });
    expect(replyTargetOf(hidden('h', 0)).text).toBeNull();
    // An agent's message says whose it is: answering it asks that agent (D204, D205).
    expect(replyTargetOf(message('a', 0, { author: cal, text: 'The Duchess.' })).authorAgent).toBe('cal');
  });
});

describe('chat-model: agents (D204)', () => {
  const CAL: ChatAgentView = { handle: 'cal', displayName: 'Cal', kind: 'cal', about: 'The club’s AI librarian.', avatar: null };
  const member = (userId: string, displayName: string) => ({ userId, displayName }) as Member;

  it('puts the club’s agents in the directory by handle, as the server does: @cal is Cal before a member whose first name it is', () => {
    const directory = directoryOf([member('u1', 'Cal Smith'), member('u2', 'Ana')], [CAL]);
    expect(findMentions('@cal hi', directory)).toEqual([{ start: 0, end: 4, target: { kind: 'agent', handle: 'cal' } }]);
    // Without him, the first name names its member, as before.
    expect(findMentions('@cal hi', directoryOf([member('u1', 'Cal Smith')]))).toEqual([{ start: 0, end: 4, target: { kind: 'member', id: 'u1' } }]);
    // A member whose whole name is the handle keeps it (a whole name is the strongest reading, D201).
    expect(findMentions('@cal hi', directoryOf([member('u3', 'Cal')], [CAL]))[0]!.target).toEqual({ kind: 'member', id: 'u3' });
  });

  it('tells a person from Cal from another agent', () => {
    expect(authorKind(ana)).toBe('person');
    expect(authorKind(cal)).toBe('cal');
    expect(authorKind({ ...cal, agent: 'lux' })).toBe('agent');
  });

  it('says which agents of other services a draft would be sent to, as the server will read it once sent (D205)', () => {
    const LUX: ChatAgentView = { handle: 'lux', displayName: 'Lux', kind: 'webhook', about: 'Takes requests.', avatar: null };
    const SCOUT: ChatAgentView = { handle: 'scout', displayName: 'Scout', kind: 'webhook', about: 'Finds things.', avatar: null };
    const agents = [CAL, LUX, SCOUT];
    const directory = directoryOf([member('u1', 'Ana'), member('u2', 'Ben Carter')], agents);
    const author = (agent: string | null) => ({ agent, name: agents.find((a) => a.handle === agent)?.displayName ?? 'Ana' });
    const to = (text: string, answering: string | null = null) => sentOutsideTo(text, directory, answering ? author(answering) : null, agents);
    // Every one it names; never Cal, whose answers are Book Club's own.
    expect(to('@lux could the chat show who reacted?')).toEqual(['Lux']);
    // (In the order they are configured, as the server asks them.)
    expect(to('@scout and @lux, both of you')).toEqual(['Lux', 'Scout']);
    expect(to('@cal who is late?')).toEqual([]);
    // Failing that, the one whose message it answers, unless it names someone else.
    expect(to('thanks!', 'lux')).toEqual(['Lux']);
    expect(to('@Ben Carter what do you think?', 'lux')).toEqual([]);
    expect(to('@cal is that right?', 'lux')).toEqual([]);
    expect(to('thanks!', 'cal')).toEqual([]);
    expect(to('thanks!')).toEqual([]);
    // Words in code are no mention, as the server reads them.
    expect(to('`@lux` is how you ask it')).toEqual([]);
    expect(sentOutsideTo('@lux hi', directoryOf([], [CAL]), null, [CAL])).toEqual([]);
    // An agent the club's list does not have (no longer in this club) is asked no more.
    expect(sentOutsideTo('thanks!', directoryOf([member('u1', 'Ana')], [CAL]), { agent: 'lux', name: 'Lux' }, [CAL])).toEqual([]);
  });

  it('while the club’s agents are not known, still says a reply to an agent of another service leaves Book Club (D205)', () => {
    const directory = directoryOf([member('u1', 'Ana'), member('u2', 'Ben Carter')]);
    const unknown = (text: string, answering: { agent: string | null; name: string } | null) => sentOutsideTo(text, directory, answering, null);
    // The message it answers says an agent wrote it, and every agent but Cal is another service's.
    expect(unknown('love it', { agent: 'lux', name: 'Lux' })).toEqual(['Lux']);
    expect(unknown('love it', { agent: 'cal', name: 'Cal' })).toEqual([]);
    expect(unknown('love it', { agent: null, name: 'Ana' })).toEqual([]);
    expect(unknown('love it', null)).toEqual([]);
    // Naming someone else addresses them instead, as the server reads it.
    expect(unknown('@Ben Carter agreed?', { agent: 'lux', name: 'Lux' })).toEqual([]);
  });

  it('while the club’s agents are not known, finds the @handles a draft may name as agents, as the server would read them (D205)', () => {
    const members = [member('u1', 'Ana'), member('u2', 'Ben Carter')];
    expect(possibleAgentHandles('@lux could the chat show who reacted?', members)).toEqual(['lux']);
    expect(possibleAgentHandles('@Lux and @scout, both of you', members)).toEqual(['lux', 'scout']);
    // A member, Cal, an email address and code are no agents of another service.
    expect(possibleAgentHandles('@Ana what do you think?', members)).toEqual([]);
    expect(possibleAgentHandles('@Ben Carter agreed?', members)).toEqual([]);
    expect(possibleAgentHandles('@cal who is late?', members)).toEqual([]);
    expect(possibleAgentHandles('write to ana@lux.example', members)).toEqual([]);
    expect(possibleAgentHandles('`@lux` is how you ask it', members)).toEqual([]);
    expect(possibleAgentHandles('no one named here', members)).toEqual([]);
  });

  it('fills in an author’s agent on a view kept from before agents (a person, then)', () => {
    const old = message('m', 1, { replyTo: quote(message('p', 0)) });
    const { agent: _a, ...author } = old.author;
    const { agent: _b, ...quoted } = old.replyTo!.author;
    const view = normalizeChatView({ ...old, author, replyTo: { ...old.replyTo!, author: quoted } } as never);
    expect(view.author.agent).toBeNull();
    expect(view.replyTo!.author.agent).toBeNull();
  });
});
