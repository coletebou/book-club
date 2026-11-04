/** Parse a JSON column; columns are written by us, so a parse failure is a bug worth surfacing. */
export function fromJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  return JSON.parse(text) as T;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export function isoRequired(ms: number): string {
  return new Date(ms).toISOString();
}
