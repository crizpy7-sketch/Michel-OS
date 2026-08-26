import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { chip, empty, section, withStates, whoRow } from '../lib/ui.js';
import { dayLong, relativeDay, time, timeRange } from '../lib/format.js';

const DAY = 24 * 3600_000;

export async function render(mount, _params, { navigate }) {
  const now = new Date().toISOString();
  const to = new Date(Date.now() + 31 * DAY).toISOString();
  await withStates(mount, 'list',
    async () => {
      const [calendar, clashes] = await Promise.all([
        api.get(`/api/households/${state.household.id}/occurrences${query({ from: now, to })}`),
        api.get(`/api/households/${state.household.id}/conflicts${query({ from: now, to })}`),
      ]);
      return { now, calendar, clashes };
    },
    ({ now: loadedAt, calendar, clashes }) => build(calendar.occurrences ?? [], clashes.conflicts ?? [], loadedAt, navigate),
  );
}

function build(occurrences, conflicts, now, navigate) {
  if (occurrences.length === 0) {
    return empty({
      title: 'Nothing scheduled',
      body: 'The next month is clear.',
      action: state.can('event.create') ? h('a', { class: 'btn btn--primary', href: '/add' }, 'Add something') : null,
    });
  }

  const clashByEvent = new Map();
  for (const conflict of conflicts) {
    const explanation = conflict.explanation ?? conflict.message ?? 'This overlaps something else.';
    for (const ref of conflict.refs ?? conflict.occurrenceRefs ?? []) {
      const id = ref.id ?? ref.eventId;
      if (!id) continue;
      const list = clashByEvent.get(id) ?? [];
      list.push(explanation);
      clashByEvent.set(id, list);
    }
  }

  const byDay = new Map();
  for (const item of occurrences) {
    const label = relativeDay(item.occurrenceStart, state.timezone, now);
    const list = byDay.get(label) ?? [];
    list.push(item);
    byDay.set(label, list);
  }

  return h('div', {},
    h('div', { class: 'row', style: { display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginBottom: '1rem' } },
      state.can('event.create') ? h('a', { class: 'btn btn--primary', href: '/add' }, 'Add') : null,
    ),
    ...[...byDay.entries()].map(([label, items]) =>
      section(label, null, ...items.map((item) => eventRow(item, clashByEvent.get(item.eventId) ?? [], navigate))),
  );
}

function eventRow(item, clashes, navigate) {
  return h('button', {
    class: `entry${clashes.length ? ' entry--conflict' : ''}`,
    type: 'button',
    onClick: () => navigate(`/event/${encodeURIComponent(item.eventId)}`),
  },
    h('span', { class: 'entry__time' },
      h('strong', {}, time(item.occurrenceStart, state.timezone)),
      dayLong(item.occurrenceStart, state.timezone).split(',')[0],
    ),
    h('span', {},
      h('span', { class: 'entry__title' }, item.title),
      h('span', { class: 'entry__sub' },
        timeRange(item.occurrenceStart, item.occurrenceEnd, state.timezone),
        item.location ? ` · ${item.location}` : '',
      ),
    ),
    h('span', { style: { display: 'flex', gap: '.35rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
      item.domain ? chip(labelFor(item.domain), 'quiet') : null,
      clashes.length ? chip('Clash', 'alert') : null,
      whoRow(item.participantIds ?? []),
    ),
  );
}

function labelFor(value) {
  return String(value).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
