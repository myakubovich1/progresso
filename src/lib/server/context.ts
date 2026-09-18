import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { DemoRepository, SupabaseRepository, supabaseClient, type Repository } from './repository';
import { fail } from './errors';
export const demoEnabled = () => process.env.PROGRESSO_DEMO_MODE === 'true' && !process.env.VERCEL;
export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin) {
    const received = new URL(origin);
    const target = new URL(request.url);
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    const sameOrigin = received.origin === target.origin;
    const localEquivalent =
      localHosts.has(received.hostname) &&
      localHosts.has(target.hostname) &&
      received.port === target.port;
    if (!sameOrigin && !localEquivalent)
      fail(403, 'cross_origin', 'Cross-origin requests are not allowed');
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    fail(403, 'cross_origin', 'Cross-site requests are not allowed');
}
function demoId(token: string) {
  const h = createHash('sha256').update(token).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function assertLocal(request: Request) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname))
    fail(403, 'local_only', 'Local demo mode is not a public hosting backend');
}
export async function startDemo(request: Request) {
  if (!demoEnabled()) fail(404, 'not_found', 'Demo mode is not enabled');
  assertLocal(request);
  const token = randomBytes(32).toString('hex');
  const repo = new DemoRepository(demoId(token));
  await repo.initialize();
  return { token, repo };
}
export async function context(
  request: NextRequest,
): Promise<{ repo: Repository; mode: 'demo' | 'supabase' }> {
  if (demoEnabled()) {
    assertLocal(request);
    const token = request.cookies.get('progresso_demo')?.value;
    if (!token || !/^[0-9a-f]{64}$/.test(token))
      fail(401, 'unauthorized', 'Start a demo session first');
    const repo = new DemoRepository(demoId(token));
    await repo.state();
    return { repo, mode: 'demo' };
  }
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) fail(401, 'unauthorized', 'Sign in to access your health data');
  const client = supabaseClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) fail(401, 'unauthorized', 'Your session has expired. Sign in again.');
  if (!data.user.email_confirmed_at)
    fail(403, 'email_not_confirmed', 'Confirm your email before accessing your health data.');
  return { repo: new SupabaseRepository(data.user.id, client), mode: 'supabase' };
}
const limits = new Map<string, { count: number; expires: number }>();
// Single-process abuse protection. Use a shared gateway limiter for multi-instance deployments.
export function rateLimit(key: string, max: number, windowMs = 60000) {
  const now = Date.now();
  if (limits.size > 10000) for (const [k, v] of limits) if (v.expires <= now) limits.delete(k);
  const current = limits.get(key);
  if (!current || current.expires <= now) {
    limits.set(key, { count: 1, expires: now + windowMs });
    return;
  }
  if (current.count >= max)
    fail(429, 'rate_limited', 'Too many requests. Please try again shortly.');
  current.count++;
}
export async function boundedBody(request: Request, max: number) {
  if (Number(request.headers.get('content-length') ?? 0) > max)
    fail(413, 'too_large', 'Request exceeds the size limit');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        fail(413, 'too_large', 'Request exceeds the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks));
}
