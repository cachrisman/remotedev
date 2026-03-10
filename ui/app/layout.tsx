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

// Anti-flash: set `dark` class synchronously before first paint so Tailwind
// picks the right colour scheme without a visible flicker.
// Default is dark; light is opt-in via the in-app toggle.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='light'){document.documentElement.classList.remove('dark')}else{document.documentElement.classList.add('dark')}}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body className="bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        {children}
      </body>
    </html>
  );
}
