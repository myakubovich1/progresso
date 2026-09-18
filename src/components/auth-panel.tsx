'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { browserSupabase } from '@/lib/client/api';
import { authError, callbackUrl, RESEND_SECONDS } from '@/lib/client/auth';

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="welcome auth-welcome">
      <div className="welcome-copy">
        <Link className="brand" href="/" prefetch={false}>
          progresso<span>↗</span>
        </Link>
        <p className="eyebrow">A LITTLE BETTER, EVERY DAY</p>
        <h1>
          Your health.
          <br />
          <em>A clear next step.</em>
        </h1>
        <p className="lede">
          Bring your health history together.
          <br />
          Build progress, one step at a time.
        </p>
        <div className="welcome-note">Your history, connected. Your progress, personal.</div>
      </div>
      <section className="login panel auth-panel" aria-label="Your Progresso account">
        {children}
      </section>
    </main>
  );
}

export function AuthGate({ children }: { children: (id: string) => ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let authEventReceived = false;
    const client = browserSupabase();
    // Keep this callback synchronous: calling Auth methods here can deadlock the SDK lock.
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, value) => {
      if (active) {
        authEventReceived = true;
        setSession(value);
        setReady(true);
      }
    });
    client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active || authEventReceived) return;
        if (error) setError(authError(error));
        setSession(data.session);
        setReady(true);
      })
      .catch((e) => {
        if (active) {
          setError(authError(e));
          setReady(true);
        }
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);
  if (!ready)
    return (
      <AuthLayout>
        <p role="status">Opening your space…</p>
      </AuthLayout>
    );
  if (session?.user.email_confirmed_at) return children(session.user.id);
  return (
    <AuthLayout>
      <AuthPanel
        key={session?.user.id ?? 'signed-out'}
        unverifiedEmail={session?.user.email}
        initialError={error}
      />
    </AuthLayout>
  );
}

type Mode = 'signin' | 'signup' | 'verify' | 'forgot' | 'reset-sent';
export function AuthPanel({
  unverifiedEmail,
  initialError = '',
}: {
  unverifiedEmail?: string;
  initialError?: string;
}) {
  const [mode, setMode] = useState<Mode>(unverifiedEmail ? 'verify' : 'signin');
  const [email, setEmail] = useState(unverifiedEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<'email' | 'google' | 'resend' | null>(null);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [mode]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const changeMode = (next: Mode) => {
    setMode(next);
    setError('');
    setMessage('');
    setPassword('');
    setShowPassword(false);
  };
  const run = async (action: NonNullable<typeof busy>, task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(action);
    setError('');
    setMessage('');
    try {
      await task();
    } catch (e) {
      setError(authError(e));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run('email', async () => {
      const client = browserSupabase();
      const address = email.trim();
      setEmail(address);
      if (mode === 'forgot') {
        const { error } = await client.auth.resetPasswordForEmail(address, {
          redirectTo: callbackUrl(window.location.origin),
        });
        if (error) throw error;
        setPassword('');
        setMode('reset-sent');
        setCooldown(RESEND_SECONDS);
        return;
      }
      const result =
        mode === 'signup'
          ? await client.auth.signUp({
              email: address,
              password,
              options: { emailRedirectTo: callbackUrl(window.location.origin) },
            })
          : await client.auth.signInWithPassword({ email: address, password });
      if (result.error) {
        if (result.error.code === 'email_not_confirmed') {
          setMode('verify');
          setPassword('');
        }
        throw result.error;
      }
      setPassword('');
      if (!result.data.session) {
        setMode('verify');
        setCooldown(RESEND_SECONDS);
      }
      // AuthGate handles successful sessions and routes new users into existing onboarding.
    });
  };
  const google = () =>
    void run('google', async () => {
      const { data, error } = await browserSupabase().auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: callbackUrl(window.location.origin),
          skipBrowserRedirect: true,
          queryParams: { prompt: 'select_account' },
        },
      });
      if (error) throw error;
      if (!data.url) throw new Error('Missing provider URL');
      window.location.assign(data.url);
    });
  const resend = () =>
    void run('resend', async () => {
      // Start cooldown even on failure so repeated clicks cannot hammer the provider.
      setCooldown(RESEND_SECONDS);
      const { error } = await browserSupabase().auth.resend({
        type: 'signup',
        email: email.trim(),
        options: { emailRedirectTo: callbackUrl(window.location.origin) },
      });
      if (error) throw error;
      setMessage(
        'If this address needs confirmation, a new email is on its way. Use the latest link.',
      );
    });
  const returnToSignIn = () =>
    void run('email', async () => {
      if (unverifiedEmail) {
        const { error } = await browserSupabase().auth.signOut({ scope: 'local' });
        if (error) throw error;
      }
      changeMode('signin');
    });
  const isForm = mode === 'signin' || mode === 'signup' || mode === 'forgot';
  return (
    <>
      <span className="eyebrow">YOUR SPACE TO GROW</span>
      <h2 ref={heading} tabIndex={-1}>
        {
          {
            signin: 'Welcome back.',
            signup: 'Start your next chapter.',
            verify: 'Check your inbox.',
            forgot: 'Forgot your password?',
            'reset-sent': 'Check your inbox.',
          }[mode]
        }
      </h2>
      <p className="auth-intro">
        {mode === 'signin' ? (
          'Sign in to pick up where you left off.'
        ) : mode === 'signup' ? (
          'Create your account. Your first step starts here.'
        ) : mode === 'forgot' ? (
          'We’ll send you a link to choose a new password.'
        ) : mode === 'verify' ? (
          <>
            Follow the confirmation link sent to <strong>{email}</strong> to finish creating your
            account.
          </>
        ) : (
          <>
            If an account exists for <strong>{email}</strong>, a password reset link is on its way.
          </>
        )}
      </p>
      {(mode === 'signin' || mode === 'signup') && (
        <>
          <button className="google-button" type="button" disabled={!!busy} onClick={google}>
            <GoogleMark />
            {busy === 'google' ? 'Connecting to Google…' : 'Continue with Google'}
          </button>
          <div className="auth-divider">
            <span>or continue with email</span>
          </div>
        </>
      )}
      {isForm && (
        <form onSubmit={submit} aria-busy={!!busy}>
          <fieldset disabled={!!busy} className="auth-fields">
            <label htmlFor="auth-email">Email address</label>
            <input
              id="auth-email"
              name="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            {mode !== 'forgot' && (
              <>
                <label htmlFor="auth-password">Password</label>
                <div className="password-field">
                  <input
                    id="auth-password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    minLength={mode === 'signup' ? 8 : undefined}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-describedby={mode === 'signup' ? 'password-hint' : undefined}
                  />
                  <button
                    className="password-toggle"
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                {mode === 'signup' && (
                  <p id="password-hint" className="auth-hint">
                    Use at least 8 characters. A longer, unique password is best.
                  </p>
                )}
              </>
            )}
            {mode === 'signin' && (
              <button
                type="button"
                className="text-button auth-forgot"
                onClick={() => changeMode('forgot')}
              >
                Forgot password?
              </button>
            )}
            <button className="auth-submit" type="submit">
              {busy === 'email'
                ? 'Please wait…'
                : mode === 'signup'
                  ? 'Create account ↗'
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : 'Sign in ↗'}
            </button>
          </fieldset>
        </form>
      )}
      {mode === 'verify' && (
        <div className="verification-actions">
          <div className="auth-tip">
            Check your spam folder too. If you already confirmed your email on another device,
            return to sign in.
          </div>
          <button disabled={!!busy || cooldown > 0} onClick={resend}>
            {busy === 'resend'
              ? 'Sending…'
              : cooldown
                ? `Resend available in ${cooldown}s`
                : 'Resend confirmation email'}
          </button>
          <button className="secondary" disabled={!!busy} onClick={returnToSignIn}>
            Back to sign in / change email
          </button>
        </div>
      )}
      {mode === 'reset-sent' && (
        <div className="verification-actions">
          <div className="auth-tip">
            Check your spam folder and use the latest email. For the default reset email, open the
            link in this browser.
          </div>
          <button
            className="secondary"
            disabled={!!busy || cooldown > 0}
            onClick={() => changeMode('forgot')}
          >
            {cooldown ? `Try again in ${cooldown}s` : 'Send another reset email'}
          </button>
        </div>
      )}
      {error && (
        <p className="error auth-feedback" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="auth-feedback" role="status">
          {message}
        </p>
      )}
      {(mode === 'signin' || mode === 'signup') && (
        <p className="auth-switch">
          {mode === 'signin' ? 'New to Progresso?' : 'Already have an account?'}{' '}
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() => changeMode(mode === 'signin' ? 'signup' : 'signin')}
          >
            {mode === 'signin' ? 'Create account' : 'Sign in'}
          </button>
        </p>
      )}
      {(mode === 'forgot' || mode === 'reset-sent') && (
        <button className="text-button" disabled={!!busy} onClick={returnToSignIn}>
          Back to sign in
        </button>
      )}
      <p className="auth-footer">Small steps. A space that’s yours.</p>
    </>
  );
}

function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.61 4.61 0 0 1-2 3.03v2.52h3.24c1.9-1.75 2.98-4.33 2.98-7.38Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.39l-3.24-2.52c-.9.6-2.05.97-3.38.97-2.6 0-4.81-1.76-5.6-4.13H3.05v2.6A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.4 13.93A6 6 0 0 1 6.08 12c0-.67.11-1.32.32-1.93v-2.6H3.05A10 10 0 0 0 2 12c0 1.61.38 3.14 1.05 4.53l3.35-2.6Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.94c1.47 0 2.79.51 3.83 1.51L18.7 4.6A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.95 5.47l3.35 2.6C7.19 7.7 9.4 5.94 12 5.94Z"
      />
    </svg>
  );
}
