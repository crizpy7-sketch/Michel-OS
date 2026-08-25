'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '../design-system/Icon.tsx';
import { cx } from '../design-system/cx.ts';
import { PRIMARY_NAV, isActiveHref } from './navItems.ts';
import type { NavItem } from './navItems.ts';

/**
 * BottomNav — the phone layout (SPEC §2, §7).
 *
 * Visible below 768px only; above that the rail/sidebar takes over. Five
 * destinations, thumb-reachable, with the capture action raised in the middle
 * where it can be hit one-handed.
 *
 * `'use client'` is required: active state comes from `usePathname()`.
 */
export interface BottomNavProps {
  /** Optional per-destination badge counts, e.g. `{ ai: 2 }`. */
  badges?: Record<string, number | undefined>;
}

export function BottomNav({ badges }: BottomNavProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cx(
        'mos-glass fixed inset-x-0 bottom-0 z-40 rounded-none border-x-0 border-b-0 md:hidden',
        'pb-[var(--mos-safe-b)]',
      )}
    >
      <ul className="mx-auto flex h-[var(--mos-bottomnav-h)] max-w-lg list-none items-stretch justify-around px-1">
        {PRIMARY_NAV.map((item) =>
          item.action ? (
            <li key={item.id} className="flex flex-1 items-center justify-center">
              <CaptureAction item={item} />
            </li>
          ) : (
            <li key={item.id} className="flex flex-1">
              <BottomNavLink
                item={item}
                active={isActiveHref(pathname, item.href)}
                badge={badges?.[item.id]}
              />
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

function BottomNavLink({
  item,
  active,
  badge,
}: {
  item: NavItem;
  active: boolean;
  badge?: number | undefined;
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'relative flex min-h-11 w-full flex-col items-center justify-center gap-1 rounded-sm px-1 pt-1.5 pb-1',
        'transition-colors duration-150',
        active ? 'text-accent-strong' : 'text-ink-muted hover:text-ink',
      )}
    >
      <span className="relative">
        <Icon name={item.icon} size={22} />
        {badge ? (
          <span className="absolute -right-2 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-critical px-1 text-[0.5625rem] font-bold leading-none text-critical-ink ring-2 ring-canvas">
            {badge}
          </span>
        ) : null}
      </span>
      <span className="text-2xs font-semibold tracking-normal">{item.short}</span>

      {/* Active marker that is not colour: a gold rule under the label. */}
      <span
        aria-hidden
        className={cx(
          'absolute inset-x-4 bottom-0 h-0.5 rounded-full transition-opacity',
          active ? 'bg-accent opacity-100' : 'opacity-0',
        )}
      />
      {badge ? <span className="sr-only">, {badge} new</span> : null}
    </Link>
  );
}

function CaptureAction({ item }: { item: NavItem }) {
  return (
    <Link
      href={item.href}
      aria-label={item.label}
      className={cx(
        'grid size-13 -translate-y-3 place-items-center rounded-full',
        'bg-primary text-primary-ink shadow-float ring-1 ring-[var(--color-hairline-gold)]',
        'transition-transform duration-150 ease-[var(--ease-out-soft)]',
        'active:translate-y-[-0.5rem] active:scale-95 motion-reduce:active:scale-100',
      )}
    >
      <Icon name={item.icon} size={26} />
    </Link>
  );
}
