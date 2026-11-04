import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { CommentView, Locator } from '@bookclub/shared';
import { api } from './api';

/** The page in front of you, as the server is asked about it: an EPUB section's characters, or a PDF's page. */
export type PageSpan = { readonly section: number; readonly from: number; readonly to: number } | { readonly page: number };

/**
 * Where on the page in front of you the closed notes it holds are, for the notes the list gives
 * only roughly (D80): a note at a place you have not read is told exactly only for the page you
 * look at, which is marked on its line as on any page (D72). Asked once per page, and only while
 * there is a roughly placed note at all.
 */
export function usePlacesOnPage(bookId: string, editionId: string, span: PageSpan | null, notes: readonly CommentView[]): ReadonlyMap<string, { t: number; locator: Locator }> {
  const rough = useMemo(
    () =>
      notes
        .filter((c) => c.hidden && c.approx)
        .map((c) => c.id)
        .sort()
        .join(','),
    [notes],
  );
  const key = span ? ('page' in span ? `p${span.page}` : `s${span.section}:${span.from}-${span.to}`) : '';
  const query = useQuery({
    queryKey: ['places', bookId, editionId, key, rough],
    queryFn: () => api.places(bookId, { edition: editionId, ...span! }),
    enabled: span !== null && rough !== '',
    staleTime: 30_000,
  });
  return useMemo(() => new Map((query.data?.places ?? []).map((p) => [p.id, { t: p.t, locator: p.locator }])), [query.data]);
}
