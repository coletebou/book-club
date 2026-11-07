import { z } from 'zod';
import { isRateStep } from '../audio/rate';
import { LIMITS, REACTIONS } from '../constants';
import { MAX_EDITION_UNITS } from '../timeline/align';
import { LocatorSchema } from '../timeline/locator-schemas';
import { isCalendarDay } from '../timeline/meeting';
import { isTimeZone } from '../timeline/meetup';

/* ------------------------------------------------------------------------------------------ */
/* Primitives                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, { error: 'Invalid id' });
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address' }));
export const PasswordSchema = z
  .string()
  .min(LIMITS.passwordMin, { error: `Use at least ${LIMITS.passwordMin} characters` })
  .max(LIMITS.passwordMax);
export const DisplayNameSchema = z.string().trim().min(1, { error: 'Enter your name' }).max(LIMITS.displayName);
export const ReactionSchema = z.enum(REACTIONS);
export const EditionKindSchema = z.enum(['epub', 'pdf', 'audio']);
/** What a note or reply may carry besides text (D140): one voice recording, a short video, or 1-4 photos. */
export const NoteMediaKindSchema = z.enum(['voice', 'photo', 'video']);
export type NoteMediaKind = z.infer<typeof NoteMediaKindSchema>;
export const NoteMediaStatusSchema = z.enum(['processing', 'ready', 'failed']);
export const NoteTranscriptStatusSchema = z.enum(['none', 'queued', 'ready', 'failed']);
export const TimelineValueSchema = z.number().min(0).max(1);
export const IsoDateSchema = z.string();

export const TiePointSchema = z.object({ m: z.number(), t: TimelineValueSchema });
export const SyncMapSchema = z.object({ points: z.array(TiePointSchema).min(2) });

export const EditionGeometrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('epub'), sectionLengths: z.array(z.int().nonnegative()) }),
  z.object({ kind: z.literal('pdf'), pageCount: z.int().nonnegative() }),
  z.object({ kind: z.literal('audio'), trackDurationsMs: z.array(z.number().nonnegative()) }),
]);

/* ------------------------------------------------------------------------------------------ */
/* Users and sessions                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * How someone signs in: a local password, the upstream's sign-in grant (D116), or a native "Sign in
 * with Apple"/"Continue with Google" identity (D178) — each of the last three is passwordless
 * here, so the UI treats them alike wherever that is what matters (no password to reset, no
 * "change password" section) and differently where it is not (whose name an account's display
 * name is allowed to follow: only the upstream's, never Apple's or Google's one-time name).
 */
export const UserSourceSchema = z.enum(['local', 'upstream', 'apple', 'google']);

export const UserSchema = z.object({
  id: IdSchema,
  displayName: z.string(),
  email: z.string().nullable(),
  color: z.string(),
  source: UserSourceSchema,
});
export type User = z.infer<typeof UserSchema>;

export const SessionInfoSchema = z.object({
  user: UserSchema.nullable(),
  setupRequired: z.boolean(),
  /**
   * An upstream account people can continue with (D14, D52), by the name they know it by.
   * `password`: whether its password can be typed straight into this app's own form (D173) —
   * false when the upstream offers only its own sign-in page ("Continue with" it).
   */
  upstream: z.object({ name: z.string(), password: z.boolean() }).nullable(),
  /**
   * Native "Sign in with Apple" and "Continue with Google" (D178): each is only ever true once
   * its own server-side configuration is complete, so a button for a provider nobody has set up
   * never appears (apps/server/src/config.ts's all-or-none groups for each). Optional (rather
   * than required, as the server always sends it) so that the many `SessionInfo` fixtures this
   * change did not touch (every test unrelated to sign-in that builds one by hand) keep compiling
   * and running unchanged; code that reads it treats a missing value as "off", same as `false`.
   */
  providers: z.object({ apple: z.boolean(), google: z.boolean() }).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SignInBodySchema = z.object({ email: EmailSchema, password: z.string().min(1).max(LIMITS.passwordMax) });
export const SignUpBodySchema = z.object({
  inviteCode: z.string().min(8).max(64),
  displayName: DisplayNameSchema,
  email: EmailSchema,
  password: PasswordSchema,
});
export const SetupBodySchema = z.object({
  displayName: DisplayNameSchema,
  email: EmailSchema,
  password: PasswordSchema,
  clubName: z.string().trim().min(1).max(LIMITS.clubName).optional(),
});
export const UpdateMeBodySchema = z.object({ displayName: DisplayNameSchema.optional() });
export const ChangePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(LIMITS.passwordMax),
  newPassword: PasswordSchema,
});
export const ResetPasswordBodySchema = z.object({ token: z.string().min(20).max(200), newPassword: PasswordSchema });
export const ResetLinkSchema = z.object({ url: z.string(), expiresAt: IsoDateSchema });

/** The digits of a one-time sign-in code (D87). */
export const SIGN_IN_CODE_DIGITS = 8;
/** A one-time code to sign in where you are not yet (D87): eight digits, written in two fours. */
export const SignInCodeSchema = z.object({ code: z.string().regex(/^\d{8}$/), expiresAt: IsoDateSchema });
export type SignInCode = z.infer<typeof SignInCodeSchema>;
/** A code as typed: its digits, with any spaces or dashes between them. */
export const SignInWithCodeBodySchema = z.object({
  code: z
    .string()
    .max(40)
    .transform((s) => s.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^\d{8}$/, 'A sign-in code is eight digits.')),
});

/**
 * Native "Sign in with Apple" (D178): the identity token `expo-apple-authentication` returned
 * in-process, the raw nonce the app generated before asking for it (Apple's token carries only
 * its SHA-256; the server recomputes that to check it), and the one-time `fullName` Apple hands
 * back on a person's very first authorization with this app (unsigned, so untrusted — bounded and
 * trimmed like any other display name on the way in).
 */
export const AppleSignInBodySchema = z.object({
  identityToken: z.string().min(1).max(4096),
  nonce: z.string().min(1).max(256),
  fullName: z.string().trim().min(1).max(200).optional(),
});

/**
 * The app redeems a native Google sign-in's one-time code from inside the WebView (D178), with
 * the PKCE verifier of the challenge it gave the server before opening the browser session: the
 * same code intercepted anywhere else is useless without it.
 */
export const AppCodeBodySchema = z.object({
  code: z.string().min(1).max(512),
  verifier: z.string().min(1).max(256),
});

/* ------------------------------------------------------------------------------------------ */
/* Clubs and invites                                                                           */
/* ------------------------------------------------------------------------------------------ */

export const RoleSchema = z.enum(['owner', 'member']);
export type Role = z.infer<typeof RoleSchema>;

export const MemberSchema = z.object({
  userId: IdSchema,
  displayName: z.string(),
  color: z.string(),
  role: RoleSchema,
  joinedAt: IsoDateSchema,
  /** How they sign in: anything but `local` has no password here (nothing to reset, D178). */
  source: UserSourceSchema,
});
export type Member = z.infer<typeof MemberSchema>;

export const ClubSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  role: RoleSchema,
  memberCount: z.int(),
  bookCount: z.int(),
});
export type ClubSummary = z.infer<typeof ClubSummarySchema>;

export const ClubDetailSchema = ClubSummarySchema.extend({
  members: z.array(MemberSchema),
  /** Any member may share it (D40); only owners renew it. */
  invite: z.object({ code: z.string(), url: z.string() }).nullable(),
  createdAt: IsoDateSchema,
});
export type ClubDetail = z.infer<typeof ClubDetailSchema>;

export const CreateClubBodySchema = z.object({
  name: z.string().trim().min(1, { error: 'Name your club' }).max(LIMITS.clubName),
  description: z.string().trim().max(LIMITS.clubDescription).optional(),
});
export const UpdateClubBodySchema = CreateClubBodySchema.partial();

export const InvitePreviewSchema = z.object({
  clubName: z.string(),
  inviterName: z.string(),
  memberCount: z.int(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Books and editions                                                                          */
/* ------------------------------------------------------------------------------------------ */

export const ChapterSchema = z.object({ index: z.int(), title: z.string(), t: TimelineValueSchema });
export type Chapter = z.infer<typeof ChapterSchema>;

export const EditionUnitSchema = z.object({ title: z.string(), m: z.number() });

export const TrackSchema = z.object({
  index: z.int(),
  title: z.string(),
  durationMs: z.number(),
  url: z.string(),
  mime: z.string(),
  /** Canonical chapter this track starts, if aligned. */
  chapter: z.int().nullable(),
  /**
   * The book's chapters its read-along hears start in this track, each where it starts in it, in
   * order (FR152): a track holding several chapters lists them, and names the one being heard.
   * Absent before a read-along, and in book details kept from before.
   */
  chapters: z.array(z.object({ chapter: z.int(), ms: z.number() })).optional(),
});
export type Track = z.infer<typeof TrackSchema>;

export const EditionStatusSchema = z.enum(['processing', 'ready', 'failed']);

/**
 * Live status of the server's recogniser on an audiobook (D79), while it is queued, running, or
 * has just failed. Absent (or null) once the audiobook reads along, or when no recogniser is
 * configured. Optional so fixtures that build an Edition by hand keep compiling.
 */
export const TranscriptionStageSchema = z.enum([
  'queued',
  'uploading',
  'transcribing_gpu',
  'transcribing_cpu',
  'aligning',
  'failed',
]);
export type TranscriptionStage = z.infer<typeof TranscriptionStageSchema>;

export const TranscriptionStatusSchema = z.object({
  stage: TranscriptionStageSchema,
  tracksDone: z.number().int().nonnegative().nullable(),
  tracksTotal: z.number().int().positive().nullable(),
  audioMsDone: z.number().nonnegative().nullable(),
  audioMsTotal: z.number().nonnegative().nullable(),
  /** 0..1 when audio or track counts are known; null before the first measurement. */
  fraction: z.number().min(0).max(1).nullable(),
  /** Estimated milliseconds left, from measured throughput or a GPU/CPU fallback. */
  etaMs: z.number().nonnegative().nullable(),
  /** Last error when failed, or a short note (e.g. falling back to CPU). */
  message: z.string().nullable(),
  updatedAt: IsoDateSchema.nullable(),
});
export type TranscriptionStatus = z.infer<typeof TranscriptionStatusSchema>;

export const EditionSchema = z.object({
  id: IdSchema,
  kind: EditionKindSchema,
  status: EditionStatusSchema,
  error: z.string().nullable(),
  createdAt: IsoDateSchema,
  addedBy: IdSchema,
  sizeBytes: z.number(),
  geometry: EditionGeometrySchema.nullable(),
  sync: SyncMapSchema.nullable(),
  alignment: z.object({
    /** `forced`: sentence by sentence, from a transcript (D46); the chapter match is kept beneath. */
    method: z.enum(['reference', 'count', 'number', 'title', 'manual', 'none', 'forced']),
    unitToChapter: z.array(z.int().nullable()),
  }),
  /** Audio: a transcript lined up with a text edition, sentence by sentence (read-along). */
  readAlong: z
    .object({
      textEditionId: IdSchema,
      sentences: z.int(),
      /** Share of the text's words that were heard and matched. */
      coverage: z.number(),
    })
    .nullable(),
  units: z.array(EditionUnitSchema),
  /** EPUB: URL of the publication manifest. */
  publicationUrl: z.string().nullable(),
  /** PDF: URL of the file. */
  fileUrl: z.string().nullable(),
  /** Audio: tracks in play order. */
  tracks: z.array(TrackSchema),
  durationMs: z.number().nullable(),
  pageCount: z.int().nullable(),
  /** Live transcription / alignment progress for an audiobook (optional; see TranscriptionStatusSchema). */
  transcription: TranscriptionStatusSchema.nullable().optional(),
});
export type Edition = z.infer<typeof EditionSchema>;

export const MemberProgressSchema = z.object({
  userId: IdSchema,
  displayName: z.string(),
  color: z.string(),
  t: TimelineValueSchema,
  furthest: TimelineValueSchema,
  coverage: z.number(),
  kind: EditionKindSchema.nullable(),
  label: z.string(),
  updatedAt: IsoDateSchema.nullable(),
  finished: z.boolean(),
});
export type MemberProgress = z.infer<typeof MemberProgressSchema>;

/** Where a meet-up is (D206): the club's own voice room, a place, or a link to a video call. */
export const MeetupPlaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('voice'), value: z.literal('').default('') }),
  z.object({ kind: z.literal('place'), value: z.string().trim().min(1, { error: 'Say where' }).max(200, { error: 'At most 200 characters' }) }),
  z.object({
    kind: z.literal('link'),
    value: z
      .string()
      .trim()
      .max(500, { error: 'At most 500 characters' })
      .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), { error: 'A web address, like https://meet.example/abc' }),
  }),
]);
export type MeetupPlace = z.infer<typeof MeetupPlaceSchema>;

export const RsvpAnswerSchema = z.enum(['yes', 'maybe', 'no']);

/** One friend's answer for the meet-up as it stands (D206). */
export const MeetupRsvpSchema = z.object({ userId: IdSchema, displayName: z.string(), answer: RsvpAnswerSchema });
export type MeetupRsvp = z.infer<typeof MeetupRsvpSchema>;

/**
 * Where the club will talk next (D53): a stop on the timeline, its name, and perhaps a day. As a
 * meet-up (D206) it may also have a time (`at`, an instant, set in `tz`), how long it runs, where it
 * is, and who is coming: the answers given for this day or time.
 */
export const MeetingSchema = z.object({
  t: TimelineValueSchema,
  label: z.string(),
  /** A calendar day, "2026-10-25", or null. With a time, the day it falls on where it was set. */
  on: z.string().nullable(),
  at: IsoDateSchema.nullable(),
  tz: z.string().nullable(),
  minutes: z.int().nullable(),
  place: MeetupPlaceSchema.nullable(),
  rsvps: z.array(MeetupRsvpSchema),
  setBy: z.object({ userId: IdSchema, displayName: z.string() }),
  setAt: IsoDateSchema,
});
export type Meeting = z.infer<typeof MeetingSchema>;

export const SetMeetingBodySchema = z
  .object({
    t: z.number().gt(0, { error: 'Choose a place after the start' }).max(1),
    on: z.string().refine(isCalendarDay, { error: 'A day, like 2026-10-25' }).nullable().optional(),
    /** The meet-up's time, an instant with its offset ("2026-11-13T19:30:00-05:00"); needs `tz`. */
    at: z.iso.datetime({ offset: true, error: 'A time, like 2026-11-13T19:30:00Z' }).nullable().optional(),
    /** The time zone the time was chosen in ("America/New_York"). */
    tz: z.string().refine(isTimeZone, { error: 'A time zone, like Europe/London' }).nullable().optional(),
    minutes: z.int().min(15, { error: 'At least 15 minutes' }).max(600, { error: 'At most 10 hours' }).nullable().optional(),
    place: MeetupPlaceSchema.nullable().optional(),
  })
  .refine((b) => !b.at || !!b.tz, { error: 'Say which time zone the time is in', path: ['tz'] });
export type SetMeetingBody = z.input<typeof SetMeetingBodySchema>;

/** Answering for the meet-up (D206); null takes an answer back. */
export const RsvpBodySchema = z.object({ answer: RsvpAnswerSchema.nullable() });

/**
 * Your calendar feed (D207): whether you have one, and, only in the answer that makes it, its
 * address (the server keeps just its hash, as for sessions).
 */
export const CalendarFeedSchema = z.object({
  enabled: z.boolean(),
  createdAt: IsoDateSchema.nullable(),
  url: z.string().nullable(),
  webcalUrl: z.string().nullable(),
});
export type CalendarFeed = z.infer<typeof CalendarFeedSchema>;

export const BookSummarySchema = z.object({
  id: IdSchema,
  clubId: IdSchema,
  title: z.string(),
  author: z.string(),
  coverUrl: z.string(),
  hasCover: z.boolean(),
  kinds: z.array(EditionKindSchema),
  createdAt: IsoDateSchema,
  addedBy: IdSchema,
  commentCount: z.int(),
  progress: z.array(MemberProgressSchema),
  meeting: MeetingSchema.nullable(),
});
export type BookSummary = z.infer<typeof BookSummarySchema>;

export const BookDetailSchema = BookSummarySchema.extend({
  chapters: z.array(ChapterSchema),
  editions: z.array(EditionSchema),
  referenceEditionId: IdSchema.nullable(),
});
export type BookDetail = z.infer<typeof BookDetailSchema>;

export const UpdateBookBodySchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.bookTitle).optional(),
  author: z.string().trim().max(LIMITS.bookAuthor).optional(),
});

/** One choice per unit of the edition (a track, or a chapter marked inside one), at most them all. */
export const AlignmentBodySchema = z.object({
  unitToChapter: z.array(z.int().nonnegative().nullable()).max(MAX_EDITION_UNITS),
});

export const BookMatchQuerySchema = z.object({ title: z.string().max(LIMITS.bookTitle), author: z.string().max(LIMITS.bookAuthor) });
export const BookMatchSchema = z.object({
  bookId: IdSchema,
  title: z.string(),
  author: z.string(),
  kinds: z.array(EditionKindSchema),
  score: z.number(),
});
export type BookMatch = z.infer<typeof BookMatchSchema>;

/* ------------------------------------------------------------------------------------------ */
/* EPUB publication manifest                                                                   */
/* ------------------------------------------------------------------------------------------ */

export const PublicationSectionSchema = z.object({
  index: z.int(),
  href: z.string(),
  textLength: z.int(),
  linear: z.boolean(),
});

export const PublicationTocEntrySchema = z.object({
  title: z.string(),
  href: z.string(),
  section: z.int(),
  offset: z.int(),
  depth: z.int(),
  /**
   * False for an entry that starts no chapter of the book (D77): a picture's caption, a stave's
   * subtitle, a story's part. Absent in manifests written before, where every entry did.
   */
  chapter: z.boolean().optional(),
  /** The chapter's name where it is not the entry's own (a heading and its subtitle as one). */
  chapterTitle: z.string().optional(),
});

export const PublicationSchema = z.object({
  editionId: IdSchema,
  baseUrl: z.string(),
  title: z.string(),
  author: z.string(),
  language: z.string(),
  direction: z.enum(['ltr', 'rtl']),
  sections: z.array(PublicationSectionSchema),
  toc: z.array(PublicationTocEntrySchema),
  story: z.object({ start: z.number(), end: z.number() }),
  /**
   * The book's own matter right after the story, as the book marks it (its colophon, notes,
   * appendices: D109): readable, and listed after the story. Absent where nothing after the story
   * is the book's (Gutenberg's licence), and in manifests written before.
   */
  backMatter: z.object({ start: z.number(), end: z.number() }).optional(),
  resources: z.array(z.string()),
});
export type Publication = z.infer<typeof PublicationSchema>;
export type PublicationSection = z.infer<typeof PublicationSectionSchema>;
export type PublicationTocEntry = z.infer<typeof PublicationTocEntrySchema>;

/* ------------------------------------------------------------------------------------------ */
/* Imports (uploads)                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** The largest cover image an upload may bring: the server reads a cover whole to redraw it. */
export const MAX_COVER_BYTES = 32 * 1024 ** 2;

export const ImportFileRoleSchema = z.enum(['main', 'track', 'cover']);
export const CreateImportBodySchema = z.object({
  kind: EditionKindSchema,
  files: z
    .array(
      z
        .object({
          name: z.string().min(1).max(500),
          size: z.int().nonnegative().max(LIMITS.maxUploadBytes),
          type: z.string().max(200),
          role: ImportFileRoleSchema,
        })
        .refine((f) => f.role !== 'cover' || f.size <= MAX_COVER_BYTES, { error: 'A cover image can be at most 32 MB.', path: ['size'] }),
    )
    .min(1)
    .max(LIMITS.tracksPerEdition + 1),
});
export const ImportFileStatusSchema = z.object({
  index: z.int(),
  name: z.string(),
  size: z.number(),
  role: ImportFileRoleSchema,
  uploadId: z.string().nullable(),
  offset: z.number(),
  complete: z.boolean(),
});
export const ImportSchema = z.object({
  id: IdSchema,
  clubId: IdSchema,
  kind: EditionKindSchema,
  status: z.enum(['uploading', 'finalized', 'cancelled']),
  files: z.array(ImportFileStatusSchema),
  createdAt: IsoDateSchema,
});
export type Import = z.infer<typeof ImportSchema>;

export const FinalizeImportBodySchema = z.object({
  title: z.string().trim().min(1, { error: 'Enter the title' }).max(LIMITS.bookTitle),
  author: z.string().trim().max(LIMITS.bookAuthor),
  /** Attach to an existing book of the club instead of creating a new one. */
  bookId: IdSchema.optional(),
  /** Import file indices of the tracks in play order (audio). Defaults to natural filename order. */
  trackOrder: z.array(z.int().nonnegative()).max(LIMITS.tracksPerEdition).optional(),
  /** Display titles for tracks, aligned with trackOrder. */
  trackTitles: z.array(z.string().max(300)).max(LIMITS.tracksPerEdition).optional(),
});
export const FinalizeImportResultSchema = z.object({ bookId: IdSchema, editionId: IdSchema });

/* ------------------------------------------------------------------------------------------ */
/* Progress                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const ClientTimeSchema = z.number().int().positive();
export const ReadSpanSchema = z.object({
  from: LocatorSchema,
  to: LocatorSchema,
  /**
   * When this span was read or heard on the device (ms since the epoch), for your own history
   * (D191): a report kept offline and sent later still says when. `since` is when a span that is
   * a stretch of time (listening; several kept pages run together) began. Optional: older clients
   * send neither, and the report's own `at` stands in.
   */
  at: ClientTimeSchema.optional(),
  since: ClientTimeSchema.optional(),
  /**
   * The book-wide page numbers this device showed at `from` and `to` (an EPUB's pages are the
   * device's own, at its layout, D9), so your history says "pages 100–146" as you saw them.
   */
  pages: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
});
export type ReadSpanInput = z.infer<typeof ReadSpanSchema>;

export const ProgressUpdateBodySchema = z.object({
  editionId: IdSchema,
  locator: LocatorSchema,
  /** Spans of this edition that have been displayed or heard since the last update. */
  readSpans: z.array(ReadSpanSchema).max(LIMITS.readSpansPerUpdate),
  /** Client wall-clock time (ms since epoch) of this position, for last-writer-wins. */
  at: z.number().int().positive(),
  label: z.string().max(120).optional(),
});
export type ProgressUpdateBody = z.infer<typeof ProgressUpdateBodySchema>;

export const ReadUpToBodySchema = z.object({ editionId: IdSchema, locator: LocatorSchema });

export const MyProgressSchema = z.object({
  editionId: IdSchema.nullable(),
  locator: LocatorSchema.nullable(),
  t: TimelineValueSchema,
  label: z.string(),
  readRanges: z.array(z.tuple([z.number(), z.number()])),
  furthest: TimelineValueSchema,
  finished: z.boolean(),
  at: z.number(),
});
export type MyProgress = z.infer<typeof MyProgressSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Comments                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * A media note's full view (D140), given only once its comment is open to you: the derived,
 * web-safe rendition (`url`; a video's poster frame, `posterUrl`), its duration and dimensions,
 * and its transcript once the recogniser has made one (D79). `status: 'failed'` with no `url`
 * is the rare file that could not be made web-safe; `'processing'` while a transcript is still
 * being made (the media itself is always ready, or failed, by the time a note is created: D142).
 */
export const NoteMediaViewSchema = z.object({
  id: IdSchema,
  kind: NoteMediaKindSchema,
  status: NoteMediaStatusSchema,
  mime: z.string().nullable(),
  url: z.string().nullable(),
  posterUrl: z.string().nullable().optional(),
  durationMs: z.number().nonnegative().nullable(),
  width: z.int().nonnegative().nullable(),
  height: z.int().nonnegative().nullable(),
  transcript: z.string().nullable(),
  transcriptStatus: NoteTranscriptStatusSchema,
});
export type NoteMediaView = z.infer<typeof NoteMediaViewSchema>;

/** What a media note still closed to you says instead of its bytes: its kind, and nothing else. */
export const HiddenNoteMediaSchema = z.object({ kind: NoteMediaKindSchema });
export type HiddenNoteMedia = z.infer<typeof HiddenNoteMediaSchema>;

export const CreateCommentBodySchema = z
  .object({
    editionId: IdSchema,
    locator: LocatorSchema,
    endLocator: LocatorSchema.optional(),
    quote: z.string().max(LIMITS.quote).optional(),
    text: z.string().trim().max(LIMITS.commentText).optional(),
    reaction: ReactionSchema.optional(),
    /**
     * Media uploaded beforehand (POST /api/books/:bookId/media) and not yet attached to a note:
     * one voice recording, 1-4 photos, or one video (D140). Attaching claims them.
     */
    mediaIds: z.array(IdSchema).max(LIMITS.photosPerNote).optional(),
    /** Client-generated id so an offline retry never creates a duplicate. */
    clientId: z.string().min(8).max(64).optional(),
    /**
     * Its writer, having read further, says it is only about this passage: it opens at its place,
     * not where they had read to (D69).
     */
    aboutHere: z.boolean().optional(),
  })
  .refine((d) => (d.text !== undefined && d.text.length > 0) || d.reaction !== undefined || (d.mediaIds !== undefined && d.mediaIds.length > 0), {
    error: 'A comment needs text, a reaction, or media',
  });
export type CreateCommentBody = z.infer<typeof CreateCommentBodySchema>;

const CommentBaseSchema = z.object({
  id: IdSchema,
  bookId: IdSchema,
  userId: IdSchema,
  authorName: z.string(),
  color: z.string(),
  t: TimelineValueSchema,
  editionId: IdSchema,
  kind: EditionKindSchema,
  locator: LocatorSchema,
  reaction: ReactionSchema.nullable(),
  createdAt: IsoDateSchema,
  /**
   * A reply's note (D48): replies sit at their note's place, and are read once it is and where
   * their writer had read to is (D69).
   */
  parentId: IdSchema.nullable().optional(),
  /** A deleted note kept, without its words, for the replies under it. */
  deleted: z.boolean().optional(),
});

export const RevealedCommentSchema = CommentBaseSchema.extend({
  hidden: z.literal(false),
  endLocator: LocatorSchema.nullable(),
  endT: TimelineValueSchema.nullable(),
  quote: z.string().nullable(),
  text: z.string().nullable(),
  /** Its voice recording, photos or video, in full (D140); empty for a note with none. */
  media: z.array(NoteMediaViewSchema).optional(),
  /**
   * Your own note or reply written from further on (D69): where friends must have read to before
   * its words reach them ("Chapter 6"). Only its writer is told.
   */
  horizon: z.string().nullable().optional(),
});
export const HiddenCommentSchema = CommentBaseSchema.extend({
  hidden: z.literal(true),
  /** Whether there is text waiting behind the marker (never the text itself). */
  hasText: z.boolean(),
  /** Its media's kind, if it has any (D140): never its bytes, duration or dimensions. */
  media: z.array(HiddenNoteMediaSchema).optional(),
  /**
   * When only where its writer had read to keeps it closed (you have read its place, D69): that
   * place, as the club bar names places ("Chapter 9"). It opens when you get there.
   */
  horizon: z.string().nullable().optional(),
  /**
   * Its place (`t`, `locator`) is given only roughly, to half a per cent of the book within its
   * chapter: a note at a place you have not read (D80). Its exact place would be its passage.
   */
  approx: z.boolean().optional(),
});
export const CommentViewSchema = z.discriminatedUnion('hidden', [RevealedCommentSchema, HiddenCommentSchema]);

/** Most characters of an EPUB section a request for the places on a page may span (D80). */
export const MAX_PAGE_CHARS = 8000;

/**
 * The page in front of you, to be told exactly where the closed notes on it are (D80): an EPUB
 * section's characters `from` to `to` (at most MAX_PAGE_CHARS), or a PDF's page.
 */
export const PlacesQuerySchema = z.object({
  edition: IdSchema,
  section: z.coerce.number().int().min(0).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(0).optional(),
});
export type PlacesQuery = z.infer<typeof PlacesQuerySchema>;

/** The exact places of the closed notes, placed only roughly in the list, on that page. */
export const PlacesSchema = z.object({
  places: z.array(z.object({ id: IdSchema, t: TimelineValueSchema, locator: LocatorSchema })),
});
export type Places = z.infer<typeof PlacesSchema>;
export type RevealedComment = z.infer<typeof RevealedCommentSchema>;
export type HiddenComment = z.infer<typeof HiddenCommentSchema>;
export type CommentView = z.infer<typeof CommentViewSchema>;

export const CreateReplyBodySchema = z
  .object({
    text: z.string().trim().max(LIMITS.commentText).optional(),
    reaction: ReactionSchema.optional(),
    /** Media uploaded beforehand, not yet attached: a reply may be a voice note too (D140). */
    mediaIds: z.array(IdSchema).max(LIMITS.photosPerNote).optional(),
    clientId: z.string().min(8).max(64).optional(),
    /**
     * Its writer, having read further, says it is only about the note's passage: it opens with the
     * note, not where they had read to (D69).
     */
    aboutHere: z.boolean().optional(),
  })
  .refine((d) => (d.text !== undefined && d.text.length > 0) || d.reaction !== undefined || (d.mediaIds !== undefined && d.mediaIds.length > 0), {
    error: 'Write something, react, or attach media',
  });
export type CreateReplyBody = z.infer<typeof CreateReplyBodySchema>;

/** A note's media, uploaded (POST /api/books/:bookId/media) before the note that will carry it. */
export const UploadedNoteMediaSchema = z.object({
  id: IdSchema,
  kind: NoteMediaKindSchema,
  status: NoteMediaStatusSchema,
  mime: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  width: z.int().nonnegative().nullable(),
  height: z.int().nonnegative().nullable(),
  /** Why it failed, for the uploader (never anyone else): a file that could not be made web-safe. */
  error: z.string().nullable(),
});
export type UploadedNoteMedia = z.infer<typeof UploadedNoteMediaSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Notifications (D49)                                                                         */
/* ------------------------------------------------------------------------------------------ */

export const NotificationViewSchema = z.object({
  id: IdSchema,
  /**
   * `reply`: someone answered your note (or a thread you are in); `reached`: a friend got to your
   * note; `mention` (D152): someone @-mentioned you in a club's chat.
   */
  kind: z.enum(['reply', 'reached', 'mention']),
  bookId: IdSchema.nullable(),
  bookTitle: z.string().nullable(),
  commentId: IdSchema.nullable(),
  /** The note the conversation is about (the reply's note, or the note itself). Null for a mention. */
  noteId: IdSchema.nullable(),
  /** A mention's club, and the chat message it was in. */
  clubId: IdSchema.nullable(),
  clubName: z.string().nullable(),
  chatMessageId: IdSchema.nullable(),
  actorName: z.string(),
  actorColor: z.string(),
  /** Where in the book ("Chapter 3 · 18%"); the club's name for a mention. */
  where: z.string(),
  /** The reply's first words (replies only, once they are open to you); a mention's own words. */
  text: z.string().nullable(),
  /**
   * A reply held by where its writer had read to (D69): that place ("Chapter 9"); its words come
   * when you get there.
   */
  horizon: z.string().nullable().optional(),
  /** A reply with no words of its own, carrying only a voice recording, photos or a video (D140). */
  mediaKind: NoteMediaKindSchema.nullable().optional(),
  /**
   * How many of your notes were reached in this sweep, batched so that catching up a whole
   * chapter tells its friends once, not once per note (D145): 1 for an ordinary "got to it" or a
   * reply. Bumped in place rather than posting a second notification while the first is unread.
   */
  count: z.int().min(1).optional(),
  createdAt: IsoDateSchema,
  read: z.boolean(),
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

export const NotificationListSchema = z.object({ unread: z.int(), items: z.array(NotificationViewSchema) });
export type NotificationList = z.infer<typeof NotificationListSchema>;

export const ReadNotificationsBodySchema = z.object({ ids: z.array(IdSchema).max(200).optional() });

/** The iOS app's raw APNs device token (D134): hex, as `getDevicePushTokenAsync` returns it. */
export const PushTokenSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{32,200}$/, { error: 'Not a device push token' });
export const PushRegisterBodySchema = z.object({ token: PushTokenSchema, platform: z.literal('ios').default('ios') });
export const PushUnregisterBodySchema = z.object({ token: PushTokenSchema });

export const ProgressUpdateResultSchema = z.object({
  mine: MyProgressSchema,
  /** Comments whose text this update unlocked. */
  revealed: z.array(RevealedCommentSchema),
});
export type ProgressUpdateResult = z.infer<typeof ProgressUpdateResultSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Listening speed (D195)                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** A listening speed: 0.5 to 3.0, in steps of 0.05 (packages/shared/src/audio/rate.ts). */
export const PlaybackRateSchema = z.number().refine(isRateStep, { error: 'A speed from 0.5× to 3.0×, in steps of 0.05' });

/** When a speed was chosen: the client's clock, ms since epoch. The newest choice wins. */
const ChosenAtSchema = z.int().positive().max(8.64e15);

/** Your own default speed, the one a book you have not listened to yet starts at. */
export const ListeningSettingsSchema = z.object({ defaultRate: PlaybackRateSchema, at: z.number() });
export type ListeningSettings = z.infer<typeof ListeningSettingsSchema>;
export const SetListeningSettingsBodySchema = z.object({ defaultRate: PlaybackRateSchema, at: ChosenAtSchema });

/** The last speed you used for one book, and when you chose it. */
export const BookPlaybackSchema = z.object({ rate: PlaybackRateSchema, at: z.number() });
export type BookPlayback = z.infer<typeof BookPlaybackSchema>;
export const SetBookPlaybackBodySchema = z.object({ rate: PlaybackRateSchema, at: ChosenAtSchema });

/**
 * The audiobook's controls in the book (D197): your default, shown unless you hide them, for books
 * with an audiobook you do not listen to. When it was chosen, as speed (newest wins).
 */
export const AudioControlsSchema = z.object({ hidden: z.boolean(), at: z.number() });
export type AudioControls = z.infer<typeof AudioControlsSchema>;
export const SetAudioControlsBodySchema = z.object({ hidden: z.boolean(), at: ChosenAtSchema });

/** One book's own choice over your default (D197): hidden, shown, or null for as your default says. */
export const BookAudioControlsSchema = z.object({ hidden: z.boolean().nullable(), at: z.number() });
export type BookAudioControls = z.infer<typeof BookAudioControlsSchema>;
export const SetBookAudioControlsBodySchema = z.object({ hidden: z.boolean().nullable(), at: ChosenAtSchema });

export const BookProgressSchema = z.object({
  mine: MyProgressSchema.nullable(),
  members: z.array(MemberProgressSchema),
  /**
   * The speed you last listened to this book at (D195), or null if you never chose one for it.
   * Yours alone, like `mine`. Optional (the server always sends it) so the many hand-built
   * `BookProgress` fixtures unrelated to listening keep compiling unchanged; a missing value
   * reads as null.
   */
  playback: BookPlaybackSchema.nullable().optional(),
  /** This book's own choice over your default for the audiobook's controls (D197), or null. Optional as `playback` is. */
  audioControls: BookAudioControlsSchema.nullable().optional(),
});
export type BookProgress = z.infer<typeof BookProgressSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Errors                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Forced alignment and read-along (D46)                                                       */
/* ------------------------------------------------------------------------------------------ */

/** A recognised word: start and end in milliseconds of its track, the text, a confidence. */
export const TranscriptWordSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.string().max(200)], z.number());

/** What tools/align/transcribe.py writes, and what an owner may upload for an audiobook. */
export const TranscriptSchema = z.object({
  format: z.literal('bookclub-transcript/1'),
  engine: z.string().max(200).default('unknown'),
  model: z.string().max(200).optional(),
  tracks: z
    .array(
      z.object({
        file: z.string().max(500).optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        durationMs: z.number().positive(),
        words: z.array(TranscriptWordSchema).max(200_000),
      }),
    )
    .min(1)
    .max(2000),
}).refine((t) => t.tracks.reduce((n, track) => n + track.words.length, 0) <= LIMITS.transcriptWords, { error: 'That is more words than any audiobook has' });
export type Transcript = z.infer<typeof TranscriptSchema>;

/**
 * The sentences read in one track: `[section, offset, length, startMs, endMs]` (the place in the
 * text edition, the time in the track) and each sentence's text, for following along.
 */
export const ReadAlongTrackSchema = z.object({
  audioEditionId: IdSchema,
  textEditionId: IdSchema,
  track: z.int(),
  /**
   * Where this track's narration meets the text next, `[section, offset]`: its first sentence's
   * start, or, for a track that reads none (opening credits, an announcement), the next track's
   * that does; null past the last (D184). Optional: a response kept from an older server has none.
   */
  lead: z.tuple([z.int(), z.int()]).nullable().optional(),
  /** Where the text was left before this track, `[section, offset]` (the end of the last sentence read); null before the first. */
  previous: z.tuple([z.int(), z.int()]).nullable().optional(),
  sentences: z.array(z.tuple([z.int(), z.int(), z.int(), z.number(), z.number()])),
  text: z.array(z.string()),
});
export type ReadAlongTrack = z.infer<typeof ReadAlongTrackSchema>;

// ---------------------------------------------------------------------------------------------
// Your own reading and listening history (D191). Never anyone else's: the server answers only for
// the person signed in.

export const HistoryEntrySchema = z.object({
  id: IdSchema,
  bookId: IdSchema,
  editionId: IdSchema,
  kind: z.enum(['epub', 'pdf', 'audio']),
  /** Which device it was on, coarsely ("iPhone", "iPhone app", "Mac"): from the browser's own description of itself. */
  device: z.string().max(40),
  /** When it began and ended, on the device's clock (ms since the epoch). */
  startedAt: z.number(),
  endedAt: z.number(),
  /** Time spent reading or listening in it: pauses and a phone put down not counted. */
  activeMs: z.number().nonnegative(),
  /** Where it began and the furthest it went, in the edition's own terms, and on the book's timeline. */
  from: LocatorSchema,
  to: LocatorSchema,
  fromT: z.number(),
  toT: z.number(),
  /** The pages the device showed there (EPUB), when it said. */
  pages: z.object({ from: z.number().int(), to: z.number().int() }).nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const HistoryBookSchema = z.object({ id: IdSchema, clubId: IdSchema, title: z.string(), author: z.string(), coverUrl: z.string() });
export type HistoryBook = z.infer<typeof HistoryBookSchema>;

export const HistoryListSchema = z.object({
  /** Newest first. */
  entries: z.array(HistoryEntrySchema),
  /** The books named in `entries`. */
  books: z.array(HistoryBookSchema),
  /** Pass as `before` for older entries; null at the start of your history. */
  next: z.number().nullable(),
});
export type HistoryList = z.infer<typeof HistoryListSchema>;
// The iOS app's widgets and Live Activity (D188): what they show of your reading. Only your own
// places, and your clubs' next stops, which every member already sees on the book page.

export const WidgetBookSchema = z.object({
  bookId: IdSchema,
  clubId: IdSchema,
  clubName: z.string(),
  title: z.string(),
  author: z.string(),
  /** The cover (add `shape=square&w=` for a tile, D190); fetched by the app, which has the session. */
  coverUrl: z.string(),
  /** Your place on the book's timeline, and as a whole percentage. */
  t: z.number(),
  percent: z.int().min(0).max(100),
  /** Your place as friends see it ("Chapter 4 · 23%"). */
  label: z.string(),
  /** The format you were last in. */
  format: z.enum(['epub', 'pdf', 'audio']).nullable(),
  finished: z.boolean(),
  /** When you were last there, on your device's clock (ms since the epoch). */
  at: z.number(),
  /** The club's next stop (D53): where, by when, how much of the book is left to it, and whether you are there. */
  stop: z
    .object({ label: z.string(), on: z.string().nullable(), toGo: z.number().min(0).max(1), reached: z.boolean() })
    .nullable(),
});
export type WidgetBook = z.infer<typeof WidgetBookSchema>;

export const WidgetSnapshotSchema = z.object({
  generatedAt: z.number(),
  /** The book you were in last, across your clubs; null before you have opened one. */
  current: WidgetBookSchema.nullable(),
  /** The others you have going, newest first (at most three). */
  others: z.array(WidgetBookSchema),
});
export type WidgetSnapshot = z.infer<typeof WidgetSnapshotSchema>;
