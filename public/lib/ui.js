/**
 * Shared components (Agent L).
 *
 * UI_RESPONSIVE_SPEC §9 requires loading, empty, error, success and
 * permission-denied states on every major page. They live here as functions
 * rather than as per-page markup for one reason: a state that has to be
 * hand-written on each screen is a state that gets forgotten on the fifth one,
 * and the forgotten one is always the error.
 */

import { $, append, clear, h, render, svg } from './dom.js';
import { state } from './state.js';
import { initial, memberColor, plural } from './format.js';

/* ---------------------------------------------------------------- states */

/** The skeleton, shaped like the content it is standing in for. */
export function loading(shape = 'list') {
  const box = h('div', { class: 'stack', 'aria-busy': 'true', 'aria-label': 'Loading' });
  if (shape === 'grid') {
    const grid = h('div', { class: 'grid' });
    for (let i = 0; i < 12; i += 1) grid.append(h('div', { class: 'skeleton skeleton--tile' }));
    box.append(grid);
  } else if (shape === 'dash') {
    const dash = h('div', { class: 'dash' });
    for (let i = 0; i < 4; i += 1) dash.append(h('div', { class: 'skeleton', style: { height: '8rem' } }));
    box.append(dash);
  } else {
    for (let i = 0; i < 5; i += 1) box.append(h('div', { class: 'skeleton skeleton--entry' }));
  }
  return box;
}

export function empty({ title, body, action } = {}) {
  return h('div', { class: 'state' },
    icon(ICONS.empty, 34),
    h('p', { class: 'state__title' }, title ?? 'Nothing here yet'),
    body ? h('p', { class: 'state__body' }, body) : null,
    action ?? null,
  );
}

export function errorState(error, retry) {
  // An offline failure is reported as offline. Telling somebody on a patchy
  // connection that "something went wrong" sends them hunting for a bug that
  // is not there.
  const offline = error?.code === 'offline';
  return h('div', { class: 'state state--error', role: 'alert' },
    icon(offline ? ICONS.offline : ICONS.alert, 34),
    h('p', { class: 'state__title' }, offline ? 'No connection' : 'That did not load'),
    h('p', { class: 'state__body' }, error?.message ?? 'Try again in a moment.'),
    retry ? h('button', { class: 'btn', type: 'button', onClick: retry }, 'Try again') : null,
  );
}

/**
 * The permission-denied state.
 *
 * Says who to ask, not just that the door is shut. "Ask a parent" is actionable
 * for a teenager; "403 Forbidden" is not.
 */
export function denied(what = 'this') {
  return h('div', { class: 'state state--denied' },
    icon(ICONS.lock, 34),
    h('p', { class: 'state__title' }, 'Not available to you'),
    h('p', { class: 'state__body' },
      `Your account can see the calendar, but not ${what}. An owner of this household can change that.`),
  );
}

/* ---------------------------------------------------------------- toasts */

let toastSeq = 0;

/**
 * A transient message.
 *
 * The rail is `aria-live="polite"`, so a screen reader finishes its sentence
 * before announcing — `assertive` here would interrupt someone mid-word every
 * time a shopping item was ticked off.
 */
export function toast(message, kind = 'good') {
  const rail = $('[data-toasts]');
  if (rail === null) return;

  const id = (toastSeq += 1);
  const node = h('div', { class: `toast toast--${kind}`, dataset: { toast: String(id) } }, message);
  rail.append(node);

  setTimeout(() => {
    node.remove();
  }, kind === 'error' ? 6000 : 3200);
}

/* ----------------------------------------------------------------- sheet */

let closeSheet = null;

/**
 * Open the bottom sheet (a centred dialog from tablet up — one component, two
 * arrangements, decided in CSS).
 *
 * Focus is moved into the panel and restored on close, Escape closes it, and a
 * click on the backdrop closes it. Without the focus handling a keyboard user
 * tabs straight out of an open dialog into the page behind it.
 */
export function sheet(title, build) {
  const root = $('[data-sheet]');
  if (root === null) return () => {};

  const previouslyFocused = document.activeElement;
  $('[data-sheet-title]').textContent = title;
  render($('[data-sheet-body]'), build(close));
  root.hidden = false;

  const panel = root.querySelector('.sheet__panel');
  const focusable = panel.querySelector('input, select, textarea, button, [tabindex]');
  (focusable ?? panel).focus?.();

  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;

    // Trap Tab inside the panel: a dialog you can tab out of is a dialog a
    // screen-reader user cannot tell they are still inside.
    const stops = [...panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => el.offsetParent !== null);
    if (stops.length === 0) return;

    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function onBackdrop(event) {
    if (event.target === root) close();
  }

  function close() {
    root.hidden = true;
    clear($('[data-sheet-body]'));
    document.removeEventListener('keydown', onKey);
    root.removeEventListener('click', onBackdrop);
    closeSheet = null;
    previouslyFocused?.focus?.();
  }

  document.addEventListener('keydown', onKey);
  root.addEventListener('click', onBackdrop);
  closeSheet = close;
  return close;
}

export function dismissSheet() {
  if (closeSheet !== null) closeSheet();
}

/* ------------------------------------------------------------ components */

/** A section with a heading and an optional action on the right. */
export function section(title, action, ...children) {
  return h('section', { class: 'section' },
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title' }, title),
      action ? h('div', { class: 'section__action' }, action) : null,
    ),
    ...children,
  );
}

export function card(title, meta, ...children) {
  return h('div', { class: 'card' },
    title ? h('div', { class: 'card__head' },
      h('h3', { class: 'card__title' }, title),
      meta ? h('span', { class: 'card__meta' }, meta) : null,
    ) : null,
    ...children,
  );
}

/**
 * A member avatar: their colour, their initial, their name for a screen reader.
 *
 * The initial and the label are what carry the meaning; the colour is
 * decoration. §8 forbids conveying information by colour alone, and a row of
 * coloured dots is exactly that.
 */
export function who(member) {
  const name = member?.displayName ?? 'Someone';
  return h('span', {
    class: 'who',
    style: { background: memberColor(member) },
    title: name,
    'aria-label': name,
  }, initial(name));
}

export function whoRow(memberIds) {
  const people = memberIds.map((id) => state.memberById(id)).filter(Boolean);
  if (people.length === 0) return null;
  return h('span', {
    class: 'who-row',
    'aria-label': people.map((p) => p.displayName).join(', '),
  }, ...people.slice(0, 4).map(who),
    people.length > 4 ? h('span', { class: 'who' }, `+${people.length - 4}`) : null);
}

export const chip = (text, kind = 'quiet') => h('span', { class: `chip chip--${kind}` }, text);

/** A labelled form field that can show its own error. */
export function field(label, control, { hint, error } = {}) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  if (error) control.setAttribute('aria-invalid', 'true');

  return h('label', { class: `field${error ? ' field--invalid' : ''}`, for: id },
    h('span', { class: 'field__label' }, label),
    control,
    hint ? h('span', { class: 'field__hint' }, hint) : null,
    // `role="alert"` so the message is announced when it appears, rather than
    // only being read if the person happens to navigate back to the field.
    error ? h('span', { class: 'field__error', role: 'alert' }, error) : null,
  );
}

export const input = (attrs = {}) => h('input', { class: 'input', ...attrs });
export const textarea = (attrs = {}) => h('textarea', { class: 'textarea', ...attrs });

export function select(options, attrs = {}) {
  return h('select', { class: 'select', ...attrs },
    ...options.map(([value, label]) => h('option', { value }, label)));
}

export function button(label, { kind = '', onClick, type = 'button', ...rest } = {}) {
  return h('button', { class: `btn${kind ? ` btn--${kind}` : ''}`, type, onClick, ...rest }, label);
}

/** A count, when there is one. `null` when zero, so it renders as nothing. */
export const countChip = (count, one, kind = 'quiet') =>
  count > 0 ? chip(plural(count, one), kind) : null;

/* ----------------------------------------------------------------- icons */

export const ICONS = {
  empty:   ['M5 7.5h14v12H5zM5 7.5 8 4h8l3 3.5M9.5 11.5h5'],
  alert:   ['M12 4.5 21 20H3zM12 10v4.5M12 17.4v.1'],
  lock:    ['M6.5 11h11v9h-11zM9 11V8a3 3 0 0 1 6 0v3'],
  offline: ['M3 3l18 18M8.5 12.5a5 5 0 0 1 3-1.4M5 9a10 10 0 0 1 3.5-2.2M19 9a10 10 0 0 0-8-2.8M12 18v.1'],
  check:   ['M5 12.5l4.5 4.5L19 7.5'],
  plus:    ['M12 6v12M6 12h12'],
  clock:   ['M12 6.5V12l3.5 2', 'M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0'],
  bell:    ['M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10zM10 19a2 2 0 0 0 4 0'],
  cart:    ['M4 5h2l2.5 10h9L20 8H7', 'M9.5 19.5v.1M17 19.5v.1'],
  search:  ['M16 16l4.5 4.5', 'M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0'],
};

export const icon = (paths, size = 20) => svg(paths, { size });

/* ------------------------------------------------------------- utilities */

/**
 * Wrap an async view so it shows loading, then content, then the right state
 * for whatever went wrong.
 *
 * This is the only place a view's error handling lives. A screen that writes
 * its own try/catch is a screen that will get one of the five states wrong.
 */
export async function withStates(mount, shape, load, build) {
  render(mount, loading(shape));
  let data;
  try {
    data = await load();
  } catch (error) {
    if (error.isDenied) { render(mount, denied()); return; }
    render(mount, errorState(error, () => { void withStates(mount, shape, load, build); }));
    return;
  }
  try {
    render(mount, build(data));
  } catch (error) {
    // A renderer that throws would otherwise leave the skeleton on screen
    // forever, which looks like a hang rather than a bug.
    console.error('[ui] render failed', error);
    render(mount, errorState({ message: 'This screen could not be drawn.' }));
  }
}

export { append, clear, h, render, $ };
