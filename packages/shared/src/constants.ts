/** The reaction set from the v1 design: spoiler-free sentiment markers. */
export const REACTIONS = ['😱', '😢', '😡', '😂', '❤️', '🤯'] as const;
export type Reaction = (typeof REACTIONS)[number];

export const REACTION_LABELS: Record<Reaction, string> = {
  '😱': 'Shocked',
  '😢': 'Sad',
  '😡': 'Angry',
  '😂': 'Laughing',
  '❤️': 'Love',
  '🤯': 'Mind blown',
};

/**
 * Member colours from the v1 progress design (high contrast on dark backgrounds). In a club each
 * member holds a slot taken when they joined (so friends never share a colour); `memberColor`
 * is the fallback for someone with no slot, such as the author of a note who has since left.
 */
export const MEMBER_PALETTE = [
  // v1's eight colours, in an order where the first friends of a club are far apart: red, teal,
  // yellow and plum for four friends, orange for a fifth; the blue (beside teal as a dot on the
  // bar) and the two greens come after.
  '#FF6B6B',
  '#4ECDC4',
  '#FFEAA7',
  '#DDA0DD',
  '#FF8C42',
  '#45B7D1',
  '#96CEB4',
  '#98D8C8',
] as const;

/** v1's string hash (Java-style), kept so a member keeps the colour v1 would have given them. */
export function hashCode(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

export function memberColor(userId: string): string {
  return MEMBER_PALETTE[hashCode(userId) % MEMBER_PALETTE.length]!;
}

/** The colour of a club member's palette slot. */
export function slotColor(slot: number): string {
  return MEMBER_PALETTE[((slot % MEMBER_PALETTE.length) + MEMBER_PALETTE.length) % MEMBER_PALETTE.length]!;
}

export const LIMITS = {
  commentText: 2000,
  quote: 600,
  displayName: 60,
  clubName: 100,
  clubDescription: 500,
  bookTitle: 300,
  bookAuthor: 200,
  passwordMin: 10,
  passwordMax: 200,
  readSpansPerUpdate: 64,
  /** Words in one audiobook's transcript: War and Peace has about 560,000. */
  transcriptWords: 3_000_000,
  tracksPerEdition: 400,
  maxUploadBytes: 4 * 1024 ** 3,
  /** A voice note: at most five minutes, and the bytes a phone's recorder makes in that time (D141). */
  voiceNoteSeconds: 300,
  voiceNoteBytes: 30 * 1024 ** 2,
  /** A video note: at most two minutes (D141). */
  videoNoteSeconds: 120,
  videoNoteBytes: 80 * 1024 ** 2,
  /** A photo note: one picture at most this large, before it is resized (D141). */
  photoNoteBytes: 25 * 1024 ** 2,
  /** A note or reply carries one voice recording, or a short video, or this many photos (D140). */
  photosPerNote: 4,
  /** A voice note's transcript: a five-minute note holds nowhere near this many words. */
  noteTranscriptWords: 4000,
} as const;

export const SKIP_BACK_SECONDS = 15;
export const SKIP_FORWARD_SECONDS = 30;
