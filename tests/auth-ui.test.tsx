// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
const auth = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
  resend: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock('@/lib/client/api', () => ({ browserSupabase: () => ({ auth }) }));
import { AuthPanel, AuthGate } from '@/components/auth-panel';
import { AuthCallback } from '@/components/auth-callback';
let notify: (event: string, session: Session | null) => void;
const session = (id = 'alice', confirmed = true) =>
  ({
    user: {
      id,
      email: 'alice@example.com',
      email_confirmed_at: confirmed ? '2026-09-18' : undefined,
    },
  }) as Session;
beforeEach(() => {
  vi.resetAllMocks();
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  auth.onAuthStateChange.mockImplementation((callback) => {
    notify = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  auth.signUp.mockResolvedValue({ data: { session: null }, error: null });
  auth.resend.mockResolvedValue({ error: null });
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const fillCredentials = () => {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: 'alice@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Password', { exact: true }), {
    target: { value: 'a-long-password' },
  });
};
it('separates signup from sign-in, submits a callback, and offers a throttled resend', async () => {
  render(<AuthPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  fillCredentials();
  expect(
    (screen.getByLabelText('Password', { exact: true }) as HTMLInputElement).autocomplete,
  ).toBe('new-password');
  fireEvent.click(screen.getByRole('button', { name: 'Create account ↗' }));
  await screen.findByRole('heading', { name: 'Check your inbox.' });
  expect(auth.signUp).toHaveBeenCalledWith(
    expect.objectContaining({
      email: 'alice@example.com',
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    }),
  );
  expect(
    (screen.getByRole('button', { name: /Resend available/ }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByLabelText('Password', { exact: true })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Back to sign in/ }));
  expect((screen.getByLabelText('Password', { exact: true }) as HTMLInputElement).value).toBe('');
});
it('prevents duplicate submissions while waiting for signup', async () => {
  let finish!: (value: unknown) => void;
  auth.signUp.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AuthPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  fillCredentials();
  const form = screen.getByRole('button', { name: 'Create account ↗' }).closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(auth.signUp).toHaveBeenCalledTimes(1);
  await act(async () => finish({ data: { session: null }, error: null }));
});
it('guides unconfirmed users to verification and handles resend rate limits', async () => {
  auth.signInWithPassword.mockResolvedValue({ error: { code: 'email_not_confirmed' } });
  auth.resend.mockResolvedValue({ error: { status: 429 } });
  render(<AuthPanel />);
  fillCredentials();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in ↗' }));
  await screen.findByRole('heading', { name: 'Check your inbox.' });
  fireEvent.click(screen.getByRole('button', { name: 'Resend confirmation email' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('wait a minute'));
  expect(auth.resend).toHaveBeenCalledWith({
    type: 'signup',
    email: 'alice@example.com',
    options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
  });
  expect(
    (screen.getByRole('button', { name: /Resend available/ }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('makes resend available after the cooldown', async () => {
  vi.useFakeTimers();
  render(<AuthPanel unverifiedEmail="alice@example.com" />);
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Resend confirmation email' })),
  );
  for (let second = 0; second < 60; second++) await act(async () => vi.advanceTimersByTime(1000));
  expect(
    (screen.getByRole('button', { name: 'Resend confirmation email' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it('starts Google OAuth with the fixed callback and explains provider failures', async () => {
  auth.signInWithOAuth.mockResolvedValue({ error: { code: 'provider_disabled' }, data: {} });
  render(<AuthPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
  await screen.findByRole('alert');
  expect(auth.signInWithOAuth).toHaveBeenCalledWith({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      skipBrowserRedirect: true,
      queryParams: { prompt: 'select_account' },
    },
  });
  expect(screen.getByRole('alert').textContent).toContain('Try signing in with email');
});
it('supports showing a password and keeps normal sign-in compatible with existing passwords', () => {
  render(<AuthPanel />);
  expect(
    (screen.getByLabelText('Password', { exact: true }) as HTMLInputElement).hasAttribute(
      'minlength',
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
  expect((screen.getByLabelText('Password', { exact: true }) as HTMLInputElement).type).toBe(
    'text',
  );
});
it('offers password recovery without exposing account existence', async () => {
  auth.resetPasswordForEmail.mockResolvedValue({ error: null });
  render(<AuthPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: 'alice@example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
  await screen.findByRole('heading', { name: 'Check your inbox.' });
  expect(screen.getByText(/If an account exists/)).toBeTruthy();
  expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('alice@example.com', {
    redirectTo: `${window.location.origin}/auth/callback`,
  });
});
it('unmounts private workspace state on sign-out and account changes', async () => {
  function Workspace() {
    const [value, setValue] = useState('empty');
    return <button onClick={() => setValue('private-history')}>{value}</button>;
  }
  render(<AuthGate>{(id) => <Workspace key={id} />}</AuthGate>);
  await screen.findByRole('heading', { name: 'Welcome back.' });
  act(() => notify('SIGNED_IN', session()));
  fireEvent.click(screen.getByRole('button', { name: 'empty' }));
  act(() => notify('SIGNED_IN', session('bob')));
  expect(screen.queryByText('private-history')).toBeNull();
  act(() => notify('SIGNED_OUT', null));
  expect(screen.queryByRole('button', { name: 'empty' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Welcome back.' })).toBeTruthy();
});
it('does not mount the workspace for unverified sessions', async () => {
  auth.getSession.mockResolvedValue({ data: { session: session('alice', false) }, error: null });
  render(<AuthGate>{() => <p>private-history</p>}</AuthGate>);
  await screen.findByRole('heading', { name: 'Check your inbox.' });
  expect(screen.queryByText('private-history')).toBeNull();
});
it('does not let an older session read override a newer sign-out event', async () => {
  let finish!: (value: unknown) => void;
  auth.getSession.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AuthGate>{() => <p>private-history</p>}</AuthGate>);
  act(() => notify('SIGNED_OUT', null));
  await act(async () => finish({ data: { session: session() }, error: null }));
  expect(screen.queryByText('private-history')).toBeNull();
});
it('scrubs callback credentials, exchanges once in Strict Mode, and shows recovery', async () => {
  window.history.replaceState(null, '', '/auth/callback?code=one-time&sb_flow_id=flow-123');
  auth.exchangeCodeForSession.mockResolvedValue({
    data: { session: session(), redirectType: 'recovery' },
    error: null,
  });
  render(
    <StrictMode>
      <AuthCallback />
    </StrictMode>,
  );
  await screen.findByRole('heading', { name: 'A fresh start.' });
  expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe('');
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: 'different-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
  expect(auth.updateUser).not.toHaveBeenCalled();
  auth.updateUser.mockResolvedValue({ error: null });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: 'new-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
  await screen.findByRole('heading', { name: 'Password updated.' });
  expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new-password' });
});
it('does not consume email tokens until the user confirms, then handles expired tokens', async () => {
  window.history.replaceState(null, '', '/auth/callback?token_hash=one-time&type=email');
  auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { code: 'otp_expired' } });
  render(<AuthCallback />);
  await screen.findByRole('button', { name: 'Continue securely' });
  expect(auth.verifyOtp).not.toHaveBeenCalled();
  expect(window.location.search).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Continue securely' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('expired');
  expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe('/');
});
