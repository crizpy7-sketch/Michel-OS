import type { IconName } from '../design-system/Icon.tsx';

/**
 * NAVIGATION REGISTRY — one list, three layouts.
 *
 * The same items drive the phone's bottom bar, the tablet's rail and the
 * desktop sidebar. Changing a destination means editing this file, not three
 * components.
 */
export interface NavItem {
  id: string;
  /** Full label — sidebar rows, `aria-label`. */
  label: string;
  /** Compact label — the bottom bar and the tablet rail. */
  short: string;
  href: string;
  icon: IconName;
  /**
   * An action rather than a destination (the capture "+"). Actions are never
   * given `aria-current`, because you do not "arrive" at them.
   */
  action?: boolean;
  /** Longer description for the sidebar's tooltip / the More screen. */
  description?: string;
}

/**
 * The five that appear in the phone's bottom bar (SPEC §7):
 * Home · Schedule · Add · AI · More.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  {
    id: 'home',
    label: 'Home',
    short: 'Home',
    href: '/',
    icon: 'home',
    description: 'Today at a glance, and every mini-app.',
  },
  {
    id: 'schedules',
    label: 'All Schedules',
    short: 'Schedule',
    href: '/schedules',
    icon: 'calendar',
    description: 'Day, week, month and agenda across the whole household.',
  },
  {
    id: 'add',
    label: 'Add something',
    short: 'Add',
    href: '/ai?capture=1',
    icon: 'plus',
    action: true,
    description: 'Say it in plain words and let the assistant file it.',
  },
  {
    id: 'ai',
    label: 'AI Assistant',
    short: 'AI',
    href: '/ai',
    icon: 'sparkle',
    description: 'Ask, plan, and resolve conflicts.',
  },
  {
    id: 'more',
    label: 'More',
    short: 'More',
    href: '/more',
    icon: 'ellipsis',
    description: 'Every mini-app, members, and settings.',
  },
];

/**
 * Reachable from the rail and the sidebar directly, and from `/more` on the
 * phone. Inbox is additionally surfaced in the top bar on every size, because
 * a capture inbox that takes three taps to reach does not get used.
 */
export const SECONDARY_NAV: readonly NavItem[] = [
  {
    id: 'business',
    label: 'Shia Baby',
    short: 'Shia Baby',
    href: '/business',
    icon: 'storefront',
    description: 'Staffing, inventory, sales, expenses and tax set-aside.',
  },
  {
    id: 'inbox',
    label: 'Inbox',
    short: 'Inbox',
    href: '/inbox',
    icon: 'inbox',
    description: 'Unsorted captures waiting to be classified.',
  },
];

/** Every nav destination, in the order the sidebar lists them. */
export const ALL_NAV: readonly NavItem[] = [...PRIMARY_NAV, ...SECONDARY_NAV];

/**
 * Active-route test. `/` matches only itself; everything else matches its own
 * path and anything nested under it, so `/business/inventory` still lights up
 * "Shia Baby". Query strings are ignored — `/ai?capture=1` is still `/ai`.
 */
export function isActiveHref(pathname: string, href: string): boolean {
  const path = href.split('?')[0] ?? href;
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(`${path}/`);
}
