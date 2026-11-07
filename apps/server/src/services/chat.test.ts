import { describe, expect, it } from 'vitest';
import { type ChatMessageWithAuthor } from '../repos/chat';
import { type Gate } from './gating';
import { type ChatGateContext, toChatView } from './chat';

function row(overrides: Partial<ChatMessageWithAuthor> = {}): ChatMessageWithAuthor {
  return {
    id: 'm1',
    club_id: 'club1',
    book_id: 'book1',
    user_id: 'author1',
    parent_id: null,
    thread_id: null,
    text: 'a spoiler-fenced message',
    spoiler_t: 42,
    spoiler_edition_id: 'edition1',
    spoiler_user_id: null,
    client_id: null,
    created_at: Date.now(),
    edited_at: null,
    deleted_at: null,
    author_name: 'Author',
    author_color: null,
    author_agent: null,
    ...overrides,
  };
}

const CLOSED_GATE = { gate: null, reading: null, chapters: [], referenceEditionId: null } satisfies ChatGateContext;
const OPEN_GATE_CTX = (isOpen: boolean): ChatGateContext => ({
  gate: { isOpen: () => isOpen } as unknown as Gate,
  reading: { byEdition: new Map(), unplaced: [] },
  chapters: [],
  referenceEditionId: 'edition1',
});

describe('toChatView (PR #13 review: deleted book lifts chat spoiler fence)', () => {
  it('hides a fenced message from a viewer who is not its author when there is no gate or reading to judge it against', () => {
    const view = toChatView(row(), CLOSED_GATE, 'someone-else', []);
    expect(view.hidden).toBe(true);
  });

  it('still shows a fenced message to its own author with no gate/reading context', () => {
    const view = toChatView(row({ user_id: 'viewer1' }), CLOSED_GATE, 'viewer1', []);
    expect(view.hidden).toBe(false);
  });

  it('shows an unfenced message to anyone even with no gate/reading context (general club chat)', () => {
    const view = toChatView(row({ spoiler_t: null, spoiler_edition_id: null, book_id: null }), CLOSED_GATE, 'someone-else', []);
    expect(view.hidden).toBe(false);
  });

  it('defers to the gate when one is actually present: open', () => {
    const view = toChatView(row(), OPEN_GATE_CTX(true), 'someone-else', []);
    expect(view.hidden).toBe(false);
  });

  it('defers to the gate when one is actually present: still closed', () => {
    const view = toChatView(row(), OPEN_GATE_CTX(false), 'someone-else', []);
    expect(view.hidden).toBe(true);
  });
});

describe('toChatView: an agent’s answer fenced at its asker’s place (D204)', () => {
  const answer = (overrides: Partial<ChatMessageWithAuthor> = {}) => row({ user_id: 'cal1', author_name: 'Cal', author_agent: 'cal', spoiler_user_id: 'asker1', ...overrides });

  it('opens for the member it answers however the gate judges their reading, as their own words do', () => {
    expect(toChatView(answer(), OPEN_GATE_CTX(false), 'asker1', []).hidden).toBe(false);
    expect(toChatView(answer(), CLOSED_GATE, 'asker1', []).hidden).toBe(false);
  });

  it('is judged by the gate for everyone else, and never counts as theirs', () => {
    expect(toChatView(answer(), OPEN_GATE_CTX(false), 'friend1', []).hidden).toBe(true);
    const open = toChatView(answer(), OPEN_GATE_CTX(true), 'friend1', []);
    expect(open).toMatchObject({ hidden: false, mine: false, author: { displayName: 'Cal', agent: 'cal' } });
    expect(toChatView(answer(), OPEN_GATE_CTX(true), 'asker1', []).mine).toBe(false);
  });

  it('asks the gate whether the place is the asker’s: the place belongs to them, not to the agent', () => {
    let owner: string | undefined;
    const ctx: ChatGateContext = { ...OPEN_GATE_CTX(true), gate: { isOpen: (place: { user_id: string }) => ((owner = place.user_id), true) } as unknown as Gate };
    toChatView(answer(), ctx, 'friend1', []);
    expect(owner).toBe('asker1');
  });
});
