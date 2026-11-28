/** D263: device-local text belongs to one signed-in member and one composer destination. */
export function draftStorageKey(
  kind: 'chat' | 'cal-thread' | 'cal-new',
  userId: string | undefined,
  clubId: string,
  ...destination: (string | null)[]
): string | undefined {
  if (!userId) return undefined;
  return `bookclub:draft:${JSON.stringify([kind, userId, clubId, ...destination])}`;
}

export function readStoredDraft(key: string | undefined): string {
  if (!key) return '';
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function writeStoredDraft(key: string | undefined, text: string): void {
  if (!key) return;
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // The composer still works when browser storage is unavailable.
  }
}
