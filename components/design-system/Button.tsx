import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { cx } from './cx.ts';

/**
 * Button — the only clickable control in the system.
 *
 * Variants
 *   primary  the single most important action on the screen. Gold fill,
 *            midnight ink. Small area, high emphasis — this is exactly the
 *            "restrained metallic gold" the brief asks for. One per view.
 *   quiet    the default for everything else. Bordered, canvas-coloured.
 *   danger   destructive and irreversible only (delete, cancel a series).
 *   ghost    no chrome until hover — toolbars, icon buttons, card overflow.
 *
 * Accessibility
 *   - always a real <button> (or <a> via LinkButton) — never a styled div
 *   - `disabled` is a real attribute, and disabled buttons keep >= 3:1 edge
 *     contrast so they remain perceivable
 *   - `iconOnly` is type-enforced to require an `aria-label`
 *   - md/lg are >= 44px tall; `sm` keeps a 44px *hit area* via `.mos-tap`
 *     even though it paints smaller
 */
export type ButtonVariant = 'primary' | 'quiet' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'relative inline-flex select-none items-center justify-center gap-2 rounded-md font-semibold ' +
  'whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] ' +
  'duration-150 ease-[var(--ease-out-soft)] active:translate-y-px ' +
  'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55 ' +
  'disabled:shadow-none disabled:active:translate-y-0';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-ink border border-transparent shadow-card ' +
    'hover:bg-primary-hover active:bg-primary-active',
  quiet:
    'bg-surface text-ink border border-control-border ' +
    'hover:bg-canvas-tint hover:border-line-strong active:bg-canvas-tint',
  danger:
    'bg-critical text-critical-ink border border-transparent shadow-card ' +
    'hover:brightness-110 active:brightness-95',
  ghost:
    'bg-transparent text-ink-muted border border-transparent ' +
    'hover:bg-canvas-tint hover:text-ink active:bg-canvas-tint',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'mos-tap h-9 px-3 text-sm',
  md: 'min-h-11 px-4 py-2.5 text-base',
  lg: 'min-h-12 px-6 py-3 text-md',
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: 'mos-tap h-9 w-9 p-0',
  md: 'min-h-11 h-11 w-11 p-0',
  lg: 'min-h-12 h-12 w-12 p-0',
};

/**
 * The raw class string for a button, exported so screen agents can style a
 * control this package does not wrap (a `<label>` acting as a file picker,
 * a third-party trigger) without copying Tailwind strings around.
 */
export function buttonClasses(
  variant: ButtonVariant = 'quiet',
  size: ButtonSize = 'md',
  options?: { iconOnly?: boolean; block?: boolean },
): string {
  return cx(
    BASE,
    VARIANT[variant],
    options?.iconOnly ? ICON_SIZE[size] : SIZE[size],
    options?.block && 'w-full',
  );
}

interface ButtonBase {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full-width — the standard shape for a primary action on mobile. */
  block?: boolean;
  /** Leading glyph. Decorative: label the button with text or `aria-label`. */
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Sets `aria-busy`, disables the control and swaps in a spinner. */
  loading?: boolean;
  children?: ReactNode;
}

type IconOnlyProps = { iconOnly: true; 'aria-label': string } | { iconOnly?: false };

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> &
  ButtonBase & { className?: string } & IconOnlyProps;

export function Button(props: ButtonProps) {
  const {
    variant = 'quiet',
    size = 'md',
    block = false,
    leading,
    trailing,
    loading = false,
    iconOnly = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  } = props as ButtonProps & { iconOnly?: boolean };

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonClasses(variant, size, { iconOnly, block }), className)}
      {...rest}
    >
      {loading ? <Spinner /> : leading}
      {iconOnly ? null : children}
      {loading ? null : trailing}
    </button>
  );
}

export type LinkButtonProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className'> &
  Omit<ButtonBase, 'loading'> & {
    href: string;
    className?: string;
  } & IconOnlyProps;

/**
 * LinkButton — a navigation that *looks* like a button. Renders `next/link`,
 * so it prefetches and keeps client-side routing. Never use this for an
 * action that mutates state; use `Button` for that.
 */
export function LinkButton(props: LinkButtonProps) {
  const {
    href,
    variant = 'quiet',
    size = 'md',
    block = false,
    leading,
    trailing,
    iconOnly = false,
    className,
    children,
    ...rest
  } = props as LinkButtonProps & { iconOnly?: boolean };

  return (
    <Link
      href={href}
      className={cx(buttonClasses(variant, size, { iconOnly, block }), className)}
      {...rest}
    >
      {leading}
      {iconOnly ? null : children}
      {trailing}
    </Link>
  );
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden
      focusable="false"
      className="animate-spin"
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
