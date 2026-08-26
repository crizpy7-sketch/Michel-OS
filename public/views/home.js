/**
 * The home screen (Agent L).
 *
 * PRODUCT_SPEC §2: "should feel like an iPhone home screen for family life, not
 * like a generic calendar." Two parts, in this order — the summary that answers
 * "what is happening today", then the grid of mini-apps.
 *
 * The summary comes first because it is the reason somebody opened the app. A
 * grid of thirteen icons above the fold, with the day's events below it, would
 * make the common case — a glance while walking out of the door — into a scroll.
 */

import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, empty, icon, ICONS, section, whoRow, withStates } from '../lib/ui.js';
import { MINI_APPS } from '../lib/miniapps.js';
import { miniAppArt } from '../lib/art.js';
import { dayLong, relativeDay, time, timeRange } from '../lib/format.js';

export async function render(mount, _params, { navigate }) {
  const householdId = state.household.id;

  await withStates(mount, 'grid',
    async () => {
      const now = new Date().toISOString();
      const to = new Date(Date.now() + 8 * 24 * 3600_000).toISOString();

      // Four requests in parallel rather than in sequence. On a phone this is
      // the difference between one round trip and four, and there is no
      // ordering between them.
      const [brief, upcoming, conflicts, notifications] = await Promise.all([
        api.get(`/api/households/${householdId}/brief`).catch(() => null),
        api.get(`/api/households/${householdId}/occurrences${query({ from: now, to })}`),
        api.get(`/api/households/${householdId}/conflicts${query({ from: now, to })}`).catch(() => ({ conflicts: [] })),
        api.get(`/api/households/${householdId}/notifications`).catch(() => ({ notifications: [] })),
      ]);
      return { brief: brief?.brief ?? null, upcoming, conflicts, notifications, now };
    },

    (data) => h('div', {},
      summary(data, navigate),
      grid(),
      nextUp(data, navigate),
    ));
}

/* --------------------------------------------------------------- summary */

function summary({ brief, upcoming, conflicts, notifications, now }, navigate) {
  const tz = state.timezone;
  const today = (upcoming.occurrences ?? []).filter(
    (o) => relativeDay(o.occurrenceStart, tz, now) === 'Today',
  );
  const unread = (notifications.notifications ?? []).filter((n) => n.readAt === null || n.readAt === undefined);
  const conflictCount = (conflicts.conflicts ?? []).length;

  const greeting = brief?.greeting ?? `Good ${partOfDay()}, ${state.member?.displayName ?? 'there'}.`;

  return h('div', { class: 'brief' },
    h('p', { class: 'brief__greeting' }, greeting),
    h('p', { class: 'brief__date' }, dayLong(now, tz)),

    h('div', { class: 'brief__stats' },
      // Short visible labels, because four of these sit across a 390px phone
      // and anything longer wraps mid-word. The full phrase is on the
      // `aria-label`, so a screen reader still hears "3 events today".
      stat(today.length, 'Today', today.length === 1 ? 'event today' : 'events today',
        '/schedule', navigate),
      stat(brief?.reminders?.length ?? 0, 'To do', 'reminders due', '/reminders', navigate),
      stat(brief?.shopping?.length ?? 0, 'To buy', 'things to buy', '/shopping', navigate),
      stat(conflictCount, 'Clashes', conflictCount === 1 ? 'conflict' : 'conflicts',
        '/schedule', navigate, conflictCount > 0 ? 'alert' : null),
    ),

    unread.length > 0
      ? h('button', {
          class: 'btn btn--quiet', type: 'button',
          style: { marginTop: '1rem' },
          onClick: () => navigate('/notifications'),
        }, icon(ICONS.bell, 18), `${unread.length} to look at`)
      : null,
  );
}

/**
 * One number in the summary row.
 *
 * A button rather than a figure, because every one of them is somewhere to go —
 * "3 conflicts" that you cannot tap is a number that makes you hunt.
 */
function stat(value, label, spoken, href, navigate, tone = null) {
  return h('button', {
    class: `stat${tone ? ` stat--${tone}` : ''}`,
    type: 'button',
    onClick: () => navigate(href),
    'aria-label': `${value} ${spoken}`,
  },
    h('span', { class: 'stat__value' }, String(value)),
    h('span', { class: 'stat__label' }, label),
  );
}

function partOfDay() {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/* ------------------------------------------------------------------ grid */

function grid() {
  const wrapper = h('div', { class: 'grid' });

  MINI_APPS.forEach((app, index) => {
    // A tile whose screen the server would refuse is not shown. This is an
    // affordance, not a control — the API checks again — but a child tapping
    // "Shia Baby" only to be told no is a worse experience than not seeing it.
    if (app.needs !== undefined && !state.can(app.needs)) return;

    const tile = h('a', { class: 'tile', href: app.route },
      h('div', { class: 'tile__art' }),
      h('span', { class: 'tile__label' }, app.label),
    );
    wrapper.append(tile);

    // The artwork resolves asynchronously (it needs the icon manifest). The
    // tile is in the DOM immediately at its final size, so filling the art in
    // afterwards cannot move anything — no layout shift, no mis-taps.
    void miniAppArt(app, { size: 88, eager: index < 6 }).then((art) => {
      tile.firstChild.replaceWith(art);
    });
  });

  return h('nav', { 'aria-label': 'Mini-apps', style: { marginBottom: '2rem' } }, wrapper);
}

/* --------------------------------------------------------------- next up */

function nextUp({ upcoming, conflicts, now }, navigate) {
  const tz = state.timezone;
  const occurrences = (upcoming.occurrences ?? []).slice(0, 6);

  // Which occurrences are in a conflict, so the row can say so rather than
  // leaving the family to notice the overlap themselves.
  const conflicted = new Set();
  for (const conflict of conflicts.conflicts ?? []) {
    for (const ref of conflict.refs ?? []) conflicted.add(ref.id);
  }

  if (occurrences.length === 0) {
    return section('Next up', null, empty({
      title: 'Nothing scheduled',
      body: 'The next eight days are clear.',
    }));
  }

  return section('Next up',
    h('a', { class: 'btn btn--quiet', href: '/schedule' }, 'See all'),
    ...occurrences.map((occurrence, index) => entry(occurrence, {
      tz, now, first: index === 0,
      conflict: conflicted.has(occurrence.eventId),
      navigate,
    })),
  );
}

function entry(occurrence, { tz, now, first, conflict, navigate }) {
  const day = relativeDay(occurrence.occurrenceStart, tz, now);

  return h('button', {
    class: `entry${first ? ' entry--next' : ''}${conflict ? ' entry--conflict' : ''}`,
    type: 'button',
    onClick: () => navigate(`/event/${occurrence.eventId}`),
  },
    h('span', { class: 'entry__time' },
      h('strong', {}, time(occurrence.occurrenceStart, tz)),
      day,
    ),
    h('span', {},
      h('span', { class: 'entry__title' }, occurrence.title),
      h('span', { class: 'entry__sub' },
        timeRange(occurrence.occurrenceStart, occurrence.occurrenceEnd, tz),
        occurrence.location ? ` · ${occurrence.location}` : '',
      ),
    ),
    h('span', { class: 'row' },
      // The word as well as the colour and the bar — §8.
      conflict ? chip('Clash', 'alert') : null,
      whoRow(occurrence.participantIds ?? []),
    ),
  );
}
