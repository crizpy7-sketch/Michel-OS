import type { ReactNode } from 'react';
import type { MiniApp, MiniAppId } from './miniApps.ts';
import { MINI_APP_LIST, MINI_APPS } from './miniApps.ts';
import { MiniAppTile } from './MiniAppIcon.tsx';
import { cx } from './cx.ts';

/**
 * MiniAppGrid — the iPhone-home-screen grid (PRODUCT_SPEC §2).
 *
 * Column counts are CSS-only (`.mos-app-grid` in globals.css), so there is no
 * JS breakpoint logic and no layout flash:
 *
 *     < 768px    3 columns   (SPEC §2)
 *    >= 768px    4 columns   (SPEC §3 — iPad portrait)
 *   >= 1024px    5 columns   (SPEC §3 — iPad landscape)
 *   >= 1440px    6 columns   (wide desktop)
 *
 * It renders a `<ul>`: thirteen destinations is a list, and screen-reader
 * users get "13 items" instead of an undifferentiated wall of links.
 */
export interface MiniAppGridProps {
  /** Defaults to all thirteen, in PRODUCT_SPEC §2 order. */
  apps?: readonly (MiniApp | MiniAppId)[];
  /** Per-app badge counts, e.g. `{ inbox: 4, errands: 2 }`. */
  badges?: Partial<Record<MiniAppId, number | string>>;
  /** Per-app hint lines, e.g. `{ practice: '2 today' }`. */
  hints?: Partial<Record<MiniAppId, string>>;
  /** Short labels — the right choice at 320px. Default `true`. */
  compact?: boolean;
  /** Accessible name for the list, e.g. "Mini-apps". */
  label?: string;
  /** Eager-load the first N tiles (above the fold). Default 8. */
  eagerCount?: number;
  className?: string;
}

export function MiniAppGrid({
  apps = MINI_APP_LIST,
  badges,
  hints,
  compact = true,
  label = 'Mini-apps',
  eagerCount = 8,
  className,
}: MiniAppGridProps) {
  return (
    <ul aria-label={label} className={cx('mos-app-grid list-none p-0', className)}>
      {apps.map((entry, index) => {
        const record = typeof entry === 'string' ? MINI_APPS[entry] : entry;
        return (
          <li key={record.id} className="min-w-0">
            <MiniAppTile
              app={record}
              compact={compact}
              badge={badges?.[record.id]}
              hint={hints?.[record.id]}
              eager={index < eagerCount}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * MiniAppRow — a horizontally scrolling strip of mini-apps, for places where
 * a full grid is too much (a mini-app screen's "jump to" bar, a side panel).
 * Overflow is contained inside the strip; the page body never scrolls
 * sideways.
 */
export interface MiniAppRowProps {
  apps?: readonly (MiniApp | MiniAppId)[];
  label?: string;
  children?: ReactNode;
  className?: string;
}

export function MiniAppRow({
  apps = MINI_APP_LIST,
  label = 'Mini-apps',
  className,
}: MiniAppRowProps) {
  return (
    <ul
      aria-label={label}
      className={cx('mos-scroll-x flex list-none gap-3 p-0 pb-1', className)}
    >
      {apps.map((entry) => {
        const record = typeof entry === 'string' ? MINI_APPS[entry] : entry;
        return (
          <li key={record.id} className="w-16 shrink-0">
            <MiniAppTile app={record} compact />
          </li>
        );
      })}
    </ul>
  );
}
