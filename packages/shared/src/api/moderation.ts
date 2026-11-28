import { z } from 'zod';
import { IdSchema } from './schemas';

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
  readonly reporterName: string;
  readonly authorName: string;
  readonly createdAt: string;
}

export interface ContentReports {
  readonly reports: readonly ContentReport[];
  readonly before: string | null;
}

export interface BlockedMember {
  readonly userId: string;
  readonly displayName: string;
}
