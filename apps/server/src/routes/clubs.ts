import { CreateClubBodySchema, IdSchema, UpdateClubBodySchema, type ClubDetail, type InvitePreview, type ResetLinkSchema } from '@bookclub/shared';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { type z } from 'zod';
import { requireMember, requireOwner } from '../auth/access';
import { publicOrigin, requireUser } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import { type AppContext } from '../context';
import { assertRoomToJoin, planView } from '../services/plans';
import { HttpError, badRequest, forbidden, notFound, parse, tooMany } from '../lib/errors';
import { isoRequired } from '../lib/json';
import { disbandClub, endClubVoiceFor } from '../services/removal';
import {
  activeInvite,
  addMember,
  clubById,
  clubsForUser,
  clubsOwnedBy,
  countInviteUse,
  createClub,
  inviteByCode,
  members,
  membership,
  ownerCount,
  removeMember,
  rotateInvite,
  setRole,
  updateClub,
} from '../repos/clubs';
import { hasExternalIdentity } from '../repos/identities';
import { issueResetLink } from '../repos/resets';
import { userById } from '../repos/users';
import { upNextView, withUpNext } from '../services/next-book';

export function clubDetail(ctx: AppContext, request: FastifyRequest, clubId: string, userId: string): ClubDetail {
  const club = clubById(ctx.db, clubId)!;
  const m = membership(ctx.db, clubId, userId)!;
  const list = members(ctx.db, clubId);
  // Every member may bring a friend with the club's link (D40); only owners renew it.
  const invite = activeInvite(ctx.db, clubId);
  return {
    id: club.id,
    name: club.name,
    description: club.description,
    role: m.role,
    memberCount: list.length,
    bookCount: Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM books WHERE club_id = ? AND deleted_at IS NULL', [clubId])?.n ?? 0),
    members: list,
    invite: invite ? { code: invite.code, url: `${publicOrigin(ctx, request)}/join/${invite.code}` } : null,
    createdAt: isoRequired(club.created_at),
    plan: planView(ctx, clubId, m.role === 'owner'),
    upNext: upNextView(ctx.db, clubId),
  };
}

export function clubRoutes(app: FastifyInstance, ctx: AppContext): void {
  const previewLimiter = new RateLimiter(60, 15 * 60_000);
  const acceptLimiter = new RateLimiter(30, 15 * 60_000);

  app.get('/api/clubs', async (request) => withUpNext(ctx.db, clubsForUser(ctx.db, requireUser(request).id)));

  // Any signed-in account may start a club (reversing D52's "an upstream account needs an invite
  // first" restriction: Cole's call, every account — local or upstream — starts clubs the same
  // way, no per-account cap). Clubs stay invite-only to join, same as ever; this is only about who
  // may create one.
  app.post('/api/clubs', async (request, reply) => {
    const user = requireUser(request);
    const body = parse(CreateClubBodySchema, request.body);
    // Anyone may start a club (D176, reversing D52's invite-first rule), up to a few at once:
    // each club brings its own Cal budget, storage and invite link.
    if (clubsOwnedBy(ctx.db, user.id) >= ctx.config.CLUBS_OWNED_MAX) {
      throw new HttpError(409, 'club_limit', `You already own ${ctx.config.CLUBS_OWNED_MAX} clubs. Hand one to another member or delete one to start another.`);
    }
    const club = createClub(ctx.db, { name: body.name, description: body.description ?? '', ownerId: user.id });
    return reply.code(201).send(clubDetail(ctx, request, club.id, user.id));
  });

  app.get<{ Params: { clubId: string } }>('/api/clubs/:clubId', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireMember(ctx.db, clubId, user.id);
    return clubDetail(ctx, request, clubId, user.id);
  });

  app.patch<{ Params: { clubId: string } }>('/api/clubs/:clubId', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireOwner(ctx.db, clubId, user.id);
    updateClub(ctx.db, clubId, parse(UpdateClubBodySchema, request.body));
    ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
    return clubDetail(ctx, request, clubId, user.id);
  });

  /**
   * Disband the club (D179): an owner ends it for everyone, even as its only owner; its books,
   * notes and chat go with it. A soft delete: the server keeps it all, and its admin can bring it
   * back. Members keep their accounts and their other clubs.
   */
  app.delete<{ Params: { clubId: string } }>('/api/clubs/:clubId', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireOwner(ctx.db, clubId, user.id);
    disbandClub(ctx, clubId, user.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { clubId: string } }>('/api/clubs/:clubId/invite/rotate', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    requireOwner(ctx.db, clubId, user.id);
    const invite = rotateInvite(ctx.db, clubId, user.id);
    return { code: invite.code, url: `${publicOrigin(ctx, request)}/join/${invite.code}` };
  });

  /** Remove a member (owner) or leave (anyone, about themselves). */
  app.delete<{ Params: { clubId: string; userId: string } }>('/api/clubs/:clubId/members/:userId', async (request, reply) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    const targetId = parse(IdSchema, request.params.userId);
    const access = requireMember(ctx.db, clubId, user.id);
    const self = targetId === user.id;
    if (!self && access.membership.role !== 'owner') throw forbidden('Only the club owner can remove members.');
    const target = membership(ctx.db, clubId, targetId);
    if (!target) throw notFound('Member not found.');
    if (target.role === 'owner' && ownerCount(ctx.db, clubId) <= 1) {
      throw badRequest('A club needs an owner. Make someone else owner first.');
    }
    removeMember(ctx.db, clubId, targetId);
    endClubVoiceFor(ctx, clubId, targetId);
    ctx.hub.revoke(clubId, targetId);
    // Someone the owner removed must not walk back in with the link they had.
    if (!self) {
      rotateInvite(ctx.db, clubId, user.id);
      ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
    }
    return reply.code(204).send();
  });

  app.put<{ Params: { clubId: string; userId: string }; Body: { role?: unknown } }>('/api/clubs/:clubId/members/:userId/role', async (request) => {
    const user = requireUser(request);
    const clubId = parse(IdSchema, request.params.clubId);
    const targetId = parse(IdSchema, request.params.userId);
    requireOwner(ctx.db, clubId, user.id);
    const role = request.body?.role;
    if (role !== 'owner' && role !== 'member') throw badRequest('Role must be owner or member.');
    if (!membership(ctx.db, clubId, targetId)) throw notFound('Member not found.');
    if (role === 'member' && ownerCount(ctx.db, clubId) <= 1 && membership(ctx.db, clubId, targetId)?.role === 'owner') {
      throw badRequest('A club needs an owner.');
    }
    setRole(ctx.db, clubId, targetId, role);
    ctx.hub.publish(clubId, () => ({ type: 'club:changed', clubId }));
    return clubDetail(ctx, request, clubId, user.id);
  });

  /** The owner issues a one-time password reset link for a member (no email needed). */
  app.post<{ Params: { clubId: string; userId: string } }>(
    '/api/clubs/:clubId/members/:userId/reset-link',
    async (request): Promise<z.infer<typeof ResetLinkSchema>> => {
      const user = requireUser(request);
      const clubId = parse(IdSchema, request.params.clubId);
      const targetId = parse(IdSchema, request.params.userId);
      requireOwner(ctx.db, clubId, user.id);
      if (!membership(ctx.db, clubId, targetId)) throw notFound('Member not found.');
      const target = userById(ctx.db, targetId);
      // Nothing to reset for an account with no password of its own: the upstream grant's (D116)
      // or a native Apple/Google sign-in with no password kept alongside it (D178) — a password
      // on file always wins (repos/users.ts's toUser follows the same rule).
      if (!target || (target.password_hash === null && (target.upstream_subject || hasExternalIdentity(ctx.db, targetId)))) {
        throw badRequest('This member has no password here to reset.');
      }
      // A reset link opens the whole account: only someone who runs every club it is in may make one.
      if (clubsForUser(ctx.db, targetId).some((c) => membership(ctx.db, c.id, user.id)?.role !== 'owner')) {
        throw forbidden(`${target.display_name} is also in a club you do not run. The server's admin can make a reset link for them (bookclub reset-link).`);
      }
      const { token, expiresAt } = issueResetLink(ctx.db, targetId, user.id);
      return { url: `${publicOrigin(ctx, request)}/reset/${token}`, expiresAt: isoRequired(expiresAt) };
    },
  );

  /** Public: what the invite is for, shown before signing in or up. */
  app.get<{ Params: { code: string } }>('/api/invites/:code', async (request): Promise<InvitePreview> => {
    if (!previewLimiter.attempt(`${request.ip}|${String(request.params.code)}`)) throw tooMany();
    const invite = inviteByCode(ctx.db, String(request.params.code));
    const club = invite ? clubById(ctx.db, invite.club_id) : undefined;
    if (!invite || !club) throw new HttpError(404, 'invite_invalid', 'This invite link is no longer valid. Ask for a new one.');
    const inviter = userById(ctx.db, invite.created_by);
    return { clubName: club.name, inviterName: inviter?.display_name ?? 'A friend', memberCount: members(ctx.db, club.id).length };
  });

  /** Signed in already: join the club. */
  app.post<{ Params: { code: string } }>('/api/invites/:code/accept', async (request) => {
    const user = requireUser(request);
    if (!acceptLimiter.attempt(user.id) || !acceptLimiter.attempt(`ip:${request.ip}`)) throw tooMany();
    const invite = inviteByCode(ctx.db, String(request.params.code));
    if (!invite) throw new HttpError(404, 'invite_invalid', 'This invite link is no longer valid. Ask for a new one.');
    // A club at its plan's member limit takes nobody new (D208); someone already in it just goes in.
    if (!membership(ctx.db, invite.club_id, user.id)) assertRoomToJoin(ctx, invite.club_id);
    const added = addMember(ctx.db, invite.club_id, user.id);
    if (added) {
      countInviteUse(ctx.db, invite.code);
      ctx.hub.publish(invite.club_id, () => ({ type: 'club:changed', clubId: invite.club_id }));
    }
    return { clubId: invite.club_id, joined: added };
  });
}
