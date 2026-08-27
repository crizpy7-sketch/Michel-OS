/**
 * Formatting (Agent L).
 *
 * Every date on screen is rendered in the HOUSEHOLD's timezone, not the
 * device's. A parent travelling for work should see the practice at 6pm local
 * to home, because that is when it is; showing it at 4pm because their phone
 * is in a different zone is how somebody misses a pickup.
 *
 * `Intl` formatters are cached. Constructing one is expensive enough that doing
 * it per row visibly janks a long list — the same finding the performance
 * challenger raised against the domain tier.
 */

const cache = new Map();

function formatter(timezone, options) {
  const key = `${timezone}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options });
    cache.set(key, found);
  }
  return found;
}

/** `6:00 PM` */
export const time = (instant, tz) =>
  formatter(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(instant));

/** `Tue, Sep 8` */
export const dayShort = (instant, tz) =>
  formatter(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(instant));

/** `Tuesday, September 8` */
export const dayLong = (instant, tz) =>
  formatter(tz, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(instant));

/** `Sep 8` */
export const monthDay = (instant, tz) =>
  formatter(tz, { month: 'short', day: 'numeric' }).format(new Date(instant));

/** `2026-09-08` in the household's zone — the key a day-grouping uses. */
export function isoDate(instant, tz) {
  const parts = formatter(tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(instant));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `6:00 – 8:00 PM`, collapsing the meridiem when both ends share it. */
export function timeRange(startInstant, endInstant, tz) {
  const start = time(startInstant, tz);
  const end = time(endInstant, tz);
  const [startClock, startMeridiem] = start.split(' ');
  const [, endMeridiem] = end.split(' ');
  return startMeridiem === endMeridiem ? `${startClock} – ${end}` : `${start} – ${end}`;
}

/** `Today`, `Tomorrow`, `Yesterday`, or the date. */
export function relativeDay(instant, tz, now) {
  const target = isoDate(instant, tz);
  const today = isoDate(now, tz);
  if (target === today) return 'Today';

  const dayMs = 24 * 3600_000;
  if (target === isoDate(new Date(Date.parse(now) + dayMs).toISOString(), tz)) return 'Tomorrow';
  if (target === isoDate(new Date(Date.parse(now) - dayMs).toISOString(), tz)) return 'Yesterday';
  return dayShort(instant, tz);
}

/**
 * Integer cents to `$1,234.56`.
 *
 * Cents in, string out, and no float ever touches it: `(cents / 100)` then
 * formatted is where a ledger acquires its first rounding error.
 */
export function money(cents, { sign = false } = {}) {
  const negative = cents < 0;
  const absolute = Math.abs(Math.trunc(cents));
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const prefix = negative ? '−' : sign ? '+' : '';
  return `${prefix}$${grouped}.${fraction}`;
}

/** The initial shown in a member avatar. */
export function initial(name) {
  const trimmed = (name ?? '').trim();
  // `codePointAt` rather than `[0]`, so a name starting with an emoji or an
  // astral-plane character does not render as half a surrogate pair.
  return trimmed.length === 0 ? '?' : String.fromCodePoint(trimmed.codePointAt(0)).toUpperCase();
}

/** `3 items` / `1 item` — pluralised without a library. */
export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * A wire status turned into something a person would say.
 *
 * These values reach the screen straight out of the API — `needed`,
 * `purchased`, `blocking`, `draft` — and a lowercase enum in a chip reads like
 * a database leak. Anything not in the table falls back to sentence case rather
 * than being dropped, so a status added later is ugly rather than invisible.
 */
const STATUS_WORDS = {
  needed: 'To buy',
  purchased: 'Bought',
  open: 'Open',
  done: 'Done',
  pending: 'Waiting',
  completed: 'Done',
  dismissed: 'Dismissed',
  snoozed: 'Snoozed',
  draft: 'Draft',
  published: 'Published',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  blocking: 'Blocking',
  warning: 'Heads up',
  info: 'Note',
};

export function statusLabel(value, fallback = '') {
  const key = String(value ?? '').trim().toLowerCase();
  if (key.length === 0) return fallback;
  if (key in STATUS_WORDS) return STATUS_WORDS[key];
  const words = key.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Turn the ISO dates inside an engine-generated message into readable ones.
 *
 * The staffing engine composes its warnings with `2026-08-29` in them, which is
 * right for a log and wrong for a person reading their own shop's coverage.
 * Rewriting only the date literals leaves the engine's wording — and its
 * meaning — exactly as the engine wrote it.
 */
export function humaniseDates(message) {
  return String(message ?? '').replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, y, m, d) => {
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? whole : formatter('UTC', {
      weekday: 'short', month: 'short', day: 'numeric',
    }).format(date);
  });
}

/**
 * A stable colour for a member, when they have not chosen one.
 *
 * Derived from the id so it never changes between sessions, and drawn from a
 * fixed set that has been checked against the dark background rather than
 * generated from a hash, which produces mud about a third of the time.
 */
const MEMBER_COLORS = [
  '#e3c14f', '#5b8fd6', '#4fae7d', '#e2574c', '#b98ad4',
  '#e0913a', '#4fb6b6', '#d4728f', '#8fb45c', '#9a9ee0',
];

export function memberColor(member) {
  if (typeof member?.color === 'string' && /^#[0-9a-f]{6}$/i.test(member.color)) return member.color;
  const id = String(member?.id ?? '');
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return MEMBER_COLORS[hash % MEMBER_COLORS.length];
}
