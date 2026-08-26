/**
 * The app shell (Agent L).
 *
 * One HTML document, served for every non-API path, into which the client
 * renders. It is deliberately thin: a header, a nav, a mount point, and the
 * five states from UI_RESPONSIVE_SPEC §9 pre-rendered so the first paint is a
 * real skeleton rather than a blank screen waiting for JavaScript.
 *
 * Two constraints shape everything here.
 *
 * The CSP in `securityHeaders` has no `'unsafe-inline'` for scripts, so this
 * file contains no inline `<script>` and no `onclick`. Bootstrap data is not
 * embedded in the document at all — the client asks `/api/me` for it. That
 * costs one round trip and buys a shell that is identical for every visitor,
 * which means it can be cached, and a document that cannot leak one family's
 * data into another's cached page.
 *
 * The second is that the shell must be correct before any JavaScript runs. The
 * markup below is what a person sees on a slow connection, and it is a laid-out
 * skeleton with a visible title, not a spinner.
 */

/**
 * Escape text for HTML.
 *
 * Everything interpolated into this document goes through here. The set
 * includes `'` and `"` because the same function is used for attribute values,
 * and a helper that is safe in one context but not the other is a helper
 * somebody will eventually use in the wrong one.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ShellOptions {
  /** Page title. The product name is appended. */
  title?: string;
  /** Cache-busting suffix for the asset URLs, so a deploy is picked up. */
  version: string;
}

const PRODUCT = 'Michel-OS';

/**
 * The bottom tab bar / side rail (UI_RESPONSIVE_SPEC §7).
 *
 * Five destinations, the same five at every breakpoint — CSS turns the bar into
 * a rail and then a sidebar. Icons are inline SVG rather than an icon font or a
 * sprite request: five small paths cost less than the round trip, and inline
 * SVG inherits `currentColor`, so the active state needs no second asset.
 */
const NAV: ReadonlyArray<{ href: string; label: string; path: string; primary?: boolean }> = [
  { href: '/', label: 'Home', path: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5' },
  { href: '/schedule', label: 'Schedule', path: 'M4 6.5h16v14H4zM4 10.5h16M8.5 3v4M15.5 3v4' },
  { href: '/add', label: 'Add', path: 'M12 6v12M6 12h12', primary: true },
  { href: '/assistant', label: 'Assistant', path: 'M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5L4.5 11 10 9zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z' },
  { href: '/more', label: 'More', path: 'M5 12h.01M12 12h.01M19 12h.01' },
];

function navIcon(path: string, className: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="${path}"/></svg>`;
}

function navItems(kind: 'tabbar' | 'sidenav'): string {
  return NAV.map((item) => {
    const primary = kind === 'tabbar' && item.primary === true ? ` ${kind}__item--primary` : '';
    // `data-nav` is what the client router binds to; there is no inline handler.
    return `<a class="${kind}__item${primary}" href="${item.href}" data-nav="${escapeHtml(item.href)}">` +
      `${navIcon(item.path, `${kind}__icon`)}` +
      `<span class="${kind}__label">${escapeHtml(item.label)}</span>` +
      `</a>`;
  }).join('');
}

/**
 * The pre-rendered skeleton.
 *
 * Shaped like the home screen — a brief block and a tile grid — because that is
 * where most visits land, so the layout does not jump when the data arrives.
 */
const SKELETON = `
      <div class="brief" aria-hidden="true">
        <div class="skeleton skeleton--line" style="width:11rem;height:1.6rem"></div>
        <div class="skeleton skeleton--line" style="width:7rem"></div>
        <div class="brief__stats">
          <div class="skeleton" style="height:4.5rem"></div>
          <div class="skeleton" style="height:4.5rem"></div>
          <div class="skeleton" style="height:4.5rem"></div>
          <div class="skeleton" style="height:4.5rem"></div>
        </div>
      </div>
      <div class="grid" aria-hidden="true">
        ${'<div class="skeleton skeleton--tile"></div>'.repeat(9)}
      </div>`;

export function renderShell(options: ShellOptions): string {
  const version = encodeURIComponent(options.version);
  const title = options.title === undefined
    ? PRODUCT
    : `${escapeHtml(options.title)} · ${PRODUCT}`;

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="One place for the family's schedule.">
<meta name="theme-color" content="#0a0f1c">
<meta name="color-scheme" content="dark light">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="stylesheet" href="/app.css?v=${version}">
<script type="module" src="/app.js?v=${version}"></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<div class="shell">
  <nav class="sidenav" aria-label="Primary">${navItems('sidenav')}</nav>

  <div style="flex:1;min-width:0;display:flex;flex-direction:column">
    <header class="topbar">
      <button class="topbar__back" type="button" data-back hidden aria-label="Go back">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 5l-7 7 7 7"/>
        </svg>
      </button>
      <h1 class="topbar__title" data-title>${PRODUCT}</h1>
      <span class="topbar__spacer"></span>
      <button class="btn btn--quiet" type="button" data-open-search aria-label="Search">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>
        </svg>
      </button>
    </header>

    <main class="shell__body" id="main" data-view tabindex="-1">${SKELETON}</main>
  </div>
</div>

<nav class="tabbar" aria-label="Primary">${navItems('tabbar')}</nav>

<div class="toast-rail" data-toasts role="status" aria-live="polite"></div>
<div class="sheet" data-sheet hidden role="dialog" aria-modal="true" aria-labelledby="sheet-title">
  <div class="sheet__panel">
    <div class="sheet__grip"></div>
    <h2 class="sheet__title" id="sheet-title" data-sheet-title></h2>
    <div data-sheet-body></div>
  </div>
</div>

<noscript>
  <div class="state state--error" style="padding:2rem">
    <p class="state__title">JavaScript is switched off</p>
    <p class="state__body">Michel-OS needs it to show the calendar. Turn it on for this
      site and reload.</p>
  </div>
</noscript>
</body>
</html>
`;
}

/**
 * The PWA manifest.
 *
 * Generated rather than a static file so the icon URLs stay in step with
 * whatever `tools/assets/icons.ts` last produced — a manifest pointing at an
 * icon that was regenerated under a new content hash is an install prompt with
 * a broken picture.
 */
export function renderManifest(icons: ReadonlyArray<{ src: string; sizes: string }>): string {
  return `${JSON.stringify({
    name: 'Michel-OS — Family Scheduling',
    short_name: 'Michel-OS',
    description: "One place for the family's schedule.",
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0a0f1c',
    theme_color: '#0a0f1c',
    icons: icons.map((icon) => ({
      src: icon.src,
      sizes: icon.sizes,
      type: 'image/png',
      purpose: 'any',
    })),
  }, null, 2)}\n`;
}
