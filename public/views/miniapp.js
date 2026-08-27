import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { byKey } from '../lib/miniapps.js';
import { miniAppArt } from '../lib/art.js';
import { chip, empty, section, withStates, whoRow } from '../lib/ui.js';
import { relativeDay, time, timeRange, dayLong } from '../lib/format.js';

const DAY = 24 * 3600_000;

export async function render(mount, params, { navigate, setTitle }) {
  const app = byKey(params.key);
  if (!app || !app.domain) {
    mount.replaceChildren(empty({ title: 'Mini-app not found', body: 'That part of Michel OS is not available.' }));
    return;
  }
  document.body.dataset.miniapp = app.key;
  setTitle(app.label);
  const now = new Date().toISOString();
  const to = new Date(Date.now() + 60 * DAY).toISOString();
  await withStates(mount, 'list',
    () => api.get(`/api/households/${state.household.id}/occurrences${query({ from: now, to, domain: app.domain })}`),
    (data) => {
      const items = data.occurrences ?? [];
      const intro = app.key === 'hubby-work' ? h('p', { class: 'page-kicker' }, 'Upcoming schedule') : null;
      return h('div', { class: `miniapp-page miniapp-page--${app.key}` },
        h('div', { class: 'miniapp-actions' },
          intro,
          state.can('event.create') ? h('a', { class: 'btn btn--quiet miniapp-add', href: `/add?domain=${encodeURIComponent(app.domain)}` }, `+ Add ${singular(app.label)}`) : null,
        ),
        items.length === 0
          ? empty({ title: `No ${app.label.toLowerCase()} yet`, body: 'Anything added here also appears in All Schedules.' })
          : grouped(items, navigate, app),
      );
    },
  );
}

function grouped(items, navigate, app) {
  const groups = new Map();
  const now = new Date().toISOString();
  for (const item of items) {
    const day = relativeDay(item.occurrenceStart, state.timezone, now);
    const list = groups.get(day) ?? [];
    list.push(item);
    groups.set(day, list);
  }
  return h('div', { class: 'miniapp-groups' }, ...[...groups.entries()].map(([day, rows]) =>
    section(day, null, ...rows.map((item) => eventCard(item, navigate, app))),
  ));
}

function eventCard(item, navigate, app) {
  const artSlot = h('span', { class: 'entry__art-slot', 'aria-hidden': 'true' });
  const row = h('button', {
    class: 'entry miniapp-entry', type: 'button', onClick: () => navigate(`/event/${encodeURIComponent(item.eventId)}`),
  },
    artSlot,
    h('span', { class: 'entry__time' },
      h('strong', {}, time(item.occurrenceStart, state.timezone)),
      dayLong(item.occurrenceStart, state.timezone).split(',')[0],
    ),
    h('span', { class: 'entry__main' },
      h('span', { class: 'entry__eyebrow' }, app.label),
      h('span', { class: 'entry__title' }, item.title),
      h('span', { class: 'entry__sub' }, timeRange(item.occurrenceStart, item.occurrenceEnd, state.timezone), item.location ? ` · ${item.location}` : ''),
    ),
    h('span', { class: 'entry__meta' },
      item.allDay ? chip('All day', 'info') : null,
      whoRow(item.participantIds ?? []),
      h('span', { class: 'entry__chevron', 'aria-hidden': 'true' }, '›'),
    ),
  );
  void miniAppArt(app, { size: 56, eager: true }).then((art) => {
    art.classList.add('entry__art');
    artSlot.replaceChildren(art);
  });
  return row;
}

function singular(label) {
  if (label === 'Games') return 'game';
  if (label.endsWith('s')) return label.slice(0, -1).toLowerCase();
  return label.toLowerCase();
}
