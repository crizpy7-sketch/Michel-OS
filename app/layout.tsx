import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { Fraunces, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';

/**
 * TYPE PAIRING — Michel-OS
 *
 * Display: Fraunces. A high-contrast, optically-sized serif with real
 * character (ball terminals, a `SOFT` and a `WONK` axis). It carries the
 * "premium, not pastel" brief without tipping into luxury-magazine cliché,
 * its optical-size axis means the greeting at 48px and a card title at 20px
 * are genuinely different drawings rather than one scaled outline, and its
 * lining figures make big numbers (event counts, times, totals) look
 * deliberate.
 *
 * Body / UI: Plus Jakarta Sans. Tall x-height, open apertures, unambiguous
 * `1 / l / I`, and a proper tabular-figure set — it stays legible at 11px on
 * a 320px phone, which is where most of this product actually lives. It is
 * explicitly not Inter: the brief asked for a considered pairing, and Plus
 * Jakarta's slightly humanist geometry sits far better beside Fraunces than
 * Inter's neutral grotesque does.
 *
 * Both are loaded as variable fonts via next/font (self-hosted at build
 * time, no external request at runtime, no layout shift).
 */
const display = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz'],
  variable: '--font-fraunces',
  fallback: ['ui-serif', 'Georgia', 'Times New Roman', 'serif'],
});

const body = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
});

export const metadata: Metadata = {
  title: {
    default: 'Michel-OS',
    template: '%s · Michel-OS',
  },
  description: 'A premium family scheduling OS — one home screen for every schedule in the house.',
  applicationName: 'Michel-OS',
  appleWebApp: {
    capable: true,
    title: 'Michel-OS',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Deliberately NOT `maximumScale: 1` — pinch-zoom stays available (SPEC §8).
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbf8f3' },
    { media: '(prefers-color-scheme: dark)', color: '#070c18' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
