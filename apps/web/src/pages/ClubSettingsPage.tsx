import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { type ClubDetail, LIMITS, type Member } from '@bookclub/shared';
import { Field, FormError, TextArea } from '../components/Form';
import { ClubPlanCard } from '../components/ClubPlanCard';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Avatar } from '../components/People';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { keys, useClub, useSession } from '../lib/queries';

/** How a member's `source` (D178) reads next to "Signs in with": the upstream by its own name, Apple and Google by theirs. */
function providerLabel(source: Exclude<Member['source'], 'local'>, upstreamName: string | undefined): string {
  if (source === 'upstream') return upstreamName ?? 'their main account';
  return source === 'apple' ? 'Apple' : 'Google';
}

/**
 * A club's page of its own. Everyone sees who is in it and can leave it; owners also rename it,
 * say what it is about, replace the invite link, manage members (owners, reset links), and
 * disband it (D179).
 */
export function ClubSettingsPage() {
  const { clubId = '' } = useParams();
  const club = useClub(clubId);
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<{ name: string; url: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.club(clubId) });

  const rename = useMutation({
    mutationFn: () => api.updateClub(clubId, { ...(name !== null ? { name } : {}), ...(description !== null ? { description } : {}) }),
    onSuccess: () => {
      setName(null);
      setDescription(null);
      void refresh();
      void qc.invalidateQueries({ queryKey: keys.clubs });
      toast.show('Saved.');
    },
  });
  const leave = useMutation({
    mutationFn: () => api.removeMember(clubId, session.data?.user?.id ?? ''),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.clubs });
      qc.removeQueries({ queryKey: keys.club(clubId) });
      void navigate('/', { replace: true });
    },
  });
  const disband = useMutation({
    mutationFn: () => api.disbandClub(clubId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.clubs });
      qc.removeQueries({ queryKey: keys.club(clubId) });
      toast.show(`${club.data?.name ?? 'The club'} is disbanded.`);
      void navigate('/', { replace: true });
    },
  });
  const rotate = useMutation({
    mutationFn: () => api.rotateInvite(clubId),
    onSuccess: () => {
      void refresh();
      toast.show('A new invite link replaces the old one.');
    },
  });
  const remove = useMutation({ mutationFn: (userId: string) => api.removeMember(clubId, userId), onSuccess: () => void refresh() });
  const makeOwner = useMutation({ mutationFn: (userId: string) => api.setRole(clubId, userId, 'owner'), onSuccess: () => void refresh() });
  const reset = useMutation({
    mutationFn: (m: { userId: string; name: string }) => api.resetLink(clubId, m.userId).then((r) => ({ ...r, name: m.name })),
    onSuccess: (r) => setResetLink({ name: r.name, url: r.url }),
  });

  if (!club.data) return null;
  const c = club.data;
  const selfId = session.data?.user?.id;
  const owner = c.role === 'owner';
  const changed = (name !== null && name.trim() !== '' && name !== c.name) || (description !== null && description !== c.description);
  if (!owner) {
    return (
      <div className="stack-lg">
        <Link to={`/clubs/${clubId}`} className="back-link">
          <Icon name="back" size={18} /> {c.name}
        </Link>
        <h1>{c.name}</h1>
        {c.description ? <p className="muted">{c.description}</p> : null}
        <MemberList members={c.members} selfId={selfId} />
        <ClubPlanCard plan={c.plan} />
        <LeaveClub clubName={c.name} onLeave={() => leave.mutate()} error={leave.error} />
      </div>
    );
  }
  return (
    <div className="stack-lg">
      <Link to={`/clubs/${clubId}`} className="back-link">
        <Icon name="back" size={18} /> {c.name}
      </Link>
      <h1>Club settings</h1>
      <section className="card stack" aria-labelledby="name-title">
        <h2 id="name-title">Name and description</h2>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <FormError error={rename.error} />
          <Field label="Club name" value={name ?? c.name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.clubName} />
          <TextArea label="What you are reading for" value={description ?? c.description} onChange={(e) => setDescription(e.target.value)} maxLength={LIMITS.clubDescription} rows={2} hint="Shown under the club's name in its library." />
          <button type="submit" className="btn" disabled={!changed || rename.isPending} data-testid="save-club">
            Save
          </button>
        </form>
      </section>
      <ClubPlanCard plan={c.plan} />
      <section className="card stack" aria-labelledby="invite-title">
        <h2 id="invite-title">Invite link</h2>
        <p className="muted small">Anyone with the link can join. Replace it if it has been shared too widely.</p>
        {c.invite ? <code className="invite-code">{c.invite.url}</code> : null}
        <button type="button" className="btn" onClick={() => rotate.mutate()}>
          Replace invite link
        </button>
      </section>
      <section className="card stack" aria-labelledby="people-title">
        <h2 id="people-title">Members</h2>
        <ul className="member-admin">
          {c.members.map((m) => (
            <li key={m.userId}>
              <Avatar name={m.displayName} color={m.color} />
              <span>
                {m.displayName} {m.role === 'owner' ? <span className="chip chip-gold">owner</span> : null}
              </span>
              {m.userId !== selfId ? (
                <span className="row">
                  {m.source !== 'local' ? (
                    // Nothing to reset for any of these (D178: Apple and Google are passwordless
                    // here too, like the upstream grant) — repos/clubs.ts's `members()` already
                    // keeps `local` for an account that linked one of these but kept its password.
                    <span className="muted small">Signs in with {providerLabel(m.source, session.data?.upstream?.name)}</span>
                  ) : (
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => reset.mutate({ userId: m.userId, name: m.displayName })}>
                      Reset link
                    </button>
                  )}
                  {m.role !== 'owner' ? (
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => makeOwner.mutate(m.userId)}>
                      Make owner
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-small btn-ghost btn-danger"
                    onClick={() =>
                      void confirmAction({
                        title: `Remove ${m.displayName} from ${c.name}?`,
                        body: 'Their notes stay. The invite link is replaced, so the one they had no longer works.',
                        confirm: 'Remove',
                        danger: true,
                      }).then((yes) => yes && remove.mutate(m.userId))
                    }
                  >
                    Remove
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {/* In a dialog, where a phone shows it whatever was scrolled, with Copy and Share as the
            invite has: a forgotten password is a message to send, not a link to find. */}
        {resetLink ? (
          <Modal
            title={`A new password for ${resetLink.name}`}
            onClose={() => setResetLink(null)}
            footer={
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(resetLink.url)
                      .then(() => toast.show('Link copied.'))
                      .catch(() => toast.show('Select the link and copy it.', 'error'))
                  }
                >
                  Copy link
                </button>
                {typeof navigator.share === 'function' ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      void navigator.share({ title: 'Choose a new password', url: resetLink.url }).catch((err: unknown) => {
                        if (!(err instanceof DOMException && err.name === 'AbortError')) toast.show('That did not work: copy the link instead.', 'error');
                      })
                    }
                  >
                    Share…
                  </button>
                ) : null}
              </>
            }
          >
            <p className="small" role="status">
              Send this one-time link to {resetLink.name} (valid 24 hours): <code className="invite-code">{resetLink.url}</code>
            </p>
          </Modal>
        ) : null}
        <FormError error={remove.error ?? reset.error ?? makeOwner.error} />
      </section>
      <LeaveClub clubName={c.name} onLeave={() => leave.mutate()} error={leave.error} />
      <DisbandClub clubName={c.name} memberCount={c.memberCount} onDisband={() => disband.mutate()} pending={disband.isPending} error={disband.error} />
    </div>
  );
}

/** An owner ends the club for everyone (D179), even as its only owner: one confirmation, nothing to type. */
function DisbandClub({ clubName, memberCount, onDisband, pending, error }: { clubName: string; memberCount: number; onDisband: () => void; pending: boolean; error: unknown }) {
  const others = memberCount - 1;
  return (
    <section className="card stack" aria-labelledby="disband-title">
      <h2 id="disband-title">Disband the club</h2>
      <p className="muted small">The club, its books, notes and chat go for everyone{others > 0 ? ` (${others} other ${others === 1 ? 'member' : 'members'})` : ''}. Accounts and other clubs stay.</p>
      <FormError error={error} />
      <button
        type="button"
        className="btn btn-danger"
        data-testid="disband-club"
        disabled={pending}
        onClick={() =>
          void confirmAction({
            title: `Disband ${clubName}?`,
            body: 'Everyone loses the club, its books, notes and chat.',
            confirm: 'Disband',
            cancel: 'Keep',
            danger: true,
          }).then((yes) => yes && onDisband())
        }
      >
        Disband {clubName}
      </button>
    </section>
  );
}

function MemberList({ members, selfId }: { members: readonly ClubDetail['members'][number][]; selfId: string | undefined }) {
  return (
    <section className="card stack" aria-labelledby="people-title">
      <h2 id="people-title">Members</h2>
      <ul className="member-admin">
        {members.map((m) => (
          <li key={m.userId}>
            <Avatar name={m.displayName} color={m.color} />
            <span>
              {m.userId === selfId ? 'You' : m.displayName} {m.role === 'owner' ? <span className="chip chip-gold">owner</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Leaving keeps your notes and your place: invited back, you find them again. */
function LeaveClub({ clubName, onLeave, error }: { clubName: string; onLeave: () => void; error: unknown }) {
  return (
    <section className="card stack" aria-labelledby="leave-title">
      <h2 id="leave-title">Leave the club</h2>
      <p className="muted small">Your notes stay for the others. You can come back with the club’s invite link.</p>
      <FormError error={error} />
      <button
        type="button"
        className="btn btn-danger"
        data-testid="leave-club"
        onClick={() =>
          void confirmAction({
            title: `Leave ${clubName}?`,
            body: 'Your notes stay for the others. You can come back with the club’s invite link.',
            confirm: 'Leave',
            cancel: 'Stay',
            danger: true,
          }).then((yes) => yes && onLeave())
        }
      >
        Leave {clubName}
      </button>
    </section>
  );
}
