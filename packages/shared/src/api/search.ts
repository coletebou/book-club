import { z } from 'zod';

export const ClubSearchBodySchema = z.object({ query: z.string().trim().min(2).max(120) });

export interface ClubSearchResult {
  readonly kind: 'book' | 'chapter' | 'note' | 'chat';
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
}

export interface ClubSearchResponse {
  readonly results: readonly ClubSearchResult[];
}
