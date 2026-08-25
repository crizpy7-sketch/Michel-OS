/**
 * SkipLink — the first thing in the tab order.
 *
 * Off-screen until focused, then a real, high-contrast control (see
 * `.mos-skip-link` in globals.css). It targets `#main-content`, which the
 * dashboard shell puts on `<main tabindex="-1">` so focus actually lands
 * there rather than merely scrolling.
 */
export interface SkipLinkProps {
  targetId?: string;
  children?: string;
}

export function SkipLink({ targetId = 'main-content', children = 'Skip to content' }: SkipLinkProps) {
  return (
    <a href={`#${targetId}`} className="mos-skip-link">
      {children}
    </a>
  );
}
