import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Progresso — Your next step',
  description: 'Most health apps give you data. We give you actionable next steps.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
