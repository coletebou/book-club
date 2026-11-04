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
    text: 'a spoiler-fenced message',
    spoiler_t: 42,
    spoiler_edition_id: 'edition1',
    client_id: null,
    created_at: Date.now(),
    edited_at: null,
    deleted_at: null,
    author_name: 'Author',
    author_color: null,
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
