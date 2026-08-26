/**
 * DOM construction (Agent L).
 *
 * The whole client renders through `h()`. There is no template string anywhere
 * that becomes markup, and `innerHTML` appears exactly once in this file — in
 * `clear()`, emptying an element, where there is no content to inject.
 *
 * That is the point. Everything on these screens is text somebody in the family
 * typed: an event title, a shopping item, a note about a shift. If any of it
 * reached the page as markup, then "Buy 3 <b>big</b> bags" would render as
 * markup at best, and a pasted `<img onerror=...>` would run at worst. Building
 * nodes and setting `textContent` makes that impossible by construction rather
 * than by remembering to escape.
 */

/**
 * Create an element.
 *
 *   h('div', { class: 'card' }, h('h2', {}, 'Title'), 'text')
 *
 * Attributes are set with `setAttribute` except for the handful that must be
 * properties (`value`, `checked`, `disabled`) — setting those as attributes
 * only works before the user has touched the control, which is a bug that
 * appears the second time a form is rendered.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'hidden') {
      el[key] = value;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }

  append(el, children);
  return el;
}

/** Append children, flattening arrays and skipping nothing-values. */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** An inline SVG built the same way, so icons cannot inject markup either. */
export function svg(paths, attrs = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const root = document.createElementNS(NS, 'svg');
  root.setAttribute('viewBox', attrs.viewBox ?? '0 0 24 24');
  root.setAttribute('fill', 'none');
  root.setAttribute('stroke', 'currentColor');
  root.setAttribute('stroke-width', String(attrs.width ?? 1.8));
  root.setAttribute('stroke-linecap', 'round');
  root.setAttribute('stroke-linejoin', 'round');
  root.setAttribute('aria-hidden', 'true');
  if (attrs.class) root.setAttribute('class', attrs.class);
  if (attrs.size) { root.setAttribute('width', attrs.size); root.setAttribute('height', attrs.size); }

  for (const d of [paths].flat()) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    root.append(path);
  }
  return root;
}

export function clear(el) {
  el.innerHTML = '';
  return el;
}

/** Replace everything inside `el` with `children`, in one paint. */
export function render(el, ...children) {
  clear(el);
  return append(el, children);
}

/** `$('[data-view]')` — a shorthand that keeps the query in one place. */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Move keyboard focus to a heading after a client-side navigation.
 *
 * Without this a screen reader stays where it was and announces nothing, so the
 * page appears not to have changed. `tabindex="-1"` on the target makes it
 * focusable without adding it to the tab order.
 */
export function focusMain() {
  const main = $('[data-view]');
  if (main !== null) main.focus({ preventScroll: true });
}
