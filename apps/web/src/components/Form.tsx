import { type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useId } from 'react';
import { ApiError, upstreamSignInHref } from '../lib/api';
import { UpstreamMark } from './ProviderIcons';

export function Field({
  label,
  error,
  hint,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined; hint?: ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // An error takes the hint's place: the two would often say the same thing twice.
  const showHint = !!hint && !error;
  const describedBy = [showHint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {showHint ? (
        <span id={hintId} className="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A labelled multi-line field (a club's description). */
export function TextArea({ label, hint, ...input }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} aria-describedby={hint ? hintId : undefined} {...input} />
      {hint ? (
        <span id={hintId} className="hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError ? err.fields : {};
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="form-error" role="alert">
      {errorMessage(error)}
    </div>
  );
}

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <div className="auth-brand" aria-hidden="true">
          <img src="/favicon.svg" alt="" width={40} height={40} />
          <span className="auth-brand-name">Book Club</span>
        </div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted auth-subtitle">{subtitle}</p> : null}
        {children}
      </div>
    </main>
  );
}

/** Icon left, label centred: the shape every provider sign-in button shares (D178). */
export function ProviderButtonContent({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <>
      <span className="btn-provider-icon">{icon}</span>
      <span className="btn-provider-label">{children}</span>
    </>
  );
}

/**
 * The way in for friends who already have an account upstream (D14 and D116): the server
 * sends them to its sign-in, where they may be signed in already, and they come back here signed in.
 * Styled as a neutral provider button with a generic sign-in mark (D178) — the "or" divider that used
 * to live here is now the caller's, since it sits below the whole stack of provider buttons, not
 * just this one.
 */
export function UpstreamSignIn({ name, next, refused = false }: { name: string; next: string; refused?: boolean }) {
  return (
    <>
      {refused ? (
        <div className="form-error" role="alert">
          {name.charAt(0).toUpperCase() + name.slice(1)} did not sign you in here. Try again, or ask your club owner.
        </div>
      ) : null}
      <a className="btn-provider btn-upstream" href={upstreamSignInHref(next)} data-testid="upstream-signin">
        <ProviderButtonContent icon={<UpstreamMark />}>Continue with {name}</ProviderButtonContent>
      </a>
    </>
  );
}
