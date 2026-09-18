import type { SupabaseClient } from '@supabase/supabase-js';

export const RESEND_SECONDS = 60;
export const callbackUrl = (origin: string) => new URL('/auth/callback', origin).href;

// Deliberately do not expose raw provider messages or URL error descriptions.
export function authError(error: unknown): string {
  const value = error as { code?: string; status?: number; name?: string } | null;
  if (
    value?.status === 429 ||
    ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(value?.code ?? '')
  )
    return 'Too many attempts. Please wait a minute before trying again.';
  switch (value?.code) {
    case 'invalid_credentials':
      return 'That email and password do not match. Try again or reset your password.';
    case 'email_not_confirmed':
      return 'Confirm your email before signing in. You can request a new email below.';
    case 'user_already_exists':
    case 'email_exists':
      return 'Try signing in with this email, or reset your password.';
    case 'weak_password':
      return 'Choose a stronger password with at least 8 characters, including letters and numbers.';
    case 'same_password':
      return 'Choose a password different from your current one.';
    case 'otp_expired':
      return 'This link has expired or has already been used. Request a new email and use the latest link.';
    case 'bad_code_verifier':
    case 'flow_state_not_found':
    case 'flow_state_expired':
    case 'pkce_verifier_not_found':
      return 'This sign-in link could not be completed. Open it in the browser where you started, or request a new email.';
    case 'provider_disabled':
    case 'validation_failed':
      return 'This sign-in option is temporarily unavailable. Try signing in with email.';
  }
  if (value?.name === 'AuthPKCECodeVerifierMissingError')
    return 'Open this link in the browser where you started, or request a new confirmation email.';
  if (value?.name === 'AuthRetryableFetchError' || value?.name === 'TypeError')
    return 'We could not connect. Check your connection and try again.';
  return 'We could not complete that request. Please try again.';
}

export type AuthCallback =
  | { kind: 'code'; code: string; flowId?: string }
  | { kind: 'email'; tokenHash: string; type: 'email' | 'recovery' }
  | { kind: 'error'; message: string };

export function parseAuthCallback(href: string): AuthCallback {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const error = url.searchParams.get('error') || hash.get('error');
  if (error)
    return {
      kind: 'error',
      message:
        error === 'access_denied'
          ? 'Sign-in was cancelled or the link is no longer valid. You can try again below.'
          : 'We could not complete this sign-in. Please start again.',
    };
  const code = url.searchParams.get('code');
  if (code) return { kind: 'code', code, flowId: url.searchParams.get('sb_flow_id') || undefined };
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  if (tokenHash && (type === 'email' || type === 'recovery'))
    return { kind: 'email', tokenHash, type };
  return {
    kind: 'error',
    message: 'This link is incomplete or no longer valid. Sign in or request a new email.',
  };
}

export async function completeAuthCallback(client: SupabaseClient, input: AuthCallback) {
  if (input.kind === 'error') throw new Error(input.message);
  const result =
    input.kind === 'code'
      ? await client.auth.exchangeCodeForSession(
          input.code,
          input.flowId ? { flowId: input.flowId } : undefined,
        )
      : await client.auth.verifyOtp({ token_hash: input.tokenHash, type: input.type });
  if (result.error) throw result.error;
  if (!result.data.session) throw new Error('No session');
  return {
    recovery:
      input.kind === 'email'
        ? input.type === 'recovery'
        : 'redirectType' in result.data && result.data.redirectType === 'recovery',
  };
}
