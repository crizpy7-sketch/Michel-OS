import type { ReactNode } from 'react';
import type { Severity } from '../../lib/contracts/index.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { cx } from './cx.ts';

/**
 * Pill — a small status chip.
 *
 * Rule that governs this component (SPEC §8): **status is never carried by
 * colour alone.** Every semantic tone renders a text label, and the severity
 * tones additionally render a glyph with a distinct silhouette (circle /
 * triangle / octagon). Strip the colour and the pill still reads.
 */
export type PillTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'critical' | 'info';
export type PillSize = 'sm' | 'md';

const TONE: Record<PillTone, string> = {
  neutral: 'bg-canvas-tint text-ink-muted border-line-strong',
  accent: 'bg-accent-soft text-accent-strong border-hairline-gold',
  ok: 'bg-ok-soft text-ok border-ok',
  warn: 'bg-warn-soft text-warn border-warn',
  critical: 'bg-critical-soft text-critical border-critical',
  info: 'bg-info-soft text-info border-info',
};

const SIZE: Record<PillSize, string> = {
  sm: 'gap-1 px-2 py-0.5 text-2xs',
  md: 'gap-1.5 px-2.5 py-1 text-xs',
};

export interface PillProps {
  children: ReactNode;
  tone?: PillTone;
  size?: PillSize;
  /** Leading glyph. Decorative — the visible text is the label. */
  icon?: IconName;
  /** Renders a small dot instead of a glyph. Only for `neutral`/`accent`. */
  dot?: boolean;
  className?: string;
  title?: string;
}

export function Pill({
  children,
  tone = 'neutral',
  size = 'md',
  icon,
  dot = false,
  className,
  title,
}: PillProps) {
  return (
    <span
      title={title}
      data-tone={tone}
      className={cx(
        'inline-flex max-w-full items-center rounded-full border font-semibold',
        TONE[tone],
        SIZE[size],
        className,
      )}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 12 : 14} /> : null}
      {!icon && dot ? (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ severity */

interface SeverityPresentation {
  tone: PillTone;
  icon: IconName;
  label: string;
  /** Longer form for `title` / screen-reader context. */
  description: string;
}

/**
 * The single mapping from the frozen `Severity` union to its presentation.
 * Exported so a screen can reuse the label/glyph outside a pill (a table
 * cell, a banner heading) and stay consistent with everything else.
 */
export const SEVERITY_PRESENTATION: Record<Severity, SeverityPresentation> = {
  info: {
    tone: 'info',
    icon: 'severity-info',
    label: 'Info',
    description: 'Worth knowing — nothing is blocked.',
  },
  warning: {
    tone: 'warn',
    icon: 'severity-warning',
    label: 'Warning',
    description: 'Needs a look — this schedule is tight or contested.',
  },
  blocking: {
    tone: 'critical',
    icon: 'severity-blocking',
    label: 'Blocking',
    description: 'Cannot stand as scheduled — someone has to move.',
  },
};

export interface SeverityPillProps {
  severity: Severity;
  size?: PillSize;
  /** Override the visible text. The glyph and tone still follow `severity`. */
  children?: ReactNode;
  className?: string;
}

/**
 * SeverityPill — use this for anything the conflict engine emits. It keeps
 * the label, the shape and the colour locked together so severity can never
 * degrade into "the red one".
 */
export function SeverityPill({ severity, size = 'md', children, className }: SeverityPillProps) {
  const p = SEVERITY_PRESENTATION[severity];
  return (
    <Pill tone={p.tone} size={size} icon={p.icon} title={p.description} className={className}>
      {children ?? p.label}
    </Pill>
  );
}
