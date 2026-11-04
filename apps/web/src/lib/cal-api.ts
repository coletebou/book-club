import { EXPECTED_USER_HEADER, getPageUser } from './api';

/** Cal's own content parts, mirroring apps/server/src/cal/types.ts (CalContentPart). */
export type CalContentPart =
  | { type: 'text'; text: string }
  | { type: 'citation'; chunkId: string; bookId: string; bookTitle: string; chapterTitle: string | null; t: number; quote: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; name: string; summary: string };

export interface CalMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: CalContentPart[];
  readonly wholeSeries: boolean;
  readonly createdAt: string;
}

/** A thread with Cal (D183): titled by its first question; `bookTitle` is the book it was begun from, while that book is still there. */
export interface CalConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly bookId: string | null;
  readonly bookTitle?: string | null;
  readonly shared: boolean;
  readonly createdAt?: string;
  readonly updatedAt: string;
}

export interface CalConversationDetail extends CalConversationSummary {
  readonly messages: CalMessage[];
}

export interface CalShelfItem {
  readonly id: string;
  readonly kind: 'pdf' | 'epub' | 'txt' | 'md' | 'url';
  readonly title: string;
  readonly sourceUrl: string | null;
  readonly status: 'pending' | 'processing' | 'ready' | 'failed';
  readonly error: string | null;
  readonly createdAt: string;
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const user = getPageUser();
  if (method !== 'GET' && user) headers[EXPECTED_USER_HEADER] = user;
  const res = await fetch(url, { method, credentials: 'same-origin', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as { error?: { message?: string } } | null)?.error;
    throw new Error(err?.message ?? `Cal request failed (${res.status}).`);
  }
  return data as T;
}

export const calApi = {
  status: (clubId: string) => json<{ enabled: boolean; webSearch: boolean }>('GET', `/api/clubs/${clubId}/cal/status`),
  settings: () => json<{ wholeSeries: boolean }>('GET', '/api/cal/settings'),
  setWholeSeries: (wholeSeries: boolean) => json<{ wholeSeries: boolean }>('PUT', '/api/cal/settings', { wholeSeries }),
  conversations: (clubId: string) => json<CalConversationSummary[]>('GET', `/api/clubs/${clubId}/cal/conversations`),
  createConversation: (clubId: string, body: { bookId?: string | null; title?: string }) =>
    json<CalConversationSummary>('POST', `/api/clubs/${clubId}/cal/conversations`, body),
  conversation: (id: string) => json<CalConversationDetail>('GET', `/api/cal/conversations/${id}`),
  deleteConversation: (id: string) => json<void>('DELETE', `/api/cal/conversations/${id}`),
  shelf: (clubId: string) => json<CalShelfItem[]>('GET', `/api/clubs/${clubId}/cal/shelf`),
  addShelfUrl: (clubId: string, url: string, title?: string) =>
    json<CalShelfItem>('POST', `/api/clubs/${clubId}/cal/shelf/url`, { url, title }),
  uploadShelfFile: (clubId: string, file: File, kind: Extract<CalShelfItem['kind'], 'pdf' | 'epub' | 'txt' | 'md'>) => uploadShelfFile(clubId, file, kind),
  deleteShelfItem: (id: string) => json<void>('DELETE', `/api/cal/shelf/${id}`),
};

/**
 * A shelf file (pdf, epub, txt or md), as raw bytes in the body (apps/server/src/routes/cal.ts's
 * upload route, no multipart): small documents, well under its 20 MB cap, so one plain fetch is
 * enough — no resumable chunking, as the book uploader (apps/web/src/upload) needs for a long
 * audiobook.
 */
async function uploadShelfFile(clubId: string, file: File, kind: 'pdf' | 'epub' | 'txt' | 'md'): Promise<CalShelfItem> {
  const user = getPageUser();
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': file.type || 'application/octet-stream' };
  if (user) headers[EXPECTED_USER_HEADER] = user;
  const qs = new URLSearchParams({ kind, title: file.name });
  const res = await fetch(`/api/clubs/${clubId}/cal/shelf/upload?${qs.toString()}`, { method: 'POST', credentials: 'same-origin', headers, body: file });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as { error?: { message?: string } } | null)?.error;
    throw new Error(err?.message ?? `Cal could not take that file (${res.status}).`);
  }
  return data as CalShelfItem;
}

export interface StreamHandlers {
  readonly onDelta?: (text: string) => void;
  readonly onDone?: (message: CalMessage) => void;
  readonly onError?: (message: string) => void;
}

/**
 * Send a message and stream Cal's reply (server-sent events over a plain fetch body, not
 * EventSource: the message is a POST body, and EventSource only does GET). Each line pair
 * `event: X\ndata: Y\n\n` is parsed by hand.
 */
export async function streamCalMessage(conversationId: string, text: string, handlers: StreamHandlers): Promise<void> {
  const user = getPageUser();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (user) headers[EXPECTED_USER_HEADER] = user;
  const res = await fetch(`/api/cal/conversations/${conversationId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    // No spoiler scope here (D183): the server uses the asker's standing setting for every turn.
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    let message = `Cal could not answer (${res.status}).`;
    try {
      message = (JSON.parse(errText) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // not JSON
    }
    handlers.onError?.(message);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice('event: '.length);
      const data = JSON.parse(dataLine.slice('data: '.length)) as unknown;
      if (event === 'delta') handlers.onDelta?.((data as { text: string }).text);
      else if (event === 'done') handlers.onDone?.(data as CalMessage);
      else if (event === 'error') handlers.onError?.((data as { message: string }).message);
    }
  }
}
