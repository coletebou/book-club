import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CreateReportBody, formatWhen } from '@bookclub/shared';
import { useState } from 'react';
import { api, getPageUser } from '../lib/api';
import { memberBlocksKey, syncMemberBlocks } from '../lib/moderation';
import { FormError } from './Form';
import { Modal } from './Modal';
import { TARGETS } from './MemberSafetyActions';
import { useToast } from './Toasts';

const REASONS = {
  harassment: 'Harassment or abuse',
  spam: 'Spam',
  unsafe: 'Threats or unsafe content',
  other: 'Something else',
} satisfies Record<CreateReportBody['reason'], string>;

export function ReportDialog({ clubId, kind, targetId, onClose }: { clubId: string; kind: CreateReportBody['kind']; targetId: string; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState<CreateReportBody['reason'] | ''>('');
  const [details, setDetails] = useState('');
  const report = useMutation({
    mutationFn: (selected: CreateReportBody['reason']) => api.reportContent(clubId, { kind, targetId, reason: selected, details: details.trim() || undefined }),
    onSuccess: () => {
      toast.show('Report sent to the club owner.');
      onClose();
    },
  });
  return (
    <Modal title={`Report ${TARGETS[kind]}`} onClose={() => { if (!report.isPending) onClose(); }} initialFocus="select">
      <form className="form" onSubmit={(event) => { event.preventDefault(); if (reason) report.mutate(reason); }}>
        <p className="muted small">The club owner and Book Club operator can review this report. Please leave out book spoilers.</p>
        <label className="field">
          <span>Reason</span>
          <select required value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
            <option value="" disabled>Choose a reason</option>
            {Object.entries(REASONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Details (optional)</span>
          <textarea rows={3} maxLength={1000} value={details} onChange={(event) => setDetails(event.target.value)} />
        </label>
        <FormError error={report.error} />
        <button type="submit" className="btn btn-primary" disabled={!reason || report.isPending}>{report.isPending ? 'Sending…' : 'Send report'}</button>
      </form>
    </Modal>
  );
}

export function BlockedMembersCard() {
  const qc = useQueryClient();
  const blocked = useQuery({ queryKey: memberBlocksKey, queryFn: api.memberBlocks });
  const unblock = useMutation({
    mutationFn: api.unblockMember,
    onSuccess: async (members) => {
      qc.setQueryData(memberBlocksKey, members);
      const userId = getPageUser();
      if (userId) await syncMemberBlocks(qc, userId, members.map((member) => member.userId));
    },
  });
  return (
    <section className="card stack" aria-labelledby="blocked-members-title">
      <h2 id="blocked-members-title">Blocked members</h2>
      <FormError error={blocked.error ?? unblock.error} />
      {blocked.isPending ? <p role="status">Loading blocked members…</p> : null}
      {blocked.data?.length === 0 ? <p className="small muted">You haven’t blocked anyone.</p> : null}
      {blocked.data?.length ? (
        <ul className="member-admin">
          {blocked.data.map((member) => (
            <li key={member.userId}>
              <span>{member.displayName}</span>
              <button type="button" className="btn btn-small" disabled={unblock.isPending} onClick={() => unblock.mutate(member.userId)} aria-label={`Unblock ${member.displayName}`}>Unblock</button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ClubReportsCard({ clubId }: { clubId: string }) {
  const [reportId, setReportId] = useState<string | null>(null);
  const page = useInfiniteQuery({
    queryKey: ['moderation-reports', clubId],
    queryFn: ({ pageParam }) => api.contentReports(clubId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.before ?? undefined,
  });
  const reports = page.data?.pages.flatMap((part) => part.reports);
  return (
    <section className="card stack" aria-labelledby="club-reports-title">
      <h2 id="club-reports-title">Content reports</h2>
      <FormError error={page.error} />
      {page.isPending ? <p role="status">Loading reports…</p> : null}
      {reports?.length === 0 ? <p className="small muted">No reports yet.</p> : null}
      {reports?.length ? (
        <ul className="stack">
          {reports.map((report) => (
            <li className="stack" key={report.id}>
              <strong>{REASONS[report.reason]}</strong>
              <p className="small muted">{report.reporterName ?? 'A member'} reported {report.authorName}’s {TARGETS[report.kind]} · {formatWhen(report.createdAt)}</p>
              {report.details ? <p>{report.details}</p> : null}
              <button type="button" className="btn btn-small" onClick={() => setReportId(report.id)}>Review {TARGETS[report.kind]}</button>
            </li>
          ))}
        </ul>
      ) : null}
      {page.hasNextPage ? <button type="button" className="btn" disabled={page.isFetchingNextPage} onClick={() => void page.fetchNextPage()}>Older reports</button> : null}
      {reportId ? <ReportedItemDialog clubId={clubId} reportId={reportId} onClose={() => setReportId(null)} /> : null}
    </section>
  );
}

function ReportedItemDialog({ clubId, reportId, onClose }: { clubId: string; reportId: string; onClose: () => void }) {
  const target = useQuery({ queryKey: ['reported-content', clubId, reportId], queryFn: () => api.reportedContent(clubId, reportId), gcTime: 0 });
  const content = target.data;
  return (
    <Modal title="Reported item" onClose={onClose}>
      {target.isPending ? <p role="status">Loading reported item…</p> : null}
      <FormError error={target.error} />
      {content ? (
        <div className="stack">
          {content.text ? <p>{content.text}</p> : null}
          {content.reaction ? <p>{content.reaction}</p> : null}
          {content.hasVoiceMessage ? <p>Voice message</p> : null}
          {content.media.map(({ id, kind, url }) => (
            kind === 'photo' ? <img key={id} src={url} alt="Reported picture" style={{ maxWidth: '100%' }} />
              : kind === 'voice' ? <audio key={id} src={url} controls preload="none" />
                : <video key={id} src={url} controls preload="none" style={{ maxWidth: '100%' }} />
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
