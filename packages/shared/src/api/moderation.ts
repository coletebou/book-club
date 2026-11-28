import { z } from 'zod';
import { IdSchema, type NoteMediaKind } from './schemas';

export const ModerationTargetSchema = z.enum(['chat', 'comment', 'reaction']);
export const ReportReasonSchema = z.enum(['harassment', 'spam', 'unsafe', 'other']);
export const CreateReportBodySchema = z.object({
  kind: ModerationTargetSchema,
  targetId: IdSchema,
  reason: ReportReasonSchema,
  details: z.string().trim().max(1000).optional(),
}).strict();
export type CreateReportBody = z.infer<typeof CreateReportBodySchema>;

export interface ContentReport {
  readonly id: string;
  readonly clubId: string;
  readonly bookId: string | null;
  readonly targetId: string;
  readonly parentId: string | null;
  readonly kind: CreateReportBody['kind'];
  readonly reason: CreateReportBody['reason'];
  readonly details: string | null;
  readonly reporterName: string | null;
  readonly authorName: string;
  readonly createdAt: string;
}

export interface ContentReports {
  readonly reports: readonly ContentReport[];
  readonly before: string | null;
}

export interface ReportedContent {
  readonly text: string | null;
  readonly reaction: string | null;
  readonly hasVoiceMessage?: boolean;
  readonly media: readonly { id: string; kind: NoteMediaKind; url: string }[];
}

export interface BlockedMember {
  readonly userId: string;
  readonly displayName: string;
}
