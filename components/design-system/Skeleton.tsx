import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { Card } from './Card.tsx';

/**
 * Skeleton — the loading state (SPEC §9).
 *
 * The shimmer is defined in globals.css and is switched off entirely under
 * `prefers-reduced-motion: reduce`, leaving a static block. Skeletons are
 * `aria-hidden`; the live region announcing "loading" is `SkeletonRegion`,
 * so screen-reader users get one message instead of forty empty boxes.
 */
export type SkeletonShape = 'text' | 'block' | 'circle' | 'pill';

const SHAPE: Record<SkeletonShape, string> = {
  text: 'h-3.5 rounded-xs',
  block: 'rounded-md',
  circle: 'rounded-full aspect-square',
  pill: 'h-6 rounded-full',
};

export interface SkeletonProps {
  shape?: SkeletonShape;
  /** Any CSS width — `'100%'`, `'12ch'`, `'8rem'`. Default `'100%'`. */
  width?: string;
  /** Any CSS height. Ignored for `text`/`pill`, which are fixed. */
  height?: string;
  className?: string;
}

export function Skeleton({ shape = 'block', width, height, className }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cx('mos-shimmer block', SHAPE[shape], className)}
      style={{ width: width ?? '100%', ...(height ? { height } : null) }}
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

/** A paragraph-shaped placeholder; the last line is deliberately short. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <span className={cx('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} shape="text" width={i === lines - 1 ? '62%' : '100%'} />
      ))}
    </span>
  );
}

export interface SkeletonListProps {
  /** How many rows to draw. Match the real list's typical length. */
  rows?: number;
  className?: string;
}

/** The standard "list of events / items is loading" placeholder. */
export function SkeletonList({ rows = 4, className }: SkeletonListProps) {
  return (
    <div className={cx('flex flex-col gap-3', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i} tone="flat" padding="sm">
          <div className="flex items-center gap-3">
            <Skeleton shape="circle" width="2.5rem" />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton shape="text" width="58%" />
              <Skeleton shape="text" width="36%" />
            </span>
            <Skeleton shape="pill" width="4rem" className="hidden sm:block" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export interface SkeletonRegionProps {
  /** Announced to assistive tech, e.g. "Loading today's schedule". */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * Wrap a screen's skeletons in this. It emits one polite live-region message
 * rather than letting the placeholder boxes leak into the accessibility tree.
 */
export function SkeletonRegion({ label, children, className }: SkeletonRegionProps) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
