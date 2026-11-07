import { describe, expect, it } from 'vitest';
import { imageFilesFrom } from './attachments';
import { canSend, createComposerStore, readyAttachmentIds } from './composer';
import { mentionDirectory } from './mentions';

const file = (name: string, type: string) => ({ name, type });

describe('imageFilesFrom', () => {
  it('takes the pictures from a paste’s items, leaving text and other files out', () => {
    const png = file('screenshot.png', 'image/png');
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => png },
      { kind: 'file', type: 'application/pdf', getAsFile: () => file('doc.pdf', 'application/pdf') },
    ];
    expect(imageFilesFrom({ items })).toEqual([png]);
  });

  it('falls back to the files of a drop, and to nothing at all', () => {
    const jpg = file('a.jpg', 'image/jpeg');
    expect(imageFilesFrom({ files: [jpg, file('b.txt', 'text/plain')], items: [] })).toEqual([jpg]);
    expect(imageFilesFrom({ items: [{ kind: 'file', type: 'image/gif', getAsFile: () => null }], files: [] })).toEqual([]);
    expect(imageFilesFrom(null)).toEqual([]);
    expect(imageFilesFrom({})).toEqual([]);
  });
});

describe('the composer’s pictures', () => {
  const composer = () => createComposerStore<never>({ directory: () => mentionDirectory([]) });

  it('keeps pick order however the uploads finish, and sends only what came through', () => {
    const store = composer();
    const [a, b, c] = store.addAttachments([{ name: 'a.jpg' }, { name: 'b.jpg', preview: 'blob:b' }, { name: 'c.jpg' }]);
    expect(store.getState().attachments.map((x) => [x.name, x.status, x.preview])).toEqual([
      ['a.jpg', 'uploading', null],
      ['b.jpg', 'uploading', 'blob:b'],
      ['c.jpg', 'uploading', null],
    ]);
    expect(canSend(store.getState())).toBe(false);
    store.attachmentReady(c!, 'id-c');
    store.attachmentFailed(b!, 'That is not a picture we can read.');
    store.attachmentReady(a!, 'id-a');
    expect(readyAttachmentIds(store.getState())).toEqual(['id-a', 'id-c']);
    expect(canSend(store.getState())).toBe(true);
    expect(store.getState().attachments[1]).toMatchObject({ status: 'failed', error: 'That is not a picture we can read.' });
  });

  it('adds no more than the limit allows, and takes a picture out', () => {
    const store = composer();
    expect(store.addAttachments([{ name: '1' }, { name: '2' }, { name: '3' }], 2)).toHaveLength(2);
    expect(store.addAttachments([{ name: '4' }], 2)).toEqual([]);
    const key = store.getState().attachments[0]!.key;
    expect(store.removeAttachment(key)).toMatchObject({ name: '1' });
    expect(store.removeAttachment(key)).toBeNull();
    expect(store.getState().attachments.map((x) => x.name)).toEqual(['2']);
    // Reports for a picture taken out change nothing.
    const before = store.getState();
    store.attachmentReady(key, 'late');
    expect(store.getState()).toBe(before);
  });

  it('can send words alone, and clears pictures with the rest after a send', () => {
    const store = composer();
    store.input('hello', 5);
    expect(canSend(store.getState())).toBe(true);
    store.addAttachments([{ name: 'a.jpg' }]);
    expect(canSend(store.getState())).toBe(false);
    store.clear();
    expect(store.getState().attachments).toEqual([]);
  });
});
