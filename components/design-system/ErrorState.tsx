import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { cx } from './cx.ts';

/**
 * ErrorState — "we tried and it failed" (SPEC §9).
 *
 * Server-component safe by design: it takes an `action` **slot**, not an
 * `onRetry` callback, because a function prop cannot cross the server/client
 * boundary. Screens that need a retry pass their own `'use client'` button:
 *
 *   <ErrorState
 *     title="Couldn't load the schedule"
 *     detail={error.message}
 *     action={<RetryButton />}
 *   />
 *
 * `detail` is for the terse technical reason. Never put a raw stack trace or
 * an unfiltered server message in `title` — that line is read by a parent
 * checking their kid's practice time, not by an engineer.
 */
export interface ErrorStateProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Short technical reason, rendered in a de-emphasised monospace line. */
  detail?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'The information could not be loaded. Nothing was changed.',
  detail,
  action,
  secondaryAction,
  size = 'md',
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-center rounded-lg border border-critical bg-critical-soft text-center',
        size === 'md' ? 'gap-3 px-6 py-10 sm:py-14' : 'gap-2 px-4 py-6',
        className,
      )}
    >
      {/* Octagon glyph + the word "Error" — never colour alone. */}
      <span className="inline-flex items-center gap-2 text-critical">
        <Icon name="severity-blocking" size={size === 'md' ? 22 : 18} />
        <span className="text-2xs font-semibold uppercase tracking-[0.16em]">Error</span>
      </span>

      <p
        className={cx('font-display font-semibold text-ink', size === 'md' ? 'text-lg' : 'text-md')}
      >
        {title}
      </p>

      {description ? (
        <p className="max-w-[48ch] text-base text-ink-muted">{description}</p>
      ) : null}

      {detail ? (
        <p className="max-w-full truncate font-mono text-xs text-ink-subtle" title={String(detail)}>
          {detail}
        </p>
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

/**
 * PermissionDeniedState — SPEC §9 requires this as a distinct state, and the
 * permission model (`lib/contracts` → `Permission`) makes it a real, common
 * outcome: a teen opening the business hub, a viewer opening finance.
 *
 * It is deliberately *not* an error: nothing failed, the answer is "not you".
 */
export interface PermissionDeniedStateProps {
  /** The permission that was missing, e.g. `'finance.read'`. */
  permission?: string;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function PermissionDeniedState({
  permission,
  title = 'You do not have access to this',
  description = 'Ask a household owner to grant you access, or head back to your own schedule.',
  action,
  className,
}: PermissionDeniedStateProps) {
  return (
    <div
      className={cx(
        'flex flex-col items-center gap-3 rounded-lg border border-line bg-canvas-tint px-6 py-10 text-center sm:py-14',
        className,
      )}
    >
      <span className="inline-flex items-center gap-2 text-ink-muted">
        <Icon name="severity-info" size={22} />
        <span className="text-2xs font-semibold uppercase tracking-[0.16em]">Restricted</span>
      </span>

      <p className="font-display text-lg font-semibold text-ink">{title}</p>
      <p className="max-w-[48ch] text-base text-ink-muted">{description}</p>

      {permission ? (
        <p className="font-mono text-xs text-ink-subtle">Requires: {permission}</p>
      ) : null}

      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
