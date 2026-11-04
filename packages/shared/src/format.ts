/** Display helpers shared by the server (labels) and the client. */

/** 3725000 → "1:02:05", 65000 → "1:05". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Timeline position as a whole percentage, never showing 100 % before the very end. Rounded down,
 * but not below what a place carried from one format's map to another's is a hair short of (it
 * lands on a whole character): a PDF place at 8 % opened in the EPUB is 0.079999, 8 % too.
 */
export function formatPercent(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '0%';
  if (t >= 1) return '100%';
  return `${Math.min(99, Math.floor(t * 100 + 0.005))}%`;
}

/** "Ana", "Ana and Ben", "Ana, Ben and 2 others". */
export function formatNames(names: readonly string[], max = 2): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/**
 * When something happened, the way a friend would say it: "just now", "5 min ago", "3 h ago",
 * "yesterday", "4 days ago", then the date ("12 Mar", with the year once it is another year).
 */
export function formatWhen(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
