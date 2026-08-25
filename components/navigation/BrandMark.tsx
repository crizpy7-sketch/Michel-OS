import Link from 'next/link';
import { cx } from '../design-system/cx.ts';

/**
 * BrandMark — the wordmark, in the display face, with the single gold rule
 * underneath it. `variant="monogram"` is the tablet-rail form.
 */
export interface BrandMarkProps {
  variant?: 'wordmark' | 'monogram' | 'responsive';
  /** Wrap in a link home. Default true. */
  href?: string | null;
  className?: string;
}

export function BrandMark({ variant = 'wordmark', href = '/', className }: BrandMarkProps) {
  const inner = (
    <>
      <span
        aria-hidden
        className={cx(
          'font-display text-xl font-semibold leading-none text-accent-strong',
          variant === 'wordmark' && 'hidden',
          variant === 'responsive' && 'xl:hidden',
        )}
      >
        M
      </span>
      <span
        className={cx(
          'font-display text-md font-semibold leading-none tracking-[-0.01em] text-ink',
          variant === 'monogram' && 'sr-only',
          variant === 'responsive' && 'sr-only xl:not-sr-only',
        )}
      >
        Michel<span className="text-accent-strong">-OS</span>
      </span>
    </>
  );

  const classes = cx(
    'mos-tap relative inline-flex min-h-11 items-center gap-2 rounded-sm',
    className,
  );

  if (href === null) {
    return <span className={classes}>{inner}</span>;
  }
  return (
    <Link href={href} className={classes} aria-label="Michel-OS, home">
      {inner}
    </Link>
  );
}
