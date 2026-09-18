import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const getUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/repository', () => ({
  supabaseClient: vi.fn(() => ({ auth: { getUser } })),
  SupabaseRepository: class {
    constructor(public userId: string) {}
  },
  DemoRepository: class {},
}));
import { context } from '@/lib/server/context';
beforeEach(() => {
  vi.stubEnv('PROGRESSO_DEMO_MODE', 'false');
  getUser.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
const request = () =>
  new NextRequest('https://app.test/api/home', {
    headers: { authorization: 'Bearer signed-token' },
  });
it('blocks unconfirmed accounts on the server even if a client presents a valid session', async () => {
  getUser.mockResolvedValue({
    data: { user: { id: 'alice', email_confirmed_at: null } },
    error: null,
  });
  await expect(context(request())).rejects.toMatchObject({
    status: 403,
    code: 'email_not_confirmed',
  });
});
it('accepts confirmed users only after verifying the bearer token with Auth', async () => {
  getUser.mockResolvedValue({
    data: { user: { id: 'alice', email_confirmed_at: '2026-09-18' } },
    error: null,
  });
  await expect(context(request())).resolves.toMatchObject({
    mode: 'supabase',
    repo: { userId: 'alice' },
  });
  expect(getUser).toHaveBeenCalledWith('signed-token');
});
it('rejects invalid sessions', async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { message: 'expired' } });
  await expect(context(request())).rejects.toMatchObject({ status: 401 });
});
