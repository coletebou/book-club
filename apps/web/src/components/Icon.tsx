const PATHS = {
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  toc: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  type: 'M4 7V5h16v2M9 19h6M12 5v14',
  comment: 'M5 5h14a2 2 0 012 2v8a2 2 0 01-2 2h-7l-5 4v-4H5a2 2 0 01-2-2V7a2 2 0 012-2z',
  play: 'M8 5l11 7-11 7z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  prev: 'M7 5v14M18 6l-9 6 9 6z',
  next: 'M17 5v14M6 6l9 6-9 6z',
  back15: 'M4 12a8 8 0 108-8H8m0 0l3-3M8 4l3 3',
  fwd30: 'M20 12a8 8 0 11-8-8h4m0 0l-3-3m3 3l-3 3',
  upload: 'M12 16V4m0 0l-5 5m5-5l5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3',
  link: 'M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1',
  check: 'M5 12l5 5 9-10',
  lock: 'M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z',
  download: 'M12 4v12m0 0l-5-5m5 5l5-5M4 20h16',
  offline: 'M3 3l18 18M8.5 8.5A8 8 0 003 12M12 7a8 8 0 018.5 4.5M6 15a6 6 0 016-2M12 19h.01',
  trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L18 10l-4-4L4 16v4zM13 7l4 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  book: 'M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2zM4 5v16M8 7h7',
  headphones: 'M4 15v-3a8 8 0 0116 0v3M4 15a2 2 0 012-2h1v7H6a2 2 0 01-2-2zM20 15a2 2 0 00-2-2h-1v7h1a2 2 0 002-2z',
  // Reading along (D194): an open book under the headphones' band.
  along: 'M5 11V9a7 7 0 0114 0v2M3 13h3v5H3zM18 13h3v5h-3zM8 21c1.3-.8 2.6-1 4-1s2.7.2 4 1M12 20v-6M8 15c1.3-.8 2.6-1 4-1s2.7.2 4 1',
  expand: 'M6 15l6-6 6 6',
  collapse: 'M6 9l6 6 6-6',
  page: 'M7 3h7l5 5v13H7zM14 3v5h5',
  users: 'M9 11a4 4 0 100-8 4 4 0 000 8zM17 11a3 3 0 100-6M3 21v-1a6 6 0 0112 0v1M17 14a5 5 0 014 5v2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  timer: 'M12 8v5l3 2M9 2h6M12 22a9 9 0 100-18 9 9 0 000 18z',
  plus: 'M12 5v14M5 12h14',
  bookmark: 'M7 4h10v16l-5-4-5 4z',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-6.36 2.64L3 8M3 3v5h5M12 7v5l3 2',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  flag: 'M6 21V4M6 4h11l-2.5 4 2.5 4H6',
  share: 'M12 15V3m0 0L8 7m4-4l4 4M8 10H6v11h12V10h-2',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3zM19 11a7 7 0 01-14 0M12 18v3',
  send: 'M4 12l16-8-6 16-3-7-7-1z',
  reply: 'M9 14l-5-5 5-5M4 9h11a5 5 0 015 5v5',
  camera: 'M4 8h3l1.5-2h7L17 8h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1zM12 17a4 4 0 100-8 4 4 0 000 8z',
  video: 'M4 6h12v12H4zM16 10l4-2v8l-4-2z',
  stop: 'M6 6h12v12H6z',
  redo: 'M4 12a8 8 0 1014.4-4.8M19 4v5h-5',
  'mic-off': 'M9 6a3 3 0 016 0v5c0 .34-.04.67-.12.98M12 14a3 3 0 01-3-3v-1M6 11a6 6 0 006.5 6M12 19v3M3 3l18 18',
  volume: 'M4 9v6h4l5 5V4L8 9z',
  'volume-off': 'M4 9v6h4l5 5V4L8 9z M16 9l6 6M22 9l-6 6',
  // A note's own mark (D173): the reader header used the chat-bubble for "leave a note" before
  // club chat had a page of its own to mean, which now reads as "open chat" everywhere else — a
  // quill, not a bubble, says "write something here" without colliding with that.
  quill: 'M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5zM16 8L2 22M17.5 15H9',
  // Cal's threads (D183): a clock turning back for "your earlier chats" (`history`), and a pencil on a page
  // for "a new chat" — `plus` alone already means "add" (a book, a club) elsewhere in the app.
  compose: 'M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M17.5 3.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z',
} as const;

export type IconName = keyof typeof PATHS;

const FILLED: ReadonlySet<IconName> = new Set(['play', 'pause', 'prev', 'next', 'stop']);

export function Icon({ name, size = 22, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={FILLED.has(name) ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={PATHS[name]} fill={FILLED.has(name) ? 'currentColor' : 'none'} />
    </svg>
  );
}
