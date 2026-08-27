import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { chip, empty, section, select, withStates, whoRow } from '../lib/ui.js';
import { dayLong, isoDate, relativeDay, time, timeRange } from '../lib/format.js';
import { forDomain } from '../lib/miniapps.js';
import { miniAppArt } from '../lib/art.js';

const DAY = 24 * 3600_000;
const MODES = [['today', 'Today'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['agenda', 'Agenda']];
const DOMAINS = [
  ['', 'All mini-apps'], ['appointments', 'Appointments'], ['practice', 'Practice'], ['competition', 'Competition'],
  ['games', 'Games'], ['school', 'School'], ['work', 'Hubby Work'], ['shia-baby', 'Shia Baby'], ['general', 'General'],
];

export async function render(mount, _params, { navigate }) {
  const params = new URLSearchParams(location.search);
  const mode = MODES.some(([key]) => key === params.get('mode')) ? params.get('mode') : 'agenda';
  const today = isoDate(new Date().toISOString(), state.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date') : today;
  const member = params.get('member') ?? '';
  const domain = DOMAINS.some(([key]) => key === params.get('domain')) ? params.get('domain') : '';
  const window = windowFor(mode, date, state.timezone);

  await withStates(mount, 'list',
    async () => {
      const filterQuery = { from: window.from, to: window.to, ...(domain ? { domain } : {}) };
      const [calendar, clashes] = await Promise.all([
        api.get(`/api/households/${state.household.id}/occurrences${query(filterQuery)}`),
        api.get(`/api/households/${state.household.id}/conflicts${query({ from: window.from, to: window.to })}`),
      ]);
      return { calendar, clashes };
    },
    ({ calendar, clashes }) => build({
      occurrences: calendar.occurrences ?? [], conflicts: clashes.conflicts ?? [], mode, date, member, domain, today, navigate,
    }),
  );
}

function build({ occurrences, conflicts, mode, date, member, domain, today, navigate }) {
  const filtered = member ? occurrences.filter((item) => (item.participantIds ?? []).includes(member)) : occurrences;
  const controls = toolbar({ mode, date, member, domain, today, navigate });

  if (filtered.length === 0) {
    return h('div', {}, controls, empty({
      title: 'Nothing scheduled here',
      body: member || domain ? 'Try another filter or date.' : 'This view is clear.',
      action: state.can('event.create') ? h('a', { class: 'btn btn--primary', href: domain ? `/add?domain=${encodeURIComponent(domain)}` : '/add' }, 'Add something') : null,
    }));
  }

  const clashByEvent = new Map();
  for (const conflict of conflicts) {
    const explanation = conflict.explanation ?? conflict.message ?? 'This overlaps something else.';
    for (const ref of conflict.occurrenceRefs ?? conflict.refs ?? []) {
      const id = ref.id ?? ref.eventId;
      if (!id) continue;
      const list = clashByEvent.get(id) ?? [];
      list.push(explanation);
      clashByEvent.set(id, list);
    }
  }

  const now = new Date().toISOString();
  const byDay = new Map();
  for (const item of filtered) {
    const label = relativeDay(item.occurrenceStart, state.timezone, now);
    const list = byDay.get(label) ?? [];
    list.push(item);
    byDay.set(label, list);
  }

  return h('div', {}, controls,
    ...[...byDay.entries()].map(([label, items]) => section(label, null,
      ...items.map((item) => eventRow(item, clashByEvent.get(item.eventId) ?? [], navigate)))),
  );
}

function toolbar({ mode, date, member, domain, today, navigate }) {
  const pathFor = (patch) => {
    const next = new URLSearchParams();
    const values = { mode, date, member, domain, ...patch };
    if (values.mode && values.mode !== 'agenda') next.set('mode', values.mode);
    if (values.date && (values.mode === 'day' || values.mode === 'week' || values.mode === 'month')) next.set('date', values.date);
    if (values.member) next.set('member', values.member);
    if (values.domain) next.set('domain', values.domain);
    const qs = next.toString();
    return `/schedule${qs ? `?${qs}` : ''}`;
  };

  const memberSelect = select([['', 'Everyone'], ...state.members.map((m) => [m.id, m.displayName])], { value: member, 'aria-label': 'Filter by family member' });
  memberSelect.addEventListener('change', () => navigate(pathFor({ member: memberSelect.value })));
  const domainSelect = select(DOMAINS, { value: domain, 'aria-label': 'Filter by mini-app' });
  domainSelect.addEventListener('change', () => navigate(pathFor({ domain: domainSelect.value })));

  const dateInput = h('input', {
    class: 'input', type: 'date', value: date, 'aria-label': 'Schedule date',
    style: { width: 'auto', minWidth: '9.5rem' },
    onChange: (event) => navigate(pathFor({ date: event.currentTarget.value || today })),
  });

  return h('div', { class: 'schedule-toolbar' },
    h('div', { class: 'schedule-toolbar__head' },
      h('p', { class: 'page-kicker' }, mode === 'agenda' || mode === 'week' ? 'This week' : labelFor(mode)),
      h('nav', { class: 'schedule-mode-tabs', 'aria-label': 'Schedule view' },
        ...MODES.map(([key, label]) => h('a', { class: `schedule-mode${mode === key ? ' schedule-mode--active' : ''}`, href: pathFor({ mode: key, date: key === 'today' ? today : date }) }, label)),
      ),
    ),
    weekStrip(date, today, pathFor),
    h('div', { class: 'schedule-filters' },
      ['day', 'week', 'month'].includes(mode) ? dateInput : null,
      h('div', { class: 'schedule-filter' }, memberSelect),
      h('div', { class: 'schedule-filter' }, domainSelect),
      state.can('event.create') ? h('a', { class: 'btn btn--quiet schedule-add', href: domain ? `/add?domain=${encodeURIComponent(domain)}` : '/add' }, 'Add') : null,
    ),
  );
}

function windowFor(mode, date, timezone) {
  const today = isoDate(new Date().toISOString(), timezone);
  if (mode === 'agenda') {
    const from = new Date().toISOString();
    return { from, to: new Date(Date.parse(from) + 90 * DAY).toISOString() };
  }
  const anchor = mode === 'today' ? today : date;
  if (mode === 'month') {
    const [year, month] = anchor.split('-').map(Number);
    const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = new Date(Date.UTC(year, month, 1));
    const toDate = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`;
    return { from: localMidnight(fromDate, timezone), to: localMidnight(toDate, timezone) };
  }
  if (mode === 'week') {
    const weekday = weekdayOfDate(anchor);
    const monday = addCalendarDays(anchor, -(weekday === 0 ? 6 : weekday - 1));
    return { from: localMidnight(monday, timezone), to: localMidnight(addCalendarDays(monday, 7), timezone) };
  }
  return { from: localMidnight(anchor, timezone), to: localMidnight(addCalendarDays(anchor, 1), timezone) };
}

function addCalendarDays(date, amount) {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + amount));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function weekdayOfDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Convert midnight in an IANA timezone to an instant without trusting device timezone. */
function localMidnight(date, timezone) {
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const shownAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    guess += target - shownAsUtc;
  }
  return new Date(guess).toISOString();
}

function eventRow(item, clashes, navigate) {
  const app = forDomain(item.domain);
  const artSlot = app ? h('span', { class: 'entry__art-slot', 'aria-hidden': 'true' }) : null;
  const row = h('button', {
    class: `entry schedule-entry${clashes.length ? ' entry--conflict' : ''}`,
    type: 'button',
    onClick: () => navigate(`/event/${encodeURIComponent(item.eventId)}`),
    title: clashes[0] ?? undefined,
  },
    artSlot,
    h('span', { class: 'entry__time' },
      h('strong', {}, time(item.occurrenceStart, state.timezone)),
      dayLong(item.occurrenceStart, state.timezone).split(',')[0],
    ),
    h('span', { class: 'entry__main' },
      item.domain ? h('span', { class: 'entry__eyebrow' }, labelFor(item.domain)) : null,
      h('span', { class: 'entry__title' }, item.title),
      h('span', { class: 'entry__sub' }, timeRange(item.occurrenceStart, item.occurrenceEnd, state.timezone), item.location ? ` · ${item.location}` : ''),
      clashes.length ? h('span', { class: 'entry__sub entry__sub--alert' }, clashes[0]) : null,
    ),
    h('span', { class: 'entry__meta' },
      clashes.length ? chip('Clash', 'alert') : null,
      whoRow(item.participantIds ?? []),
      h('span', { class: 'entry__chevron', 'aria-hidden': 'true' }, '›'),
    ),
  );
  if (app && artSlot) {
    void miniAppArt(app, { size: 56, eager: true }).then((art) => {
      art.classList.add('entry__art');
      artSlot.replaceChildren(art);
    });
  }
  return row;
}

function weekStrip(date, today, pathFor) {
  const anchor = date || today;
  const weekday = weekdayOfDate(anchor);
  const monday = addCalendarDays(anchor, -(weekday === 0 ? 6 : weekday - 1));
  const formatter = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
  return h('nav', { class: 'schedule-week', 'aria-label': 'Choose day' },
    ...Array.from({ length: 7 }, (_, index) => {
      const value = addCalendarDays(monday, index);
      const [year, month, day] = value.split('-').map(Number);
      const label = formatter.format(new Date(Date.UTC(year, month - 1, day)));
      const selected = value === anchor;
      return h('a', { class: `schedule-day${selected ? ' schedule-day--selected' : ''}`, href: pathFor({ mode: 'day', date: value }) },
        h('span', { class: 'schedule-day__weekday' }, label),
        h('span', { class: 'schedule-day__date' }, new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)))),
      );
    }),
  );
}

function labelFor(value) { return String(value).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
