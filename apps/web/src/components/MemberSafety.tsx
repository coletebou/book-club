import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type BookDetail, type CommentView, type CreateReportBody, formatWhen } from '@bookclub/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, getPageUser } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { memberBlocksKey, syncMemberBlocks } from '../lib/moderation';
import { keys } from '../lib/queries';
import { FormError } from './Form';
import { Modal } from './Modal';
import { useToast } from './Toasts';

const REASONS = {
  harassment: 'Harassment or abuse',
  spam: 'Spam',
  unsafe: 'Threats or unsafe content',
  other: 'Something else',
} satisfies Record<CreateReportBody['reason'], string>;

const TARGETS = { chat: 'message', comment: 'note', reaction: 'reaction' } satisfies Record<CreateReportBody['kind'], string>;

export function ReportContentButton({ clubId, kind, targetId }: { clubId: string; kind: CreateReportBody['kind']; targetId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-small btn-ghost" onClick={() => setOpen(true)}>Report {TARGETS[kind]}</button>
      {open ? <ReportDialog clubId={clubId} kind={kind} targetId={targetId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

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

export function BlockMemberButton({ clubId, userId, displayName }: { clubId: string; userId: string; displayName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const block = useMutation({
    mutationFn: () => api.blockMember(clubId, userId),
    onSuccess: async (members) => {
      qc.setQueryData(memberBlocksKey, members);
      const userId = getPageUser();
      if (userId) await syncMemberBlocks(qc, userId, members.map((member) => member.userId));
      toast.show(`Blocked ${displayName}. You can unblock them in Settings.`);
    },
    onError: (error) => toast.show(error instanceof Error ? error.message : 'Could not block this member.', 'error'),
  });
  const confirm = () => void confirmAction({
    title: `Block ${displayName}?`,
    body: 'Their chat messages, notes and reactions will be hidden for you. You can unblock them in Settings.',
    confirm: 'Block member',
    danger: true,
  }).then((confirmed) => { if (confirmed) block.mutate(); });
  return <button type="button" className="btn btn-small btn-ghost" onClick={confirm} disabled={block.isPending}>Block member</button>;
}

export function NoteSafetyActions({ note, selfId }: { note: CommentView; selfId: string | undefined }) {
  const qc = useQueryClient();
  const clubId = qc.getQueryData<BookDetail>(keys.book(note.bookId))?.clubId;
  if (!clubId || !selfId || note.userId === selfId || note.deleted) return null;
  const isNote = !note.hidden && (note.text || note.quote || note.media?.length || !note.reaction);
  return (
    <>
      {isNote ? <ReportContentButton clubId={clubId} kind="comment" targetId={note.id} /> : null}
      {note.reaction ? <ReportContentButton clubId={clubId} kind="reaction" targetId={note.id} /> : null}
      <BlockMemberButton clubId={clubId} userId={note.userId} displayName={note.authorName} />
    </>
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
              <p className="small muted">{report.reporterName} reported {report.authorName}’s {TARGETS[report.kind]} · {formatWhen(report.createdAt)}</p>
              {report.details ? <p>{report.details}</p> : null}
              {report.kind === 'chat' ? <Link to={`/clubs/${clubId}/chat?message=${report.targetId}`}>Open message</Link> : null}
              {report.kind !== 'chat' && report.bookId ? (
                <Link to={`/books/${report.bookId}#note-${report.parentId ?? report.targetId}`} state={{ comment: report.targetId }}>Open book discussion</Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {page.hasNextPage ? <button type="button" className="btn" disabled={page.isFetchingNextPage} onClick={() => void page.fetchNextPage()}>Older reports</button> : null}
    </section>
  );
}
