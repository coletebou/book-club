import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { AuthLayout, Field, FormError, fieldErrors } from '../components/Form';
import { api } from '../lib/api';
import { useSession } from '../lib/queries';

/**
 * "Start a club" with no invite (D211), at `/start`: the landing page's primary door, and the
 * only way `OPEN_SIGNUP` actually does anything. One form — a name, email, password and a club
 * name — makes the account and the first club (as its owner) in one request and signs the
 * person straight in, landing on the club's own settings page where the invite link they will
 * want to share next is already waiting (`?welcome=1`, ClubSettingsPage.tsx).
 *
 * Behind the setting, off by default: this page explains the instance keeps starting a club
 * invite-only too, and offers the two doors that always work (sign in, or open an invite link).
 */
export function StartPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const [form, setForm] = useState({ displayName: '', email: '', password: '', clubName: '' });
  const start = useMutation({
    mutationFn: () => api.startClub(form),
    onSuccess: async ({ clubId }) => {
      await qc.invalidateQueries();
      void navigate(`/clubs/${clubId}/settings?welcome=1`, { replace: true });
    },
  });

  // Already signed in: bounce home, unless this is our own mutation's session, which is already
  // on its way straight into the new club (`start.isSuccess` stays true once it has, so a
  // re-render racing the navigation above — the session query updating before this component has
  // unmounted — never overwrites it with this generic redirect).
  if (session.data?.user && !start.isSuccess) return <Navigate to="/" replace />;
  if (session.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (session.isPending) {
    return (
      <AuthLayout title="Start a club">
        <div className="spinner" role="status" aria-label="Loading" />
      </AuthLayout>
    );
  }
  if (!session.data?.openSignup) {
    return (
      <AuthLayout title="This instance is invite-only" subtitle="Its owner has not turned on starting a club without an invite.">
        <div className="row">
          <Link className="btn btn-primary" to="/signin">
            Sign in
          </Link>
        </div>
        <p className="faint small auth-foot">Have an invite link or code from a friend? Open it — it works whether or not you have an account yet.</p>
      </AuthLayout>
    );
  }

  const errors = fieldErrors(start.error);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const onSubmit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    start.mutate();
  };
  return (
    <AuthLayout title="Start a club" subtitle="Your account and your first club, in one step. You will get an invite link to share with friends next.">
      <form className="form" onSubmit={onSubmit} noValidate>
        <FormError error={start.error} />
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
        <Field label="Club name" name="clubName" required value={form.clubName} onChange={set('clubName')} error={errors.clubName} placeholder="Thursday Readers" />
        <button type="submit" className="btn btn-primary" disabled={start.isPending}>
          {start.isPending ? 'Creating…' : 'Create my club'}
        </button>
      </form>
      <p className="faint small auth-foot">
        Already have an account? <Link to="/signin">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
