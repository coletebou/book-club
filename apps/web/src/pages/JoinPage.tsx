import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AuthLayout, Field, FormError, ProviderButtonContent, UpstreamSignIn, errorMessage, fieldErrors } from '../components/Form';
import { GoogleMark } from '../components/ProviderIcons';
import { api, googleSignInHref } from '../lib/api';
import { keys, useSession } from '../lib/queries';

/**
 * Opening an invite link. Signed in: one tap to join, or, already in that club, one tap to open it.
 * Not signed in: continue with the upstream account if there is one (D52), create an account
 * (name, email, password) and join in one step, or sign in first.
 */
export function JoinPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const preview = useQuery({ queryKey: ['invite', code], queryFn: () => api.invitePreview(code), retry: false });
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  // Already in the club the link is for (it was sent to the whole group, or opened twice): it is
  // the invite one of your clubs shows its members (D40). Not knowing (offline), it offers to join.
  const signedIn = !!session.data?.user;
  const clubs = useQuery({ queryKey: keys.clubs, queryFn: api.clubs, enabled: signedIn });
  const details = useQueries({ queries: (clubs.data ?? []).map((c) => ({ queryKey: keys.club(c.id), queryFn: () => api.club(c.id) })) });
  const inClub = details.find((d) => d.data?.invite?.code === code)?.data;
  const checking = signedIn && [clubs, ...details].some((q) => q.isPending && !q.failureReason);

  const accept = useMutation({
    mutationFn: () => api.acceptInvite(code),
    onSuccess: async ({ clubId }) => {
      await qc.invalidateQueries({ queryKey: keys.clubs });
      void navigate(`/clubs/${clubId}`, { replace: true });
    },
  });
  const signUp = useMutation({
    mutationFn: () => api.signUp({ inviteCode: code, ...form }),
    onSuccess: async ({ clubId }) => {
      await qc.invalidateQueries();
      void navigate(`/clubs/${clubId}`, { replace: true });
    },
  });

  if (session.data?.user && inClub) {
    return (
      <AuthLayout title={`You are already in ${inClub.name}`} subtitle="This invite is for a club you are in: there is nothing to join.">
        <Link className="btn btn-primary" to={`/clubs/${inClub.id}`} replace>
          Open the club
        </Link>
      </AuthLayout>
    );
  }
  if (preview.isPending || session.isPending || checking) {
    return (
      <AuthLayout title="Opening your invite">
        <div className="spinner" role="status" aria-label="Loading" />
      </AuthLayout>
    );
  }
  if (preview.isError) {
    return (
      <AuthLayout title="This invite has expired" subtitle={errorMessage(preview.error)}>
        <Link className="btn" to="/signin">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }
  const invite = preview.data;
  const subtitle = `${invite.inviterName} invited you to read with ${invite.clubName} (${invite.memberCount} ${invite.memberCount === 1 ? 'reader' : 'readers'}).`;

  if (session.data?.user) {
    return (
      <AuthLayout title={`Join ${invite.clubName}`} subtitle={subtitle}>
        <FormError error={accept.error} />
        <button type="button" className="btn btn-primary" onClick={() => accept.mutate()} disabled={accept.isPending}>
          {accept.isPending ? 'Joining…' : `Join as ${session.data.user.displayName}`}
        </button>
      </AuthLayout>
    );
  }

  const errors = fieldErrors(signUp.error);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const onSubmit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    signUp.mutate();
  };
  const upstream = session.data?.upstream;
  // Google (D178), the browser redirect, next to the upstream grant's own: both are "continue with
  // an account elsewhere" buttons that land back here signed in, one tap from joining. Apple stays
  // off the web for now (docs/DECISIONS.md D178); native Apple/Google in the app are the sign-in
  // page's own concern, not the invite page's.
  const providers = session.data?.providers;
  const anyProviderShown = !!upstream || !!providers?.google;
  return (
    <AuthLayout title={`Join ${invite.clubName}`} subtitle={subtitle}>
      {anyProviderShown ? (
        <div className="auth-providers">
          {providers?.google ? (
            <a className="btn-provider btn-google" href={googleSignInHref(`/join/${code}`)} data-testid="google-signin">
              <ProviderButtonContent icon={<GoogleMark />}>Continue with Google</ProviderButtonContent>
            </a>
          ) : null}
          {upstream ? <UpstreamSignIn name={upstream.name} next={`/join/${code}`} /> : null}
        </div>
      ) : null}
      {anyProviderShown ? <p className="auth-or faint small">or make an account here</p> : null}
      <form className="form" onSubmit={onSubmit} noValidate>
        <FormError error={signUp.error} />
        <Field label="Your name" name="displayName" autoComplete="name" required value={form.displayName} onChange={set('displayName')} error={errors.displayName} hint="Friends will see this next to your comments." />
        <Field label="Email" type="email" name="email" autoComplete="email" required value={form.email} onChange={set('email')} error={errors.email} />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={10}
          hint="At least 10 characters."
          value={form.password}
          onChange={set('password')}
          error={errors.password}
        />
        <button type="submit" className={upstream ? 'btn' : 'btn btn-primary'} disabled={signUp.isPending}>
          {signUp.isPending ? 'Joining…' : 'Join the club'}
        </button>
      </form>
      <p className="faint small auth-foot">
        Already have an account? <Link to={`/signin?next=${encodeURIComponent(`/join/${code}`)}`}>Sign in to join</Link>
      </p>
    </AuthLayout>
  );
}
