import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { HiddenComment, NoteMediaView, RevealedComment } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { isNoteSafetyTarget } from '../components/MemberSafetyActions';
import { updateNoteRetention } from '../components/note-sheet-retention';
import { keys } from '../lib/queries';
import { noteSheetHasTabStop } from './note-sheet-tab-stops';
import { MarkerSheet } from './panels';

const visible: RevealedComment = {
  id: 'note_test', bookId: 'book_test', userId: 'user_friend', authorName: 'Friend', color: '#485072',
  t: 0.3, editionId: 'edition_test', kind: 'epub', locator: { kind: 'epub', section: 0, offset: 1 },
  reaction: null, createdAt: '2026-01-01T00:00:00Z', hidden: false,
  endLocator: null, endT: null, quote: null, text: 'A note',
};
const hidden: HiddenComment = {
  id: visible.id, bookId: visible.bookId, userId: visible.userId, authorName: visible.authorName, color: visible.color,
  t: visible.t, editionId: visible.editionId, kind: visible.kind, locator: visible.locator,
  reaction: null, createdAt: visible.createdAt, hidden: true, hasText: true,
};
const deleted = { ...visible, deleted: true, text: null };
const voice: NoteMediaView = {
  id: 'voice_note', kind: 'voice', status: 'failed', mime: null, url: null,
  durationMs: null, width: null, height: null, transcript: 'A transcript', transcriptStatus: 'ready',
};
const context = { selfId: 'user_self', hasClub: false, canModerate: false, readHere: false, read: undefined };

describe('note sheet tab stops', () => {
  it('includes the Reply control on an open note and skips a deleted note without interactive replies', () => {
    expect(noteSheetHasTabStop(visible, [], context)).toBe(true);
    expect(noteSheetHasTabStop(deleted, [], context)).toBe(false);
  });

  it('includes read-here controls for eligible notes, and safety controls on held notes', () => {
    const held = { ...hidden, horizon: 'Chapter 9' };
    expect(noteSheetHasTabStop(hidden, [], context)).toBe(false);
    expect(noteSheetHasTabStop(hidden, [], { ...context, readHere: true })).toBe(true);
    expect(noteSheetHasTabStop(held, [], { ...context, readHere: true })).toBe(false);
    expect(noteSheetHasTabStop({ ...hidden, hasText: false, reaction: '❤️' }, [], { ...context, readHere: true })).toBe(false);
    expect(noteSheetHasTabStop(held, [], { ...context, hasClub: true })).toBe(true);
    expect(noteSheetHasTabStop(held, [], { ...context, hasClub: true, selfId: undefined })).toBe(false);
  });

  it('includes rows where you can delete a reply or use its safety controls', () => {
    expect(noteSheetHasTabStop(deleted, [hidden], context)).toBe(false);
    expect(noteSheetHasTabStop(deleted, [{ ...hidden, userId: context.selfId }], context)).toBe(true);
    expect(noteSheetHasTabStop(deleted, [hidden], { ...context, canModerate: true })).toBe(true);
    expect(noteSheetHasTabStop(deleted, [hidden], { ...context, hasClub: true })).toBe(true);
  });

  it('counts a visible media player or transcript toggle and skips a held media marker', () => {
    expect(noteSheetHasTabStop(deleted, [{ ...hidden, media: [{ kind: 'voice' }] }], context)).toBe(false);
    expect(noteSheetHasTabStop(deleted, [{ ...visible, media: [voice] }], context)).toBe(true);
    expect(noteSheetHasTabStop(deleted, [{ ...visible, media: [{ ...voice, transcript: null, transcriptStatus: 'queued' }] }], context)).toBe(false);
    expect(noteSheetHasTabStop(deleted, [{ ...visible, media: [{ ...voice, status: 'ready', url: '/voice', transcript: null }] }], context)).toBe(true);
  });

  it('agrees with the controls rendered on open, held, and deleted rows', () => {
    const held = { ...hidden, id: 'note_held', horizon: 'Chapter 9' };
    const withReply = { ...deleted, id: 'note_with_reply' };
    const reply = { ...visible, id: 'reply_test', parentId: withReply.id, media: [voice] };
    const notes = [visible, held, { ...deleted, id: 'note_deleted' }, withReply];
    const replies = new Map([[withReply.id, [reply]]]);
    const client = new QueryClient();
    client.setQueryData(keys.book(visible.bookId), { clubId: 'club_test' });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <MarkerSheet comments={notes} replies={replies} chapters={[]} selfId={context.selfId} onClose={() => {}} />
      </QueryClientProvider>,
    );
    try {
      const controls = 'button:not(:disabled), a[href], audio[controls], video[controls], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex^="-"])';
      const mounted = screen.getAllByTestId('sheet-note');
      expect(mounted).toHaveLength(notes.length);
      for (const [index, note] of notes.entries()) {
        expect(mounted[index]!.getAttribute('data-note-id')).toBe(note.id);
        expect(noteSheetHasTabStop(note, replies.get(note.id) ?? [], { ...context, hasClub: true }))
          .toBe(!!mounted[index]!.querySelector(controls));
      }
    } finally {
      unmount();
      client.clear();
    }
  });
});

describe('note safety targets', () => {
  it('targets another member’s open or held note and excludes self, signed-out readers and deleted notes', () => {
    expect(isNoteSafetyTarget(visible, context.selfId)).toBe(true);
    expect(isNoteSafetyTarget(hidden, context.selfId)).toBe(true);
    expect(isNoteSafetyTarget(visible, visible.userId)).toBe(false);
    expect(isNoteSafetyTarget(visible, undefined)).toBe(false);
    expect(isNoteSafetyTarget(deleted, context.selfId)).toBe(false);
  });
});

describe('note sheet retention counts', () => {
  it('keeps a row through independent draft and media interactions and releases it after both', () => {
    const empty = new Map<string, number>();
    const drafting = updateNoteRetention(empty, 'draft-note', true);
    const playing = updateNoteRetention(drafting, 'draft-note', true);
    const bothRows = updateNoteRetention(playing, 'other-note', true);
    expect(empty.size).toBe(0);
    expect(drafting.get('draft-note')).toBe(1);
    expect(bothRows.get('draft-note')).toBe(2);
    const oneReason = updateNoteRetention(bothRows, 'draft-note', false);
    expect(oneReason.get('draft-note')).toBe(1);
    const released = updateNoteRetention(oneReason, 'draft-note', false);
    expect([...released]).toEqual([['other-note', 1]]);
    expect(updateNoteRetention(released, 'draft-note', false)).toBe(released);
  });
});
