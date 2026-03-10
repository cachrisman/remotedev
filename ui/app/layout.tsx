import type { Metadata, Viewport } from 'next';
import './globals.css';

// Avoid prerender at build time so client components never run in a broken React tree (useContext null)
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RemoteDev',
  description: 'Control your Mac dev environment from your iPhone',
};

// viewport-fit=cover extends the app edge-to-edge; safe areas handled via .pt-safe / .pb-safe.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100">
        {children}
      </body>
    </html>
  );
}
