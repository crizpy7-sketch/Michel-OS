import type { ReactNode } from 'react';
import { cx } from '../design-system/cx.ts';
import { SkipLink } from './SkipLink.tsx';
import { SideNav } from './SideNav.tsx';
import { BottomNav } from './BottomNav.tsx';
import { TopBar } from './TopBar.tsx';

/**
 * AppShell — the frame every screen renders inside.
 *
 * Three intentional layouts from one tree (SPEC §2–§4):
 *
 *   < 768px    single column · slim top bar · fixed bottom tab bar
 *              main gets bottom padding so the tab bar never covers content
 *   >= 768px   two columns · 5rem icon rail on the left · no bottom bar
 *   >= 1280px  two columns · 17rem labelled sidebar with the mini-app list
 *
 * The switch is pure CSS (`.mos-shell` + `md:` / `xl:` variants) — no
 * `matchMedia`, no resize listener, no hydration flash, and the server-
 * rendered HTML is already correct at every width.
 *
 * Landmarks: one `<nav aria-label="Primary">` at any given width, one
 * `<main id="main-content" tabindex="-1">`, and a skip link as the first
 * focusable element on the page.
 */
export interface AppShellProps {
  children: ReactNode;
  /** Badge counts keyed by nav item id, e.g. `{ inbox: 4, ai: 1 }`. */
  badges?: Record<string, number | undefined>;
  /** Hide the slim top bar for a screen that owns its full canvas. */
  topBar?: boolean;
  className?: string;
}

export function AppShell({ children, badges, topBar = true, className }: AppShellProps) {
  const inboxCount = badges?.['inbox'] ?? 0;
  const notificationCount = badges?.['notifications'] ?? 0;

  return (
    <div className={cx('mos-shell', className)}>
      <SkipLink />

      {/* Tablet rail / desktop sidebar. Hidden below 768px. */}
      <SideNav badges={badges} />

      <div className="flex min-w-0 flex-col">
        {topBar ? (
          <TopBar inboxCount={inboxCount} notificationCount={notificationCount} />
        ) : null}

        <main id="main-content" tabIndex={-1} className="mos-main flex-1 outline-none">
          {children}
        </main>
      </div>

      {/* Phone tab bar. Hidden from 768px up. */}
      <BottomNav badges={badges} />
    </div>
  );
}

/**
 * PageContainer — the standard content width + gutters for a screen's body.
 *
 * Gutters: 16px on phone, 24px from 640px, 32px from 1024px. `width` picks
 * the reading measure:
 *
 *   narrow  48rem  a single column of detail (an event, a form)
 *   default 80rem  the normal multi-column screen
 *   wide  none     tables and week/month calendars that want the full canvas
 */
export type PageWidth = 'narrow' | 'default' | 'wide';

const WIDTH: Record<PageWidth, string> = {
  narrow: 'max-w-3xl',
  default: 'max-w-7xl',
  wide: 'max-w-none',
};

export interface PageContainerProps {
  children: ReactNode;
  width?: PageWidth;
  className?: string;
}

export function PageContainer({ children, width = 'default', className }: PageContainerProps) {
  return (
    <div
      className={cx(
        'mx-auto w-full px-[var(--mos-gutter)] pb-8 sm:px-6 lg:px-8',
        WIDTH[width],
        className,
      )}
    >
      {children}
    </div>
  );
}
