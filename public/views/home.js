/**
 * The home screen (Agent L).
 *
 * PRODUCT_SPEC §2: "should feel like an iPhone home screen for family life, not
 * like a generic calendar." The summary answers "what is happening today", the
 * Morning Brief surfaces what needs attention, then the mini-app grid keeps the
 * rest of family life one tap away.
 */

import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, empty, icon, ICONS, section, whoRow, withStates } from '../lib/ui.js';
import { MINI_APPS } from '../lib/miniapps.js';
import { miniAppArt } from '../lib/art.js';
import { dayLong, humaniseDates, relativeDay, statusLabel, time, timeRange } from '../lib/format.js';

export async function render(mount, _params, { navigate }) {
  const householdId = state.household.id;

  await withStates(mount, 'grid',
    async () => {
      const now = new Date().toISOString();
      const to = new Date(Date.now() + 8 * 24 * 3600_000).toISOString();
      const [brief, upcoming, conflicts, notifications] = await Promise.all([
        api.get(`/api/households/${householdId}/brief`).catch(() => null),
        api.get(`/api/households/${householdId}/occurrences${query({ from: now, to })}`),
        api.get(`/api/households/${householdId}/conflicts${query({ from: now, to })}`).catch(() => ({ conflicts: [] })),
        api.get(`/api/households/${householdId}/notifications`).catch(() => ({ notifications: [] })),
      ]);
      return { brief: brief?.brief ?? null, upcoming, conflicts, notifications, now };
    },
    // The greeting and the launcher run full width; the two reading columns
    // below them sit side by side from tablet up and stack on a phone. On a
    // desktop the brief and the schedule were previously one narrow column of
    // 900px-wide cards holding two lines each, with everything below the fold.
    (data) => h('div', { class: 'home' },
      summary(data, navigate),
      grid(),
      h('div', { class: 'home__columns' },
        h('div', { class: 'home__column' }, morningBrief(data.brief, navigate)),
        h('div', { class: 'home__column' }, nextUp(data, navigate)),
      ),
    ));
}

/* --------------------------------------------------------------- summary */

function summary({ brief, upcoming, conflicts, notifications, now }, navigate) {
  const tz = state.timezone;
  const today = (upcoming.occurrences ?? []).filter((o) => relativeDay(o.occurrenceStart, tz, now) === 'Today');
  const unread = (notifications.notifications ?? []).filter((n) => n.readAt === null || n.readAt === undefined);
  const conflictCount = (conflicts.conflicts ?? []).length;
  const greeting = brief?.greeting ?? `Good ${partOfDay()}, ${state.member?.displayName ?? 'there'}.`;

  return h('div', { class: 'brief' },
    h('p', { class: 'brief__greeting' }, greeting),
    h('p', { class: 'brief__date' }, dayLong(now, tz)),
    h('div', { class: 'brief__stats' },
      stat(today.length, 'Today', today.length === 1 ? 'event today' : 'events today', '/schedule?mode=today', navigate),
      stat(brief?.reminders?.length ?? 0, 'To do', 'reminders due', '/reminders', navigate),
      stat(brief?.shoppingCount ?? 0, 'To buy', 'things to buy', '/shopping', navigate),
      stat(conflictCount, 'Clashes', conflictCount === 1 ? 'conflict' : 'conflicts', '/schedule', navigate, conflictCount > 0 ? 'alert' : null),
    ),
    unread.length > 0 ? h('button', {
      class: 'btn btn--quiet', type: 'button', style: { marginTop: '1rem' }, onClick: () => navigate('/notifications'),
    }, icon(ICONS.bell, 18), `${unread.length} to look at`) : null,
  );
}

function morningBrief(brief, navigate) {
  if (!brief) return null;
  const tomorrow = brief.tomorrow ?? [];
  const errands = brief.errands ?? [];
  const staffing = brief.staffingWarnings ?? [];
  const headline = brief.headline;
  const conflicts = brief.conflicts ?? [];

  if (tomorrow.length === 0 && errands.length === 0 && staffing.length === 0 && !headline && conflicts.length === 0) return null;

  return section('Morning Brief', null,
    headline ? card('Coming up', labelFor(headline.domain),
      h('button', { class: 'btn btn--quiet', type: 'button', onClick: () => navigate(`/schedule?domain=${encodeURIComponent(headline.domain)}`) }, `${headline.title} · ${dayLong(headline.startsAt, state.timezone)}`)) : null,
    tomorrow.length ? card('Tomorrow', `${tomorrow.length} scheduled`,
      ...tomorrow.slice(0, 4).map((item) => h('p', {}, h('strong', {}, time(item.occurrenceStart, state.timezone)), ` · ${item.title}`))) : null,
    errands.length ? card('Errands', `${errands.length} open`,
      ...errands.slice(0, 3).map((item) => h('p', {}, item.title)),
      h('a', { class: 'btn btn--quiet', href: '/errands' }, 'Open errands')) : null,
    staffing.length ? card('Shia Baby coverage', `${staffing.length} warning${staffing.length === 1 ? '' : 's'}`,
      ...staffing.slice(0, 4).map((message) => h('p', {}, chip('Warning', 'warn'), ` ${humaniseDates(message)}`)),
      h('a', { class: 'btn btn--quiet', href: '/business/staffing' }, 'Open staffing')) : null,
    conflicts.length ? card('Conflicts to resolve', `${conflicts.length}`,
      ...conflicts.slice(0, 3).map((conflict) => h('p', { class: 'brief-conflict' },
        chip(statusLabel(conflict.severity, 'Heads up'), conflict.severity === 'blocking' ? 'alert' : 'warn'),
        ` ${conflict.explanation}`)),
      h('a', { class: 'btn btn--quiet', href: '/schedule' }, 'See schedule')) : null,
  );
}

function stat(value, label, spoken, href, navigate, tone = null) {
  return h('button', {
    class: `stat${tone ? ` stat--${tone}` : ''}`, type: 'button', onClick: () => navigate(href), 'aria-label': `${value} ${spoken}`,
  }, h('span', { class: 'stat__value' }, String(value)), h('span', { class: 'stat__label' }, label));
}

function partOfDay() {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/* ------------------------------------------------------------------ grid */

function grid() {
  const primaryKeys = new Set([
    'appointments', 'practice', 'shia-baby', 'school', 'competition', 'games', 'errands', 'hubby-work', 'shopping',
  ]);
  const wrapper = h('div', { class: 'grid home-grid' });
  MINI_APPS.filter((app) => primaryKeys.has(app.key)).forEach((app, index) => {
    if (app.needs !== undefined && !state.can(app.needs)) return;
    const tile = h('a', { class: `tile tile--${app.key}`, href: app.route },
      h('div', { class: 'tile__art' }), h('span', { class: 'tile__label' }, app.label));
    wrapper.append(tile);
    void miniAppArt(app, { size: 88, eager: index < 6 }).then((art) => { tile.firstChild.replaceWith(art); });
  });
  return h('nav', { class: 'home-launcher', 'aria-label': 'Mini-apps' }, wrapper);
}

/* --------------------------------------------------------------- next up */

function nextUp({ upcoming, conflicts, now }, navigate) {
  const tz = state.timezone;
  const occurrences = (upcoming.occurrences ?? []).slice(0, 6);
  const conflicted = new Set();
  for (const conflict of conflicts.conflicts ?? []) {
    for (const ref of conflict.occurrenceRefs ?? conflict.refs ?? []) conflicted.add(ref.id ?? ref.eventId);
  }

  if (occurrences.length === 0) return section('Next up', null, empty({ title: 'Nothing scheduled', body: 'The next eight days are clear.' }));

  return section('Next up', h('a', { class: 'btn btn--quiet', href: '/schedule' }, 'See all'),
    ...occurrences.map((occurrence, index) => entry(occurrence, {
      tz, now, first: index === 0, conflict: conflicted.has(occurrence.eventId), navigate,
    })));
}

function entry(occurrence, { tz, now, first, conflict, navigate }) {
  const day = relativeDay(occurrence.occurrenceStart, tz, now);
  return h('button', {
    class: `entry${first ? ' entry--next' : ''}${conflict ? ' entry--conflict' : ''}`,
    type: 'button', onClick: () => navigate(`/event/${occurrence.eventId}`),
  },
    h('span', { class: 'entry__time' }, h('strong', {}, time(occurrence.occurrenceStart, tz)), day),
    h('span', {}, h('span', { class: 'entry__title' }, occurrence.title), h('span', { class: 'entry__sub' },
      timeRange(occurrence.occurrenceStart, occurrence.occurrenceEnd, tz), occurrence.location ? ` · ${occurrence.location}` : '')),
    h('span', { class: 'row' }, conflict ? chip('Clash', 'alert') : null, whoRow(occurrence.participantIds ?? [])),
  );
}

function labelFor(value) { return String(value ?? '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
