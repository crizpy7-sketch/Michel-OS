import type { CSSProperties } from 'react';
import Link from 'next/link';
import type { ArtStatus, MiniApp, MiniAppId } from './miniApps.ts';
import { MINI_APPS } from './miniApps.ts';
import { cx } from './cx.ts';

/**
 * MiniAppIcon — renders the approved mini-app artwork.
 *
 * REQUIRED BY ASSET_MAP.md. The rules this component enforces:
 *
 *  1. The artwork is always the real PNG from `public/icons/`. There is no
 *     emoji path, no Lucide path, no CSS-recreation path. If the asset is
 *     missing the tile renders empty — loudly wrong — rather than quietly
 *     substituting something that looks plausible.
 *  2. Swapping an icon is a one-record change in `miniApps.ts`. No screen
 *     ever writes an `/icons/...` string.
 *  3. Placeholder art is *visibly* flagged: a dashed gold ring, a corner
 *     mark, a `title`, `data-art-status="pending"` and screen-reader text.
 *     Placeholders therefore cannot ship silently as final artwork, which is
 *     the explicit instruction in ASSET_MAP.md.
 *
 * A plain `<img>` is used rather than `next/image` on purpose: these are
 * static, already-square assets served from `public/`, and `next/image`
 * would put a runtime image optimiser (and a `sharp` dependency) between the
 * artwork and the screen for no gain.
 */
export type MiniAppIconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'fluid';

const BOX: Record<MiniAppIconSize, string> = {
  xs: 'size-7 rounded-[26%]',
  sm: 'size-10 rounded-[24%]',
  md: 'size-14 rounded-[23%]',
  lg: 'size-[4.5rem] rounded-[22%]',
  xl: 'size-[5.5rem] rounded-[22%]',
  fluid: 'w-full aspect-square rounded-[22%]',
};

/** Intrinsic px hint, so the browser reserves the box before decode. */
const INTRINSIC: Record<MiniAppIconSize, number> = {
  xs: 28,
  sm: 40,
  md: 56,
  lg: 72,
  xl: 88,
  fluid: 128,
};

function resolve(app: MiniAppId | MiniApp): MiniApp {
  return typeof app === 'string' ? MINI_APPS[app] : app;
}

export interface MiniAppIconProps {
  /** A registry id (`'practice'`) or a full registry record. */
  app: MiniAppId | MiniApp;
  size?: MiniAppIconSize;
  /**
   * Override the registry's art status. Almost never needed — the registry
   * is the source of truth. Present so the flag is part of this component's
   * public contract, per ASSET_MAP.md.
   */
  artStatus?: ArtStatus;
  /**
   * `true` (default) when a visible text label sits next to the icon, so the
   * image is hidden from assistive tech instead of being read twice. Set
   * `false` for an icon that stands alone.
   */
  decorative?: boolean;
  /** Load without waiting for the viewport — for above-the-fold home tiles. */
  eager?: boolean;
  className?: string;
}

export function MiniAppIcon({
  app,
  size = 'md',
  artStatus,
  decorative = true,
  eager = false,
  className,
}: MiniAppIconProps) {
  const record = resolve(app);
  const status = artStatus ?? record.artStatus;
  const pending = status === 'pending';
  const px = INTRINSIC[size];

  const tint: CSSProperties = {
    backgroundColor: `color-mix(in oklab, var(${record.accentVar}) 14%, transparent)`,
  };

  return (
    <span
      data-art-status={status}
      data-mini-app={record.id}
      title={pending ? `${record.label} — placeholder artwork, pending approval` : undefined}
      style={tint}
      className={cx(
        'relative isolate inline-block shrink-0 overflow-hidden',
        'ring-1 ring-line shadow-card',
        BOX[size],
        pending &&
          'outline-2 outline-dashed outline-offset-2 outline-[var(--color-hairline-gold)]',
        className,
      )}
    >
      <img
        src={record.icon}
        width={px}
        height={px}
        alt={decorative ? '' : record.label}
        aria-hidden={decorative || undefined}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        className="h-full w-full object-cover"
      />

      {pending ? <PendingArtMark size={size} /> : null}

      {pending ? (
        <span className="sr-only">Placeholder artwork, pending approval.</span>
      ) : null}
    </span>
  );
}

/**
 * The corner mark on placeholder art. Small, gold, unmistakable once you
 * know it — tasteful enough to live on a home screen, obvious enough that
 * nobody signs off on a build still wearing five of them.
 */
function PendingArtMark({ size }: { size: MiniAppIconSize }) {
  if (size === 'xs') {
    return (
      <span
        aria-hidden
        className="absolute right-0 top-0 z-10 size-1.5 rounded-full bg-[var(--color-hairline-gold)]"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cx(
        'absolute right-0.5 top-0.5 z-10 grid place-items-center rounded-full',
        'bg-canvas/85 text-[0.5rem] font-bold leading-none tracking-tight',
        'text-accent-strong ring-1 ring-[var(--color-hairline-gold)]',
        size === 'sm' ? 'size-3.5' : 'size-4',
      )}
    >
      {size === 'sm' ? '' : 'WIP'}
    </span>
  );
}

/* ---------------------------------------------------------------- the tile */

export interface MiniAppTileProps {
  app: MiniAppId | MiniApp;
  /** Use the registry's short label — the right call in the 3-col phone grid. */
  compact?: boolean;
  /** A count or short string shown as a badge (unread inbox, open errands). */
  badge?: number | string;
  /** Extra line under the label, e.g. "3 today". */
  hint?: string;
  eager?: boolean;
  className?: string;
}

/**
 * MiniAppTile — one cell of the home grid: artwork, label, optional badge.
 *
 * The whole tile is a single `<a>`, so it is one tab stop with one accessible
 * name, and the tap target is the full cell rather than the 56px image.
 */
export function MiniAppTile({
  app,
  compact = false,
  badge,
  hint,
  eager = false,
  className,
}: MiniAppTileProps) {
  const record = resolve(app);
  const hasBadge = badge !== undefined && badge !== null && badge !== 0 && badge !== '';

  return (
    <Link
      href={record.href}
      className={cx(
        'group flex min-h-11 flex-col items-center gap-2 rounded-md px-1 pb-1 pt-1 text-center',
        'transition-[transform,background-color] duration-200 ease-[var(--ease-out-soft)]',
        'hover:bg-canvas-tint active:scale-[0.97] motion-reduce:active:scale-100',
        className,
      )}
    >
      <span className="relative block w-full max-w-[4.5rem]">
        <MiniAppIcon app={record} size="fluid" eager={eager} />
        {hasBadge ? (
          <span
            className={cx(
              'absolute -right-1 -top-1 z-20 grid min-h-5 min-w-5 place-items-center rounded-full',
              'bg-critical px-1.5 text-2xs font-bold text-critical-ink ring-2 ring-canvas',
            )}
          >
            {badge}
          </span>
        ) : null}
      </span>

      <span className="flex w-full flex-col items-center gap-0.5">
        <span className="w-full truncate text-2xs font-semibold text-ink sm:text-xs">
          {compact ? record.shortLabel : record.label}
        </span>
        {hint ? (
          <span className="w-full truncate text-2xs text-ink-muted">{hint}</span>
        ) : null}
      </span>

      {hasBadge ? <span className="sr-only">{badge} needing attention</span> : null}
    </Link>
  );
}
