import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { AuthLayout, Field, FormError, fieldErrors } from '../components/Form';
import { api } from '../lib/api';
import { keys, useSession } from '../lib/queries';

/** First run: the person setting up the instance creates the owner account and first club. */
export function SetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const [form, setForm] = useState({ displayName: '', email: '', password: '', clubName: '' });
  const setup = useMutation({
    mutationFn: () => api.setup({ ...form, ...(form.clubName.trim() ? { clubName: form.clubName.trim() } : {}) }),
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: keys.session });
      const club = data.clubs[0];
      void navigate(club ? `/clubs/${club.id}` : '/', { replace: true });
    },
  });
  if (session.data && !session.data.setupRequired) return <Navigate to="/" replace />;
  const errors = fieldErrors(setup.error);
  const onSubmit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    setup.mutate();
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <AuthLayout title="Set up Book Club" subtitle="Create your account and your first club. You will invite friends next.">
      <form className="form" onSubmit={onSubmit} noValidate>
        <FormError error={setup.error} />
        <Field label="Your name" name="displayName" autoComplete="name" required value={form.displayName} onChange={set('displayName')} error={errors.displayName} />
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
        <Field label="Club name" name="clubName" placeholder="Thursday Readers" value={form.clubName} onChange={set('clubName')} error={errors.clubName} />
        <button type="submit" className="btn btn-primary" disabled={setup.isPending}>
          {setup.isPending ? 'Setting up…' : 'Create my club'}
        </button>
      </form>
    </AuthLayout>
  );
}
