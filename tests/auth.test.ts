import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseAuthCallback, completeAuthCallback, callbackUrl, authError } from '@/lib/client/auth';

describe('authentication callback', () => {
  it('uses a fixed same-origin return path, ignoring caller-supplied destinations', () => {
    expect(callbackUrl('https://progresso.example/path')).toBe(
      'https://progresso.example/auth/callback',
    );
    expect(
      parseAuthCallback('https://app.test/auth/callback?code=abc&next=https://evil.test'),
    ).toEqual({ kind: 'code', code: 'abc', flowId: undefined });
  });
  it('supports PKCE flow identifiers for concurrent sign-ins', async () => {
    const exchange = vi
      .fn()
      .mockResolvedValue({ data: { session: {}, redirectType: null }, error: null });
    const client = { auth: { exchangeCodeForSession: exchange } } as unknown as SupabaseClient;
    const result = await completeAuthCallback(
      client,
      parseAuthCallback('https://app.test/auth/callback?code=abc&sb_flow_id=flow-123'),
    );
    expect(exchange).toHaveBeenCalledWith('abc', { flowId: 'flow-123' });
    expect(result.recovery).toBe(false);
  });
  it('uses verified email token hashes for links opened on another device', async () => {
    const verify = vi.fn().mockResolvedValue({ data: { session: {} }, error: null });
    const client = { auth: { verifyOtp: verify } } as unknown as SupabaseClient;
    expect(
      await completeAuthCallback(
        client,
        parseAuthCallback('https://app.test/auth/callback?token_hash=secret&type=email'),
      ),
    ).toEqual({ recovery: false });
    expect(verify).toHaveBeenCalledWith({ token_hash: 'secret', type: 'email' });
  });
  it('recognizes recovery from the provider exchange', async () => {
    const client = {
      auth: {
        exchangeCodeForSession: vi
          .fn()
          .mockResolvedValue({ data: { session: {}, redirectType: 'recovery' }, error: null }),
      },
    } as unknown as SupabaseClient;
    expect(await completeAuthCallback(client, { kind: 'code', code: 'recovery-code' })).toEqual({
      recovery: true,
    });
  });
  it.each([
    '',
    '?token_hash=x&type=invite',
    '?token_hash=x&type=email_change',
    '#access_token=x&refresh_token=y',
  ])('rejects incomplete or unsupported callback %s', (query) => {
    expect(parseAuthCallback(`https://app.test/auth/callback${query}`).kind).toBe('error');
  });
  it('does not display untrusted provider error text', () => {
    const input = parseAuthCallback(
      'https://app.test/auth/callback?error=access_denied&error_description=SECRET',
    );
    expect(input.kind).toBe('error');
    expect(JSON.stringify(input)).not.toContain('SECRET');
    expect(authError({ message: 'SECRET' })).not.toContain('SECRET');
  });
  it('does not treat an expired code or missing session as success', async () => {
    const client = {
      auth: {
        exchangeCodeForSession: vi
          .fn()
          .mockResolvedValue({ data: { session: null }, error: { code: 'otp_expired' } }),
      },
    } as unknown as SupabaseClient;
    await expect(completeAuthCallback(client, { kind: 'code', code: 'expired' })).rejects.toEqual({
      code: 'otp_expired',
    });
    expect(authError({ code: 'otp_expired' })).toContain('latest link');
    expect(authError({ status: 429 })).toContain('wait a minute');
  });
});
