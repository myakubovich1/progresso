import type { Metadata } from 'next';
import { AuthCallback } from '@/components/auth-callback';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Finish signing in | Progresso',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default function CallbackPage() {
  return <AuthCallback />;
}
