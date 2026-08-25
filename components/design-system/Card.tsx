import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * Card — the workhorse surface.
 *
 * Everything on a screen lives on one of these. Tones map to depth, not to
 * decoration:
 *
 *   default   a normal card sitting on the canvas
 *   flat      no shadow — for cards inside an already-elevated container
 *   glass     the subtle frosted surface (nav bars, sticky headers, sheets)
 *   sunken    an inset well — read-only detail, code, quiet lists
 *   inverse   a dark island on a light page (hero / morning brief)
 *
 * `accent` adds the single gold hairline across the top. That is the only
 * place gold is allowed to touch a large element — it is emphasis, not a
 * theme, so use it on at most one card per viewport.
 */
export type CardTone = 'default' | 'flat' | 'glass' | 'sunken' | 'inverse';
export type CardPadding = 'none' | 'xs' | 'sm' | 'md' | 'lg';
export type CardTag = 'div' | 'section' | 'article' | 'li' | 'aside' | 'header' | 'form';

const TONE: Record<CardTone, string> = {
  default: 'bg-surface border border-line shadow-card',
  flat: 'bg-surface border border-line',
  glass: 'mos-glass shadow-card',
  sunken: 'bg-surface-sunken border border-line',
  inverse: 'bg-surface-inverse text-ink-inverse border border-transparent shadow-raised',
};

const PADDING: Record<CardPadding, string> = {
  none: '',
  xs: 'p-2.5',
  sm: 'p-3.5',
  md: 'p-4 sm:p-5',
  lg: 'p-5 sm:p-7',
};

export interface CardProps {
  children?: ReactNode;
  tone?: CardTone;
  padding?: CardPadding;
  /** Adds the gold hairline along the top edge. Use sparingly. */
  accent?: boolean;
  /**
   * Hover/press affordance. Set this only when the whole card is genuinely
   * activatable — and then put a real `<a>` or `<button>` inside it, so the
   * thing keyboard users tab to is a control, not a styled `<div>`.
   */
  interactive?: boolean;
  as?: CardTag;
  className?: string;
  id?: string;
  role?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-testid'?: string;
}

export function Card({
  children,
  tone = 'default',
  padding = 'md',
  accent = false,
  interactive = false,
  as: Tag = 'div',
  className,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={cx(
        'relative rounded-lg',
        TONE[tone],
        PADDING[padding],
        accent && 'mos-gold-edge',
        interactive &&
          'transition-[box-shadow,transform,border-color] duration-200 ease-[var(--ease-out-soft)] hover:shadow-raised hover:border-line-strong active:translate-y-px focus-within:border-line-strong',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/**
 * CardHeader — title row for a Card. Keeps the display face, the optional
 * count/meta and the action slot aligned the same way on every screen.
 */
export interface CardHeaderProps {
  title: ReactNode;
  /** Small uppercase label above the title. */
  eyebrow?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Heading level. Pick the one that is correct for the page outline. */
  level?: 2 | 3 | 4;
  className?: string;
  id?: string;
}

export function CardHeader({
  title,
  eyebrow,
  meta,
  actions,
  level = 3,
  className,
  id,
}: CardHeaderProps) {
  const Heading = (level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4';
  return (
    <div className={cx('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            {eyebrow}
          </p>
        ) : null}
        <Heading id={id} className="text-lg font-semibold text-ink">
          {title}
        </Heading>
        {meta ? <p className="mt-0.5 text-sm text-ink-muted">{meta}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
