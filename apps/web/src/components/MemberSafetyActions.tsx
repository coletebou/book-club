import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BookDetail, CommentView, CreateReportBody } from '@bookclub/shared';
import { lazy, Suspense, useState } from 'react';
import { api, getPageUser } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { memberBlocksKey, syncMemberBlocks } from '../lib/moderation';
import { keys } from '../lib/queries';
import { useToast } from './Toasts';

export const TARGETS = { chat: 'message', comment: 'note', reaction: 'reaction' } satisfies Record<CreateReportBody['kind'], string>;

const ReportForm = lazy(() => import('./MemberSafety').then((module) => ({ default: module.ReportDialog })));
const BlockedMembers = lazy(() => import('./MemberSafety').then((module) => ({ default: module.BlockedMembersCard })));
const ClubReports = lazy(() => import('./MemberSafety').then((module) => ({ default: module.ClubReportsCard })));

export function ReportDialog(props: { clubId: string; kind: CreateReportBody['kind']; targetId: string; onClose: () => void }) {
  return <Suspense><ReportForm {...props} /></Suspense>;
}

export function BlockedMembersCard() {
  return <Suspense><BlockedMembers /></Suspense>;
}

export function ClubReportsCard({ clubId }: { clubId: string }) {
  return <Suspense><ClubReports clubId={clubId} /></Suspense>;
}

export function ReportContentButton({ clubId, kind, targetId }: { clubId: string; kind: CreateReportBody['kind']; targetId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-small btn-ghost" onClick={() => setOpen(true)}>Report {TARGETS[kind]}</button>
      {open ? <ReportDialog clubId={clubId} kind={kind} targetId={targetId} onClose={() => setOpen(false)} /> : null}
    </>
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

export function isNoteSafetyTarget(note: CommentView, selfId: string | undefined): boolean {
  return !!selfId && note.userId !== selfId && !note.deleted;
}

export function NoteSafetyActions({ note, selfId }: { note: CommentView; selfId: string | undefined }) {
  const qc = useQueryClient();
  const clubId = qc.getQueryData<BookDetail>(keys.book(note.bookId))?.clubId;
  if (!clubId || !isNoteSafetyTarget(note, selfId)) return null;
  const isNote = !note.hidden && (note.text || note.quote || note.media?.length || !note.reaction);
  return (
    <>
      {isNote ? <ReportContentButton clubId={clubId} kind="comment" targetId={note.id} /> : null}
      {note.reaction ? <ReportContentButton clubId={clubId} kind="reaction" targetId={note.id} /> : null}
      <BlockMemberButton clubId={clubId} userId={note.userId} displayName={note.authorName} />
    </>
  );
}
