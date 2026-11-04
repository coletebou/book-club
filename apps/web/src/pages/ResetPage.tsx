import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { AuthLayout, Field, FormError, fieldErrors } from '../components/Form';
import { api } from '../lib/api';

export function ResetPage() {
  const { token = '' } = useParams();
  const [password, setPassword] = useState('');
  const reset = useMutation({ mutationFn: () => api.resetPassword({ token, newPassword: password }) });
  const onSubmit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    reset.mutate();
  };
  if (reset.isSuccess) {
    return (
      <AuthLayout title="Password changed" subtitle="You can sign in with your new password now.">
        <Link className="btn btn-primary" to="/signin">
          Sign in
        </Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password">
      <form className="form" onSubmit={onSubmit} noValidate>
        <FormError error={reset.error} />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          hint="At least 10 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors(reset.error).newPassword}
        />
        <button type="submit" className="btn btn-primary" disabled={reset.isPending}>
          Save password
        </button>
      </form>
    </AuthLayout>
  );
}
