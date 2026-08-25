import Link from 'next/link';
import { Icon } from '../design-system/Icon.tsx';
import { cx } from '../design-system/cx.ts';
import { BrandMark } from './BrandMark.tsx';

/**
 * TopBar — slim global chrome.
 *
 * Deliberately thin, because the screen's own `PageHeader` carries the title.
 * What lives here is what must be reachable from anywhere:
 *
 *   phone   brand · inbox · notifications        (the sidebar is not present)
 *   tablet+ global search · inbox · notifications (brand is in the rail)
 *
 * Inbox is surfaced at every width on purpose: a capture inbox that takes
 * three taps to reach does not get used.
 */
export interface TopBarProps {
  /** Unclassified inbox items. Renders a badge when > 0. */
  inboxCount?: number;
  /** Pending notifications. Renders a badge when > 0. */
  notificationCount?: number;
  /** Right-hand slot for a screen-specific control (a member switcher). */
  children?: React.ReactNode;
  className?: string;
}

export function TopBar({
  inboxCount = 0,
  notificationCount = 0,
  children,
  className,
}: TopBarProps) {
  return (
    <div
      className={cx(
        'mos-glass sticky top-0 z-30 rounded-none border-x-0 border-t-0',
        'pt-[var(--mos-safe-t)]',
        className,
      )}
    >
      <div className="flex h-[var(--mos-topbar-h)] items-center gap-2 px-[var(--mos-gutter)] sm:px-6 lg:px-8">
        <div className="md:hidden">
          <BrandMark variant="wordmark" />
        </div>

        {/* Desktop global search (SPEC §4). A link, not a live input: the
            search screen owns the behaviour; this is only the way in. */}
        <Link
          href="/schedules"
          className={cx(
            'mos-tap relative ml-auto hidden min-h-9 items-center gap-2 rounded-full md:ml-0 md:flex',
            'border border-line bg-surface-sunken px-3 text-sm text-ink-muted',
            'hover:border-control-border hover:text-ink md:w-64 lg:w-80',
          )}
        >
          <Icon name="search" size={16} />
          <span className="truncate">Search schedules…</span>
        </Link>

        <div className="ml-auto flex items-center gap-1">
          {children}

          <IconLink
            href="/inbox"
            icon="inbox"
            label="Inbox"
            count={inboxCount}
            countNoun="unsorted item"
          />
          <IconLink
            href="/more"
            icon="bell"
            label="Notifications"
            count={notificationCount}
            countNoun="notification"
          />
        </div>
      </div>
    </div>
  );
}

function IconLink({
  href,
  icon,
  label,
  count,
  countNoun,
}: {
  href: string;
  icon: 'inbox' | 'bell';
  label: string;
  count: number;
  countNoun: string;
}) {
  const plural = count === 1 ? countNoun : `${countNoun}s`;
  return (
    <Link
      href={href}
      aria-label={count > 0 ? `${label}, ${count} ${plural}` : label}
      className="relative grid min-h-11 min-w-11 place-items-center rounded-md text-ink-muted transition-colors hover:bg-canvas-tint hover:text-ink"
    >
      <Icon name={icon} size={20} />
      {count > 0 ? (
        <span
          aria-hidden
          className="absolute right-1.5 top-1.5 grid min-h-4 min-w-4 place-items-center rounded-full bg-critical px-1 text-[0.5625rem] font-bold leading-none text-critical-ink ring-2 ring-canvas"
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
