import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markArrival, noteLinkFrom, noteLinkTarget } from './note-link';

describe('a link to a note', () => {
  it('is #note-<id>, and for an answer under it, which answer in its state', () => {
    expect(noteLinkFrom('#note-Ab_9-xyz', null)).toEqual({ noteId: 'Ab_9-xyz', commentId: 'Ab_9-xyz' });
    expect(noteLinkFrom('#note-note1', { comment: 'reply1' })).toEqual({ noteId: 'note1', commentId: 'reply1' });
    // Any other state is no answer: the note itself.
    expect(noteLinkFrom('#note-note1', { comment: 7 })).toEqual({ noteId: 'note1', commentId: 'note1' });
    expect(noteLinkFrom('#note-note1', 'reply1')).toEqual({ noteId: 'note1', commentId: 'note1' });
  });

  it('is nothing else: another anchor, no id, or what no id is (it never reaches a selector)', () => {
    expect(noteLinkFrom('', null)).toBeNull();
    expect(noteLinkFrom('#main', null)).toBeNull();
    expect(noteLinkFrom('#note-', null)).toBeNull();
    expect(noteLinkFrom('#note-a"]b', null)).toBeNull();
    expect(noteLinkFrom('#note-note1', { comment: 'x"], *' })).toEqual({ noteId: 'note1', commentId: 'note1' });
  });
});

describe('where a link takes you on the book page', () => {
  // jsdom lays nothing out, and has no scrollIntoView: each test that needs it gives its own.
  const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  beforeEach(() => {
    document.body.innerHTML = `
      <ol>
        <li id="note-note1" data-comment="note1">Down the rabbit hole
          <ol><li data-comment="reply1">The marmalade jar!</li><li data-comment="reply2">Falling for ages</li></ol>
        </li>
        <li id="note-note2" data-comment="note2">Curiouser</li>
      </ol>`;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    if (scrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoView);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('is the answer in its note’s conversation, else the note', () => {
    expect(noteLinkTarget({ noteId: 'note1', commentId: 'note1' })?.textContent).toContain('Down the rabbit hole');
    expect(noteLinkTarget({ noteId: 'note1', commentId: 'reply2' })?.textContent).toBe('Falling for ages');
    // An answer gone (deleted since), or one under another note: the note.
    expect(noteLinkTarget({ noteId: 'note1', commentId: 'reply9' })?.id).toBe('note-note1');
    expect(noteLinkTarget({ noteId: 'note2', commentId: 'reply1' })?.id).toBe('note-note2');
    // Not on the page (yet): nothing.
    expect(noteLinkTarget({ noteId: 'note3', commentId: 'note3' })).toBeNull();
  });

  it('is brought into view, marked and focused; the mark goes with the focus', () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const reply = noteLinkTarget({ noteId: 'note1', commentId: 'reply1' })!;
    markArrival(reply);
    expect(scrolled).toHaveBeenCalledWith({ block: 'center' });
    expect(scrolled.mock.contexts[0]).toBe(reply);
    expect(reply.dataset.arrived).toBe('true');
    expect(reply.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(reply);
    // Out of the Tab order: focused for a screen reader, not one more stop for the keyboard.
    expect(reply.getAttribute('tabindex')).toBe('-1');
    reply.blur();
    expect(reply.dataset.arrived).toBeUndefined();
  });

  it('keeps a place in the Tab order something already had', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const note = noteLinkTarget({ noteId: 'note2', commentId: 'note2' })!;
    note.tabIndex = 0;
    markArrival(note);
    expect(note.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(note);
  });
});
