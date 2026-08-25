import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * Stack — the layout primitive.
 *
 * Screens should not hand-roll `flex flex-col gap-4 items-start` strings.
 * Use `<Stack>` (column) or `<Stack direction="row">`, and let the gap scale
 * stay consistent across every screen in the product.
 *
 *   <Stack gap={4}>…</Stack>                    vertical rhythm
 *   <Stack direction="row" align="center" gap={3}>…</Stack>
 *   <Stack direction="row" justify="between">…</Stack>
 *   <Stack direction="responsive">…</Stack>     column on phone, row at md+
 */
export type StackGap = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12;
export type StackDirection = 'col' | 'row' | 'responsive' | 'row-reverse';
export type StackAlign = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
export type StackJustify = 'start' | 'center' | 'end' | 'between' | 'around';
export type StackTag = 'div' | 'section' | 'ul' | 'ol' | 'li' | 'nav' | 'header' | 'footer' | 'form';

const GAP: Record<StackGap, string> = {
  0: 'gap-0',
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  5: 'gap-5',
  6: 'gap-6',
  8: 'gap-8',
  10: 'gap-10',
  12: 'gap-12',
};

const DIRECTION: Record<StackDirection, string> = {
  col: 'flex-col',
  row: 'flex-row',
  'row-reverse': 'flex-row-reverse',
  responsive: 'flex-col md:flex-row',
};

const ALIGN: Record<StackAlign, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
  baseline: 'items-baseline',
};

const JUSTIFY: Record<StackJustify, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
  around: 'justify-around',
};

export interface StackProps {
  children?: ReactNode;
  /** Default `col`. `responsive` = column on phone, row from 768px up. */
  direction?: StackDirection;
  /** Multiples of 4px, from the shared spacing scale. Default `4` (16px). */
  gap?: StackGap;
  align?: StackAlign;
  justify?: StackJustify;
  wrap?: boolean;
  /** Makes the stack fill its flex parent. */
  grow?: boolean;
  as?: StackTag;
  className?: string;
  id?: string;
  role?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function Stack({
  children,
  direction = 'col',
  gap = 4,
  align,
  justify,
  wrap = false,
  grow = false,
  as: Tag = 'div',
  className,
  ...rest
}: StackProps) {
  return (
    <Tag
      className={cx(
        'flex min-w-0',
        DIRECTION[direction],
        GAP[gap],
        align && ALIGN[align],
        justify && JUSTIFY[justify],
        wrap && 'flex-wrap',
        grow && 'flex-1',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/**
 * Spacer — pushes siblings apart inside a row Stack without a justify change.
 */
export function Spacer() {
  return <span aria-hidden className="flex-1" />;
}
