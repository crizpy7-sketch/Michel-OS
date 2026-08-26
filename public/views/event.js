import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, empty, toast, whoRow, withStates } from '../lib/ui.js';
import { dayLong, timeRange } from '../lib/format.js';

const DAY = 24 * 3600_000;

export async function render(mount, params, { navigate, setTitle }) {
  const now = Date.now();
  const from = new Date(now - 365 * DAY).toISOString();
  const to = new Date(now + 400 * DAY).toISOString();
  await withStates(mount, 'list',
    () => api.get(`/api/households/${state.household.id}/occurrences${query({ from, to })}`),
    (data) => {
      const matches = (data.occurrences ?? []).filter((x) => x.eventId === params.eventId);
      if (matches.length === 0) return empty({ title: 'Event not found', body: 'It may have been removed.' });
      const item = matches.find((x) => Date.parse(x.occurrenceEnd) >= now) ?? matches[0];
      setTitle(item.title);
      return h('div', {},
        card(item.title, item.domain ? labelFor(item.domain) : null,
          h('p', {}, h('strong', {}, dayLong(item.occurrenceStart, state.timezone))),
          h('p', {}, timeRange(item.occurrenceStart, item.occurrenceEnd, state.timezone)),
          item.location ? h('p', {}, `📍 ${item.location}`) : null,
          item.notes ? h('p', { style: { color: 'var(--muted)' } }, item.notes) : null,
          h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' } }, item.allDay ? chip('All day', 'info') : null, whoRow(item.participantIds ?? [])),
        ),
        state.can('event.delete.own') || state.can('event.delete.any') ? h('button', {
          class: 'btn btn--danger', type: 'button', style: { marginTop: '1rem' },
          onClick: async () => {
            if (!confirm('Remove this event?')) return;
            try {
              await api.del(`/api/households/${state.household.id}/events/${encodeURIComponent(params.eventId)}`);
              toast('Event removed'); navigate('/schedule', { replace: true });
            } catch (error) { toast(error.message ?? 'Could not remove it.', 'error'); }
          },
        }, 'Remove event') : null,
      );
    },
  );
}

function labelFor(value) { return String(value).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
