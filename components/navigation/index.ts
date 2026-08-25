/**
 * NAVIGATION — public surface.
 *
 * Screens normally need only `PageContainer`; the shell itself is mounted
 * once by `app/(dashboard)/layout.tsx`.
 */
export { AppShell, PageContainer } from './AppShell.tsx';
export type { AppShellProps, PageContainerProps, PageWidth } from './AppShell.tsx';

export { SkipLink } from './SkipLink.tsx';
export type { SkipLinkProps } from './SkipLink.tsx';

export { TopBar } from './TopBar.tsx';
export type { TopBarProps } from './TopBar.tsx';

export { BottomNav } from './BottomNav.tsx';
export type { BottomNavProps } from './BottomNav.tsx';

export { SideNav } from './SideNav.tsx';
export type { SideNavProps } from './SideNav.tsx';

export { BrandMark } from './BrandMark.tsx';
export type { BrandMarkProps } from './BrandMark.tsx';

export { PRIMARY_NAV, SECONDARY_NAV, ALL_NAV, isActiveHref } from './navItems.ts';
export type { NavItem } from './navItems.ts';
