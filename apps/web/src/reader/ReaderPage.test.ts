import type { Edition } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { pickEdition } from './ReaderPage';

function edition(id: string, kind: Edition['kind'], status: Edition['status'] = 'ready'): Edition {
  return {
    id,
    kind,
    status,
    error: status === 'failed' ? 'The file could not be read.' : null,
    createdAt: '2026-10-20T10:00:00.000Z',
    addedBy: 'user_ana',
    sizeBytes: 1000,
    geometry: null,
    sync: null,
    alignment: { method: 'none', unitToChapter: [] },
    units: [],
    publicationUrl: null,
    fileUrl: null,
    tracks: [],
    durationMs: null,
    pageCount: null,
    readAlong: null,
  };
}

const pdf = edition('ed_pdf', 'pdf');
const epub = edition('ed_epub', 'epub');
const audio = edition('ed_audio', 'audio');
const pdf2 = edition('ed_pdf_2', 'pdf');
const all = [pdf, audio, epub, pdf2];

describe('pickEdition', () => {
  it('opens the edition the address asks for', () => {
    expect(pickEdition(all, 'ed_pdf_2', 'ed_pdf')).toBe(pdf2);
  });

  it('otherwise opens the edition I read last', () => {
    expect(pickEdition(all, null, 'ed_pdf_2')).toBe(pdf2);
    expect(pickEdition(all, 'ed_no_such_edition', 'ed_pdf_2')).toBe(pdf2);
  });

  it('otherwise prefers the EPUB to a PDF', () => {
    expect(pickEdition(all, null, null)).toBe(epub);
    expect(pickEdition(all, null, undefined)).toBe(epub);
  });

  it('otherwise opens the first readable edition', () => {
    expect(pickEdition([audio, pdf2, pdf], null, null)).toBe(pdf2);
  });

  it('never opens an audiobook in the reader, even when asked for or listened to last', () => {
    expect(pickEdition(all, 'ed_audio', null)).toBe(epub);
    expect(pickEdition(all, null, 'ed_audio')).toBe(epub);
    expect(pickEdition([audio], 'ed_audio', 'ed_audio')).toBeUndefined();
  });

  it('skips editions still being processed or that failed', () => {
    const processing = edition('ed_epub_new', 'epub', 'processing');
    const failed = edition('ed_epub_bad', 'epub', 'failed');
    expect(pickEdition([processing, failed, pdf], 'ed_epub_new', 'ed_epub_bad')).toBe(pdf);
    expect(pickEdition([processing, failed], null, null)).toBeUndefined();
  });

  it('has nothing to open in a book without editions', () => {
    expect(pickEdition([], 'ed_pdf', 'ed_pdf')).toBeUndefined();
  });
});
