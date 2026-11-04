import { appPath } from '@bookclub/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { requestAppleSignIn, requestGoogleSignIn } from '../auth/native-auth-bridge';
import { AuthLayout, Field, FormError, ProviderButtonContent, UpstreamSignIn } from '../components/Form';
import { runningInstalled } from '../components/InstallHint';
import { AppleMark, GoogleMark } from '../components/ProviderIcons';
import { api, googleSignInHref } from '../lib/api';
import { isNativeApp } from '../player/native-bridge';
import { keys, useSession } from '../lib/queries';

/** The native bridge's own marker for "the person dismissed the sheet": never shown as an error. */
const CANCELED = 'canceled';

/** Only same-app paths are followed after sign-in, read as the browser will read them (appPath). */
export function safeNext(next: string | null): string {
  return appPath(next) ?? '/';
}

export function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [withCode, setWithCode] = useState(false);
  const [code, setCode] = useState('');
  const signedIn = async () => {
    await qc.invalidateQueries();
    await qc.refetchQueries({ queryKey: keys.session });
    void navigate(next, { replace: true });
  };
  const signIn = useMutation({ mutationFn: () => api.signIn({ email, password }), onSuccess: signedIn });
  const codeSignIn = useMutation({ mutationFn: () => api.signInWithCode(code), onSuccess: signedIn });
  // Native "Sign in with Apple" (D178): the app bridge gets the identity token in-process; a
  // dismissed sheet (CANCELED) is not an error worth showing.
  const appleSignIn = useMutation({
    mutationFn: async () => {
      const result = await requestAppleSignIn();
      if (!result.ok) throw new Error(result.reason);
      return api.signInApple({ identityToken: result.identityToken, nonce: result.nonce, fullName: result.fullName });
    },
    onSuccess: signedIn,
  });
  // "Continue with Google" from inside the app (D178): native opens and closes a browser session
  // around Google's own pages and hands back a one-time code, redeemed here inside the WebView
  // so the session cookie lands in its own cookie store (D133), not that ephemeral session's.
  const googleAppSignIn = useMutation({
    mutationFn: async () => {
      const result = await requestGoogleSignIn();
      if (!result.ok) throw new Error(result.reason);
      return api.redeemAppCode({ code: result.code, verifier: result.verifier });
    },
    onSuccess: signedIn,
  });
  const upstream = session.data?.upstream;
  const providers = session.data?.providers;
  const native = isNativeApp();
  // Whether any "continue elsewhere" button renders at all, so the "or" divider below never floats
  // above a form with nothing above it to divide (D178's redesign: one divider for the whole stack,
  // not one per button).
  const appleShown = native && !!providers?.apple;
  const googleShown = !!providers?.google;
  const upstreamShown = !!upstream && !native;
  const anyProviderShown = appleShown || googleShown || upstreamShown;

  if (session.data?.user) return <Navigate to={next} replace />;
  if (session.data?.setupRequired) return <Navigate to="/setup" replace />;

  const onSubmit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    signIn.mutate();
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your book club.">
      {/*
       * Native "Sign in with Apple" and "Continue with Google" (D178), replacing the in-app need
       * for the upstream round trip above: inside the app, native runs the whole sign-in itself
       * (Apple fully in-process; Google through a browser session native opens and closes around
       * it) and this page only redeems what comes back. In a browser, Apple stays hidden — no
       * Services ID is configured for a web flow this change does not build — and Google goes
       * through the same server-side redirect the upstream grant above uses, just to Google
       * instead of the upstream. Each button follows its own platform's sign-in button standard
       * (Apple's HIG black/white, Google's neutral surface with its four-colour mark, a plain mark
       * for the upstream on a matching neutral button) rather than one generic filled style for all three.
       */}
      {anyProviderShown ? (
        <div className="auth-providers">
          {appleShown ? (
            <button type="button" className="btn-provider btn-apple" onClick={() => appleSignIn.mutate()} disabled={appleSignIn.isPending} data-testid="apple-signin">
              <ProviderButtonContent icon={<AppleMark />}>{appleSignIn.isPending ? 'Signing in…' : 'Sign in with Apple'}</ProviderButtonContent>
            </button>
          ) : null}
          {native && googleShown ? (
            <button type="button" className="btn-provider btn-google" onClick={() => googleAppSignIn.mutate()} disabled={googleAppSignIn.isPending} data-testid="google-signin">
              <ProviderButtonContent icon={<GoogleMark />}>{googleAppSignIn.isPending ? 'Signing in…' : 'Continue with Google'}</ProviderButtonContent>
            </button>
          ) : !native && googleShown ? (
            <a className="btn-provider btn-google" href={googleSignInHref(next)} data-testid="google-signin">
              <ProviderButtonContent icon={<GoogleMark />}>Continue with Google</ProviderButtonContent>
            </a>
          ) : null}
          {upstreamShown ? <UpstreamSignIn name={upstream.name} next={next} refused={params.get('upstream') === 'refused'} /> : null}
        </div>
      ) : null}
      {appleSignIn.error && appleSignIn.error.message !== CANCELED ? <div className="form-error" role="alert">Sign in with Apple did not finish. Try again.</div> : null}
      {googleAppSignIn.error && googleAppSignIn.error.message !== CANCELED ? <div className="form-error" role="alert">Continue with Google did not finish. Try again.</div> : null}
      {params.get('google') === 'refused' ? <div className="form-error" role="alert">Google did not sign you in here. Try again, or ask your club owner.</div> : null}
      {!upstreamShown && upstream && params.get('upstream') === 'refused' ? (
        // Its callback (also used from the invite page, components/Form.tsx) bounces a failure here
        // with this query param: a friend arriving that way still gets told why. UpstreamSignIn
        // shows this itself when its own button renders (upstreamShown); this covers the app, where
        // it does not.
        <div className="form-error" role="alert">
          {upstream.name.charAt(0).toUpperCase() + upstream.name.slice(1)} did not sign you in here. Try again, or ask your club owner.
        </div>
      ) : null}
      {upstream && runningInstalled() ? (
        // On a Home Screen, iOS may finish another site's sign-in in a sheet whose cookies are not this app's (D87).
        <p className="muted small" data-testid="home-screen-hint">
          Back here after signing in with {upstream.name}? In Safari, sign in to Book Club, get a code in Settings and type it under “Sign in with a code”.
        </p>
      ) : null}
      {anyProviderShown ? <p className="auth-or faint small">or sign in with your email</p> : null}
      <form className="form" onSubmit={onSubmit} noValidate>
        <FormError error={signIn.error} />
        <Field label="Email" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {upstream?.password ? (
          // D173: typed straight in here, checked at the upstream, no trip to its own page (the
          // iOS app's WebView cannot bounce there and come back).
          <p className="muted small" data-testid="upstream-password-hint">
            Your {upstream.name} email and password work here too.
          </p>
        ) : null}
        <button type="submit" className="btn-signin" disabled={signIn.isPending}>
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {withCode ? (
        <form
          className="form"
          aria-labelledby="code-title"
          onSubmit={(e) => {
            e.preventDefault();
            codeSignIn.mutate();
          }}
          noValidate
        >
          <h2 id="code-title" className="auth-section-title">
            Sign in with a code
          </h2>
          <FormError error={codeSignIn.error} />
          <Field
            label="Sign-in code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            hint="Eight digits, from Settings where you are signed in."
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" className="btn-signin" disabled={codeSignIn.isPending}>
            {codeSignIn.isPending ? 'Signing in…' : 'Sign in with the code'}
          </button>
        </form>
      ) : (
        <p className="auth-code-link">
          <button type="button" className="link-text" onClick={() => setWithCode(true)} data-testid="use-code">
            Sign in with a code
          </button>
        </p>
      )}
      <p className="faint small auth-foot">New here? Ask a friend in the club for an invite link. Forgot your password? Your club owner can send you a reset link.</p>
    </AuthLayout>
  );
}
