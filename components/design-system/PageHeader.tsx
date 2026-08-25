import type { ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from './Icon.tsx';
import { cx } from './cx.ts';

/**
 * PageHeader — the top of every screen.
 *
 * One component so that the title, the back affordance and the action slot
 * land in the same place on all thirteen mini-apps, and so the display face
 * is applied consistently. On mobile it is a compact stacked block; from
 * 768px up the actions move onto the title line.
 *
 * The `<h1>` lives here. Screens should not render a second one.
 */
export interface PageHeaderProps {
  title: ReactNode;
  /** Small uppercase kicker above the title — the mini-app name, usually. */
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  /** Buttons / filters. Wrap multiple actions in a fragment. */
  actions?: ReactNode;
  /** Renders a back control. Mobile-first screens should always set this. */
  back?: { href: string; label: string };
  /** Status chips, counts, member avatars — sits under the subtitle. */
  meta?: ReactNode;
  /** Set false when the header must not be sticky (e.g. inside a sheet). */
  sticky?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  actions,
  back,
  meta,
  sticky = false,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cx(
        'w-full',
        sticky && 'sticky top-0 z-30 mos-glass border-x-0 border-t-0 rounded-none',
        className,
      )}
    >
      <div className="px-[var(--mos-gutter)] pt-5 pb-4 sm:px-6 lg:px-8 lg:pt-8">
        {back ? (
          <Link
            href={back.href}
            className="mos-tap relative -ml-1 mb-2 inline-flex min-h-9 items-center gap-1 rounded-sm pr-2 pl-1 text-sm font-semibold text-ink-muted transition-colors hover:text-ink"
          >
            <Icon name="chevron-left" size={16} />
            {back.label}
          </Link>
        ) : null}

        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-6">
          <div className="min-w-0">
            {eyebrow ? (
              <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.16em] text-accent-strong">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="font-display text-2xl font-semibold text-ink lg:text-3xl">{title}</h1>
            {subtitle ? (
              <p className="mt-1.5 max-w-prose text-base text-ink-muted">{subtitle}</p>
            ) : null}
            {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
          </div>

          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">{actions}</div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * SectionHeading — the smaller in-page divider used between blocks of a
 * screen ("Today", "This week", "Low stock"). Keeps `<h2>` semantics.
 */
export interface SectionHeadingProps {
  children: ReactNode;
  actions?: ReactNode;
  id?: string;
  className?: string;
}

export function SectionHeading({ children, actions, id, className }: SectionHeadingProps) {
  return (
    <div className={cx('flex items-center justify-between gap-3', className)}>
      <h2
        id={id}
        className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted"
      >
        {children}
      </h2>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
