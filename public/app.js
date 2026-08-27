/**
 * Michel-OS client (Agent L).
 *
 * Boot, routing, and the shell wiring. Views live in `views/` and are imported
 * on demand, so opening the calendar does not download the business ledger.
 *
 * There is no framework. The reason is the same one behind the rest of the
 * stack (ADR-001): this app has to be maintainable by whoever picks it up, on a
 * VPS, years from now, and a dependency-free client is one that still builds
 * when nothing else does. The cost is that state and DOM are wired by hand,
 * which is fine at this size and would not be at ten times it.
 */

import { $, $$, focusMain, render } from './lib/dom.js';
import { ApiError } from './lib/api.js';
import { refresh, reset, state } from './lib/state.js';
import { errorState, loading, toast, dismissSheet } from './lib/ui.js';
import { applyAppearance } from './lib/theme.js';

/* ---------------------------------------------------------------- routes */

/**
 * Path → view module. Ordered, first match wins, `:param` captures a segment.
 *
 * Every entry is a dynamic import. On a phone this matters: the home screen is
 * the only thing that has to arrive before the family sees something.
 */
const ROUTES = [
  ['/',                     () => import('./views/home.js'),      'Home'],
  ['/schedule',             () => import('./views/schedule.js'),  'All Schedules'],
  ['/add',                  () => import('./views/compose.js'),   'Add'],
  ['/assistant',            () => import('./views/assistant.js'), 'Assistant'],
  ['/more',                 () => import('./views/more.js'),      'More'],
  ['/search',               () => import('./views/search.js'),    'Search'],
  ['/inbox',                () => import('./views/inbox.js'),     'Inbox'],
  ['/shopping',             () => import('./views/lists.js'),     'Shopping'],
  ['/errands',              () => import('./views/lists.js'),     'Errands'],
  ['/reminders',            () => import('./views/lists.js'),     'Reminders'],
  ['/business',             () => import('./views/business.js'),  'Shia Baby'],
  ['/business/:section',    () => import('./views/business.js'),  'Shia Baby'],
  ['/notifications',        () => import('./views/notifications.js'), 'Notifications'],
  ['/household',            () => import('./views/household.js'), 'Household'],
  ['/app/:key',             () => import('./views/miniapp.js'),   null],
  ['/event/:eventId',       () => import('./views/event.js'),     'Event'],
];

function match(pathname) {
  const actual = pathname.replace(/\/+$/, '') || '/';

  for (const [pattern, load, title] of ROUTES) {
    const expected = pattern.split('/').filter(Boolean);
    const got = actual.split('/').filter(Boolean);
    if (expected.length !== got.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i].startsWith(':')) params[expected[i].slice(1)] = decodeURIComponent(got[i]);
      else if (expected[i] !== got[i]) { ok = false; break; }
    }
    if (ok) return { load, title, params, pattern };
  }
  return null;
}

/* ------------------------------------------------------------ navigation */

let currentToken = 0;

export function navigate(href, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', href);
  else history.pushState({}, '', href);
  void show();
}

async function show() {
  // Every navigation gets a token. An older view that finishes loading after a
  // newer one started must not paint over it — that is the bug where tapping
  // two tiles quickly leaves you on the first one.
  const token = (currentToken += 1);
  const mount = $('[data-view]');
  dismissSheet();

  const route = match(location.pathname);
  document.body.dataset.path = location.pathname;
  document.body.removeAttribute('data-miniapp');
  if (route === null) {
    render(mount, errorState({ message: 'That page does not exist.' }));
    setTitle('Not found');
    return;
  }

  document.body.dataset.route = route.pattern;
  markActiveNav(route.pattern);
  render(mount, loading(route.pattern === '/' ? 'grid' : 'list'));

  let module;
  try {
    module = await route.load();
  } catch (error) {
    // A chunk that fails to load is almost always a deploy that replaced it
    // mid-session, so the honest fix is a reload rather than a retry button.
    console.error('[router] failed to load view', error);
    if (token === currentToken) {
      render(mount, errorState({ message: 'The app was updated. Reload to continue.' },
        () => location.reload()));
    }
    return;
  }
  if (token !== currentToken) return;

  setTitle(route.title);
  $('[data-back]').hidden = route.pattern === '/' || history.length <= 1;

  try {
    await module.render(mount, route.params, { navigate, setTitle });
  } catch (error) {
    if (token !== currentToken) return;
    if (error instanceof ApiError && error.isAuth) { void signOutLocally(); return; }
    console.error('[router] view failed', error);
    render(mount, errorState(error, () => void show()));
  }

  if (token === currentToken) focusMain();
}

function setTitle(title) {
  const heading = $('[data-title]');
  if (title !== null && title !== undefined) {
    heading.textContent = title;
    document.title = `${title} · Michel-OS`;
  }
}

function markActiveNav(pattern) {
  for (const link of $$('[data-nav]')) {
    const isCurrent = link.dataset.nav === pattern;
    if (isCurrent) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/* ------------------------------------------------------------------ boot */

async function signOutLocally() {
  reset();
  const { render: renderAuth } = await import('./views/auth.js');
  document.body.dataset.route = 'auth';
  document.body.dataset.path = '/auth';
  renderAuth($('[data-view]'), { onSignedIn: () => { void start(); } });
  setTitle('Sign in');
}

async function start() {
  const mount = $('[data-view]');
  render(mount, loading('grid'));

  let signedIn;
  try {
    signedIn = await refresh();
  } catch (error) {
    render(mount, errorState(error, () => void start()));
    return;
  }

  if (!signedIn) { await signOutLocally(); return; }

  if (state.household === null) {
    // Signed in, but belongs to no household: the only useful thing to offer is
    // creating one or entering an invitation.
    const { renderOnboarding } = await import('./views/auth.js');
    renderOnboarding(mount, { onReady: () => { void start(); } });
    setTitle('Welcome');
    return;
  }

  await show();
}

/* -------------------------------------------------------------- wiring */

/**
 * One delegated click listener for the whole app.
 *
 * Intercepts same-origin links so navigation is client-side, and deliberately
 * does NOT intercept: modified clicks (open-in-new-tab must keep working),
 * external links, downloads, or anything with `target`. Getting those wrong is
 * how a single-page app breaks the middle mouse button.
 */
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest?.('a[href]');
  if (link === null || link === undefined) return;
  if (link.target !== '' && link.target !== '_self') return;
  if (link.hasAttribute('download')) return;

  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin) return;

  event.preventDefault();
  if (url.pathname === location.pathname && url.search === location.search) return;
  navigate(url.pathname + url.search);
});

addEventListener('popstate', () => { void show(); });

$('[data-back]')?.addEventListener('click', () => {
  if (history.length > 1) history.back();
  else navigate('/');
});

$('[data-open-search]')?.addEventListener('click', () => { navigate('/search'); });

/**
 * `/` focuses search, the way it does everywhere else — but not while somebody
 * is typing into a field, which is how that shortcut usually goes wrong.
 */
addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
  event.preventDefault();
  navigate('/search');
});

/** Tell the family when the connection comes back, since views cache nothing. */
addEventListener('online', () => { toast('Back online'); void show(); });
addEventListener('offline', () => { toast('No connection — showing what was already loaded', 'error'); });

applyAppearance();
void start();
