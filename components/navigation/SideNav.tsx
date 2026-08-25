'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '../design-system/Icon.tsx';
import { MiniAppIcon } from '../design-system/MiniAppIcon.tsx';
import { MINI_APP_LIST } from '../design-system/miniApps.ts';
import { cx } from '../design-system/cx.ts';
import { PRIMARY_NAV, SECONDARY_NAV, isActiveHref } from './navItems.ts';
import type { NavItem } from './navItems.ts';
import { BrandMark } from './BrandMark.tsx';

/**
 * SideNav — the tablet rail AND the desktop sidebar, in one component.
 *
 *   768px – 1279px   icon rail, 5rem wide, icon over an 11px label
 *                    (SPEC §3: "left navigation rail can appear")
 *   >= 1280px        full sidebar, 17rem wide, icon beside a label, plus a
 *                    scrollable list of all thirteen mini-apps
 *                    (SPEC §4: "persistent sidebar/rail where appropriate")
 *
 * Both forms share one DOM tree and one tab order. Nothing is duplicated and
 * hidden — there is exactly one "Home" link on the page at any width, which
 * is what keeps the tab order and the screen-reader landmark list honest.
 *
 * Below 768px the whole thing is `hidden` and `BottomNav` takes over.
 */
export interface SideNavProps {
  badges?: Record<string, number | undefined>;
}

export function SideNav({ badges }: SideNavProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cx(
        'sticky top-0 z-30 hidden h-dvh shrink-0 flex-col border-r border-line',
        'bg-canvas/70 backdrop-blur-xl md:flex',
        'w-[var(--mos-rail-w)] xl:w-[var(--mos-sidebar-w)]',
      )}
    >
      {/* brand */}
      <div className="flex h-16 shrink-0 items-center justify-center border-b border-line px-2 xl:justify-start xl:px-5">
        <BrandMark variant="responsive" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-3 xl:px-3">
        <ul className="flex list-none flex-col gap-1 p-0">
          {PRIMARY_NAV.map((item) => (
            <li key={item.id}>
              <SideNavLink
                item={item}
                active={!item.action && isActiveHref(pathname, item.href)}
                badge={badges?.[item.id]}
              />
            </li>
          ))}
        </ul>

        <Divider />

        <ul className="flex list-none flex-col gap-1 p-0">
          {SECONDARY_NAV.map((item) => (
            <li key={item.id}>
              <SideNavLink
                item={item}
                active={isActiveHref(pathname, item.href)}
                badge={badges?.[item.id]}
              />
            </li>
          ))}
        </ul>

        {/* Mini-apps: desktop only. The rail stays deliberately sparse. */}
        <div className="mt-2 hidden min-h-0 flex-1 flex-col xl:flex">
          <p className="px-3 pb-2 pt-3 text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Mini-apps
          </p>
          <ul className="flex list-none flex-col gap-0.5 overflow-y-auto p-0 pb-2">
            {MINI_APP_LIST.map((app) => {
              const active = isActiveHref(pathname, app.href);
              return (
                <li key={app.id}>
                  <Link
                    href={app.href}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'flex min-h-11 items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium',
                      'transition-colors duration-150',
                      active
                        ? 'bg-accent-soft text-ink'
                        : 'text-ink-muted hover:bg-canvas-tint hover:text-ink',
                    )}
                  >
                    <MiniAppIcon app={app} size="xs" />
                    <span className="truncate">{app.label}</span>
                    {active ? (
                      <span aria-hidden className="ml-auto size-1.5 rounded-full bg-accent" />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </nav>
  );
}

function Divider() {
  return <hr className="my-2 border-line" />;
}

function SideNavLink({
  item,
  active,
  badge,
}: {
  item: NavItem;
  active: boolean;
  badge?: number | undefined;
}) {
  const isAction = item.action === true;

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      className={cx(
        // rail: stacked, centred. desktop: a row.
        'group relative flex min-h-11 flex-col items-center justify-center gap-1 rounded-md px-1 py-2',
        'text-center transition-colors duration-150',
        'xl:flex-row xl:justify-start xl:gap-3 xl:px-3 xl:text-left',
        isAction
          ? 'bg-primary text-primary-ink shadow-card ring-1 ring-[var(--color-hairline-gold)] hover:bg-primary-hover'
          : active
            ? 'bg-accent-soft text-ink'
            : 'text-ink-muted hover:bg-canvas-tint hover:text-ink',
      )}
    >
      {/* Active marker that survives greyscale: a gold bar on the leading edge. */}
      {active ? (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-accent"
        />
      ) : null}

      <span className="relative">
        <Icon name={item.icon} size={20} />
        {badge ? (
          <span className="absolute -right-2 -top-1.5 grid min-h-4 min-w-4 place-items-center rounded-full bg-critical px-1 text-[0.5625rem] font-bold leading-none text-critical-ink ring-2 ring-canvas">
            {badge}
          </span>
        ) : null}
      </span>

      <span className="text-2xs font-semibold xl:text-base xl:font-semibold xl:tracking-normal">
        <span className="xl:hidden">{item.short}</span>
        <span className="hidden xl:inline">{item.label}</span>
      </span>

      {badge ? <span className="sr-only">, {badge} new</span> : null}
    </Link>
  );
}
