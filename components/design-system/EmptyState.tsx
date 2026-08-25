import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { cx } from './cx.ts';

/**
 * EmptyState — "there is genuinely nothing here" (SPEC §9).
 *
 * Not an error, and not a loading state. Every empty state must say what
 * would fill it and offer the action that does so; an empty state with no
 * next step is a dead end.
 *
 *   <EmptyState
 *     icon="calendar"
 *     title="Nothing on Tuesday"
 *     description="No events, reminders or errands are scheduled."
 *     action={<LinkButton href="/ai" variant="primary">Add something</LinkButton>}
 *   />
 */
export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** UI glyph. For a mini-app's own empty screen, pass `art` instead. */
  icon?: IconName;
  /** Approved mini-app artwork (a `<MiniAppIcon>`), when that reads better. */
  art?: ReactNode;
  /** Primary next step. Strongly recommended. */
  action?: ReactNode;
  /** A quieter alternative next to `action`. */
  secondaryAction?: ReactNode;
  /** `md` for a whole page, `sm` inside a card. Default `md`. */
  size?: 'sm' | 'md';
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  art,
  action,
  secondaryAction,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        'flex flex-col items-center rounded-lg border border-dashed border-line-strong text-center',
        size === 'md' ? 'gap-3 px-6 py-12 sm:py-16' : 'gap-2 px-4 py-8',
        className,
      )}
    >
      {art ?? (
        <span
          aria-hidden
          className={cx(
            'mb-1 grid place-items-center rounded-full bg-canvas-tint text-ink-subtle',
            size === 'md' ? 'size-14' : 'size-11',
          )}
        >
          <Icon name={icon ?? 'sparkle'} size={size === 'md' ? 24 : 20} />
        </span>
      )}

      <p
        className={cx(
          'font-display font-semibold text-ink',
          size === 'md' ? 'text-lg' : 'text-md',
        )}
      >
        {title}
      </p>

      {description ? (
        <p className="max-w-[46ch] text-base text-ink-muted">{description}</p>
      ) : null}

      {action || secondaryAction ? (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
