/**
 * MICHEL-OS DESIGN SYSTEM — public surface.
 *
 * Screen agents should import from this barrel:
 *
 *   import { Card, PageHeader, Stack } from '../../components/design-system/index.ts';
 *
 * Anything not exported here is an implementation detail and may change.
 * Colours, spacing, radii, shadows and type sizes all come from the tokens in
 * `app/globals.css` — no component in this package contains a literal hex
 * value, and no screen should either.
 */

export { cx } from './cx.ts';
export type { ClassValue } from './cx.ts';

export { Icon, ICON_NAMES } from './Icon.tsx';
export type { IconName, IconProps } from './Icon.tsx';

export { Stack, Spacer } from './Stack.tsx';
export type {
  StackProps,
  StackAlign,
  StackDirection,
  StackGap,
  StackJustify,
  StackTag,
} from './Stack.tsx';

export { Card, CardHeader } from './Card.tsx';
export type { CardProps, CardHeaderProps, CardPadding, CardTag, CardTone } from './Card.tsx';

export { Button, LinkButton, buttonClasses } from './Button.tsx';
export type { ButtonProps, LinkButtonProps, ButtonSize, ButtonVariant } from './Button.tsx';

export { Pill, SeverityPill, SEVERITY_PRESENTATION } from './Pill.tsx';
export type { PillProps, PillSize, PillTone, SeverityPillProps } from './Pill.tsx';

export { Callout, SEVERITY_CALLOUT_TONE } from './Callout.tsx';
export type { CalloutProps, CalloutTone } from './Callout.tsx';

export { PageHeader, SectionHeading } from './PageHeader.tsx';
export type { PageHeaderProps, SectionHeadingProps } from './PageHeader.tsx';

export { EmptyState } from './EmptyState.tsx';
export type { EmptyStateProps } from './EmptyState.tsx';

export { ErrorState, PermissionDeniedState } from './ErrorState.tsx';
export type { ErrorStateProps, PermissionDeniedStateProps } from './ErrorState.tsx';

export { Skeleton, SkeletonText, SkeletonList, SkeletonRegion } from './Skeleton.tsx';
export type {
  SkeletonProps,
  SkeletonShape,
  SkeletonTextProps,
  SkeletonListProps,
  SkeletonRegionProps,
} from './Skeleton.tsx';

export { MiniAppIcon, MiniAppTile } from './MiniAppIcon.tsx';
export type { MiniAppIconProps, MiniAppIconSize, MiniAppTileProps } from './MiniAppIcon.tsx';

export { MiniAppGrid, MiniAppRow } from './MiniAppGrid.tsx';
export type { MiniAppGridProps, MiniAppRowProps } from './MiniAppGrid.tsx';

export {
  MINI_APPS,
  MINI_APP_IDS,
  MINI_APP_LIST,
  ICON_MANIFEST,
  PENDING_ART,
  assertMiniAppArtIntegrity,
  getMiniApp,
  getMiniAppByHref,
  iconPath,
  miniAppsInGroup,
} from './miniApps.ts';
export type { ArtStatus, MiniApp, MiniAppGroup, MiniAppId } from './miniApps.ts';
