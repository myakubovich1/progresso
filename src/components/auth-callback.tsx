'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AuthLayout } from './auth-panel';
import { browserSupabase } from '@/lib/client/api';
import {
  authError,
  completeAuthCallback,
  parseAuthCallback,
  type AuthCallback as CallbackInput,
} from '@/lib/client/auth';

export function AuthCallback() {
  const [state, setState] = useState<'loading' | 'confirm' | 'password' | 'done' | 'error'>(
    'loading',
  );
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const input = useRef<CallbackInput | null>(null);
  const pending = useRef<Promise<{ recovery: boolean }> | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    if (!input.current) {
      input.current = parseAuthCallback(window.location.href);
      // Remove one-time credentials before other navigation and do not retain them in history.
      window.history.replaceState(null, '', '/auth/callback');
    }
    const credential = input.current;
    if (credential.kind === 'error') {
      setError(credential.message);
      setState('error');
    } else if (credential.kind === 'email') {
      // An explicit click avoids consuming email links merely by opening a scanner/preview.
      setRecovery(credential.type === 'recovery');
      setState('confirm');
    } else {
      // Share the exchange across React Strict Mode's effect replay. Codes are single use.
      pending.current ??= Promise.resolve().then(() =>
        completeAuthCallback(browserSupabase(), credential),
      );
      pending.current
        .then((result) => {
          if (!active) return;
          if (result.recovery) setState('password');
          else window.location.replace('/');
        })
        .catch((e) => {
          if (active) {
            setError(authError(e));
            setState('error');
          }
        });
    }
    return () => {
      active = false;
    };
  }, []);
  const confirm = async () => {
    if (submitting.current || !input.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await completeAuthCallback(browserSupabase(), input.current);
      if (result.recovery) setState('password');
      else window.location.replace('/');
    } catch (e) {
      setError(authError(e));
      setState('error');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    if (password !== confirmPassword) {
      setError('Your passwords do not match. Please try again.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const { error } = await browserSupabase().auth.updateUser({ password });
      if (error) throw error;
      setPassword('');
      setConfirmPassword('');
      setState('done');
    } catch (e) {
      setError(authError(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <AuthLayout>
      <span className="eyebrow">YOUR SPACE TO GROW</span>
      <h2>
        {state === 'password'
          ? 'A fresh start.'
          : state === 'done'
            ? 'Password updated.'
            : state === 'error'
              ? 'Let’s try that again.'
              : state === 'confirm'
                ? 'One more step.'
                : 'Finishing your sign-in…'}
      </h2>
      {state === 'loading' && <p role="status">Securely opening your Progresso account…</p>}
      {state === 'confirm' && (
        <>
          <p>
            {recovery
              ? 'Continue to choose a new password for your account.'
              : 'Confirm your email to open your personal space.'}
          </p>
          <button disabled={busy} onClick={confirm}>
            {busy ? 'Confirming…' : 'Continue securely'}
          </button>
        </>
      )}
      {state === 'password' && (
        <form onSubmit={reset} aria-busy={busy}>
          <p>Choose a new password with at least 8 characters.</p>
          <fieldset className="auth-fields" disabled={busy}>
            <label htmlFor="new-password">New password</label>
            <div className="password-field">
              <input
                id="new-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
            <label htmlFor="confirm-password">Confirm new password</label>
            <input
              id="confirm-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={8}
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            <button type="submit">{busy ? 'Saving…' : 'Save new password'}</button>
          </fieldset>
        </form>
      )}
      {error && (
        <p className="error auth-feedback" role="alert">
          {error}
        </p>
      )}
      {state === 'error' && (
        <p>
          Return to sign in to try Google again, resend a confirmation email, or reset your
          password. If you already confirmed your email, sign in normally.
        </p>
      )}
      {state === 'done' && <p role="status">Your new password is ready. Continue to your space.</p>}
      {(state === 'error' || state === 'done') && (
        <Link className="auth-link-button" href="/" prefetch={false}>
          {state === 'done' ? 'Continue to Progresso ↗' : 'Back to sign in'}
        </Link>
      )}
    </AuthLayout>
  );
}
