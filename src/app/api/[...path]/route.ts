import type { NextRequest } from 'next/server';
import { handleApi } from '@/lib/server/api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: NextRequest, context: Context) {
  return handleApi(request, (await context.params).path);
}
export { handler as GET, handler as POST, handler as PATCH };
