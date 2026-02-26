import type { Metadata } from 'next';
import './globals.css';

// Avoid prerender at build time so client components never run in a broken React tree (useContext null)
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RemoteDev',
  description: 'Control your Mac dev environment from your iPhone',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
