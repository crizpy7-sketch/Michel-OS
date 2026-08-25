import type { ReactNode } from 'react';
import type { Severity } from '../../lib/contracts/index.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { cx } from './cx.ts';

/**
 * Callout — an inline banner. Covers the success state SPEC §9 asks for, and
 * is the standard shape for a conflict notice inside a screen.
 *
 * Like `Pill`, it never leans on colour: each tone carries a distinct glyph
 * silhouette and a written label, and `critical`/`warn` get `role="alert"`
 * so assistive tech is told rather than left to notice.
 */
export type CalloutTone = 'ok' | 'warn' | 'critical' | 'info' | 'accent';

interface ToneSpec {
  wrap: string;
  mark: string;
  icon: IconName;
  label: string;
  live: boolean;
}

const TONE: Record<CalloutTone, ToneSpec> = {
  ok: {
    wrap: 'border-ok bg-ok-soft',
    mark: 'text-ok',
    icon: 'check',
    label: 'Done',
    live: false,
  },
  warn: {
    wrap: 'border-warn bg-warn-soft',
    mark: 'text-warn',
    icon: 'severity-warning',
    label: 'Warning',
    live: true,
  },
  critical: {
    wrap: 'border-critical bg-critical-soft',
    mark: 'text-critical',
    icon: 'severity-blocking',
    label: 'Blocking',
    live: true,
  },
  info: {
    wrap: 'border-info bg-info-soft',
    mark: 'text-info',
    icon: 'severity-info',
    label: 'Note',
    live: false,
  },
  accent: {
    wrap: 'border-hairline-gold bg-accent-soft',
    mark: 'text-accent-strong',
    icon: 'sparkle',
    label: 'Suggestion',
    live: false,
  },
};

export interface CalloutProps {
  children?: ReactNode;
  tone?: CalloutTone;
  title?: ReactNode;
  /** Overrides the tone's default written label (e.g. "Conflict"). */
  label?: string;
  /** Buttons — "Resolve", "Undo", "See options". */
  actions?: ReactNode;
  className?: string;
}

export function Callout({
  children,
  tone = 'info',
  title,
  label,
  actions,
  className,
}: CalloutProps) {
  const spec = TONE[tone];
  return (
    <div
      role={spec.live ? 'alert' : undefined}
      className={cx('rounded-md border p-3.5 sm:p-4', spec.wrap, className)}
    >
      <div className="flex gap-3">
        <span className={cx('mt-0.5 shrink-0', spec.mark)}>
          <Icon name={spec.icon} size={18} />
        </span>

        <div className="min-w-0 flex-1">
          <p
            className={cx(
              'text-2xs font-semibold uppercase tracking-[0.16em]',
              spec.mark,
            )}
          >
            {label ?? spec.label}
          </p>
          {title ? <p className="mt-1 text-md font-semibold text-ink">{title}</p> : null}
          {children ? <div className="mt-1 text-base text-ink-muted">{children}</div> : null}
          {actions ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Maps the frozen `Severity` union onto a `Callout` tone. */
export const SEVERITY_CALLOUT_TONE: Record<Severity, CalloutTone> = {
  info: 'info',
  warning: 'warn',
  blocking: 'critical',
};
