import type { SVGProps } from 'react';
import { cx } from './cx.ts';

/**
 * UI chrome glyphs — navigation, chevrons, severity shapes, affordances.
 *
 * IMPORTANT (ASSET_MAP.md): this set exists for *interface* iconography only.
 * It is never a substitute for approved mini-app artwork. Mini-app visuals
 * always come from `MiniAppIcon`, which renders the PNG in `public/icons/`.
 *
 * Severity glyphs have deliberately distinct silhouettes — circle / triangle /
 * octagon — so conflict severity survives greyscale, colour-blindness and
 * forced-colours mode (SPEC §8: never colour alone).
 */
export const ICON_NAMES = [
  'home',
  'calendar',
  'plus',
  'sparkle',
  'ellipsis',
  'storefront',
  'inbox',
  'chevron-right',
  'chevron-left',
  'chevron-down',
  'search',
  'bell',
  'clock',
  'severity-info',
  'severity-warning',
  'severity-blocking',
  'check',
  'close',
  'refresh',
  'arrow-right',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const PATHS: Record<IconName, string> = {
  home: 'M4 10.6 12 4l8 6.6V19a1.6 1.6 0 0 1-1.6 1.6h-3.2v-6H8.8v6H5.6A1.6 1.6 0 0 1 4 19z',
  calendar:
    'M4.5 8.6h15M7.5 3.8v3M16.5 3.8v3M5.9 5.4h12.2A1.4 1.4 0 0 1 19.5 6.8v11.8a1.4 1.4 0 0 1-1.4 1.4H5.9a1.4 1.4 0 0 1-1.4-1.4V6.8a1.4 1.4 0 0 1 1.4-1.4Z',
  plus: 'M12 5.4v13.2M5.4 12h13.2',
  sparkle:
    'M12 3.4 13.7 9 19.3 10.7 13.7 12.4 12 18 10.3 12.4 4.7 10.7 10.3 9zM18.2 16.1l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z',
  ellipsis: 'M6 12h.01M12 12h.01M18 12h.01',
  storefront:
    'M4.3 9.6h15.4v9.1a1.3 1.3 0 0 1-1.3 1.3H5.6a1.3 1.3 0 0 1-1.3-1.3zM4.9 4.6h14.2l1.3 3.4a2.4 2.4 0 0 1-4.6.9 2.4 2.4 0 0 1-4.6 0 2.4 2.4 0 0 1-4.6 0 2.4 2.4 0 0 1-4.6-.9zM9.8 20v-5.1h4.4V20',
  inbox:
    'M4.4 13.4h4l1.1 2.2h5l1.1-2.2h4M6.2 4.8h11.6l1.8 8.6v4.4a1.4 1.4 0 0 1-1.4 1.4H5.8a1.4 1.4 0 0 1-1.4-1.4v-4.4z',
  'chevron-right': 'M9.5 5.5 16 12l-6.5 6.5',
  'chevron-left': 'M14.5 5.5 8 12l6.5 6.5',
  'chevron-down': 'M5.5 9.5 12 16l6.5-6.5',
  search: 'M10.8 4.6a6.2 6.2 0 1 1 0 12.4 6.2 6.2 0 0 1 0-12.4ZM15.4 15.4 20 20',
  bell: 'M9.6 18.4a2.4 2.4 0 0 0 4.8 0M6 10.2a6 6 0 0 1 12 0c0 3.4 1.2 4.6 1.6 5.2a.6.6 0 0 1-.5 1H4.9a.6.6 0 0 1-.5-1c.4-.6 1.6-1.8 1.6-5.2Z',
  clock: 'M12 4.4a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2ZM12 7.9V12l2.9 1.9',
  'severity-info': 'M12 4.4a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2ZM12 11v5M12 8.1h.01',
  'severity-warning': 'M12 4.2 20.4 18.9a.9.9 0 0 1-.8 1.3H4.4a.9.9 0 0 1-.8-1.3zM12 9.8v4.1M12 16.7h.01',
  'severity-blocking':
    'M8.6 3.9h6.8l4.7 4.7v6.8l-4.7 4.7H8.6l-4.7-4.7V8.6zM9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6',
  check: 'M5.2 12.6 9.7 17l9.1-9.6',
  close: 'M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8',
  refresh:
    'M19.4 12a7.4 7.4 0 1 1-2.2-5.3M19.6 4.4v4.4h-4.4',
  'arrow-right': 'M4.6 12h14.2M13.2 6.2 19 12l-5.8 5.8',
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  /** Rendered size in px. Defaults to 20 — the UI-chrome default. */
  size?: number;
  /**
   * Accessible label. Omit for purely decorative glyphs sitting next to a
   * visible text label (the default: `aria-hidden`).
   */
  label?: string;
}

export function Icon({ name, size = 20, label, className, ...rest }: IconProps) {
  const decorative = label === undefined;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : 'img'}
      aria-label={label}
      focusable="false"
      className={cx('shrink-0', className)}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
