import { ProgressoApp } from '@/components/progresso-app';
import { demoEnabled } from '@/lib/server/context';
export const dynamic = 'force-dynamic';
export default function Page() {
  return (
    <ProgressoApp
      demo={demoEnabled()}
      configured={
        !!(
          process.env.NEXT_PUBLIC_SUPABASE_URL &&
          (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
        )
      }
    />
  );
}
