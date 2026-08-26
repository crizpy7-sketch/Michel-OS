import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { byKey } from '../lib/miniapps.js';
import { chip, empty, section, withStates, whoRow } from '../lib/ui.js';
import { relativeDay, time, timeRange } from '../lib/format.js';

const DAY = 24 * 3600_000;

export async function render(mount, params, { navigate, setTitle }) {
  const app = byKey(params.key);
  if (!app || !app.domain) {
    mount.replaceChildren(empty({ title: 'Mini-app not found', body: 'That part of Michel OS is not available.' }));
    return;
  }
  setTitle(app.label);
  const now = new Date().toISOString();
  const to = new Date(Date.now() + 60 * DAY).toISOString();
  await withStates(mount, 'list',
    () => api.get(`/api/households/${state.household.id}/occurrences${query({ from: now, to, domain: app.domain })}`),
    (data) => {
      const items = data.occurrences ?? [];
      return h('div', {},
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' } },
          state.can('event.create') ? h('a', { class: 'btn btn--primary', href: `/add?domain=${encodeURIComponent(app.domain)}` }, `Add ${singular(app.label)}`) : null,
        ),
        items.length === 0
          ? empty({ title: `No ${app.label.toLowerCase()} yet`, body: 'Anything added here also appears in All Schedules.' })
          : grouped(items, navigate),
      );
    },
  );
}

function grouped(items, navigate) {
  const groups = new Map();
  const now = new Date().toISOString();
  for (const item of items) {
    const day = relativeDay(item.occurrenceStart, state.timezone, now);
    const list = groups.get(day) ?? [];
    list.push(item);
    groups.set(day, list);
  }
  return h('div', {}, ...[...groups.entries()].map(([day, rows]) =>
    section(day, null, ...rows.map((item) => h('button', {
      class: 'entry', type: 'button', onClick: () => navigate(`/event/${encodeURIComponent(item.eventId)}`),
    },
      h('span', { class: 'entry__time' }, h('strong', {}, time(item.occurrenceStart, state.timezone)), day),
      h('span', {},
        h('span', { class: 'entry__title' }, item.title),
        h('span', { class: 'entry__sub' }, timeRange(item.occurrenceStart, item.occurrenceEnd, state.timezone), item.location ? ` · ${item.location}` : ''),
      ),
      h('span', {}, item.allDay ? chip('All day', 'info') : null, whoRow(item.participantIds ?? [])),
    ))),
  ));
}

function singular(label) {
  if (label === 'Games') return 'game';
  if (label.endsWith('s')) return label.slice(0, -1).toLowerCase();
  return label.toLowerCase();
}
