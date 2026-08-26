import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, empty, toast, withStates } from '../lib/ui.js';
import { dayShort, time } from '../lib/format.js';

export async function render(mount) {
  await api.post(`/api/households/${state.household.id}/notifications/refresh`, {}).catch(() => {});
  await load(mount);
}

async function load(mount) {
  await withStates(mount, 'list', () => api.get(`/api/households/${state.household.id}/notifications`),
    (data) => {
      const rows = data.notifications ?? [];
      if (rows.length === 0) return empty({ title: 'Nothing needs attention', body: 'Conflicts, due reminders and low stock will appear here.' });
      return h('div', {}, ...rows.map((n) => card(n.title ?? titleFor(n.kind), n.createdAt ? `${dayShort(n.createdAt, state.timezone)} · ${time(n.createdAt, state.timezone)}` : null,
        h('p', {}, n.message ?? n.body ?? ''),
        h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
          chip(n.kind ?? 'notice', n.severity === 'blocking' ? 'alert' : n.severity === 'warning' ? 'warn' : 'info'),
          n.readAt ? chip('Read', 'quiet') : h('button', { class: 'btn btn--quiet', type: 'button', onClick: async () => {
            try { await api.post(`/api/households/${state.household.id}/notifications/${n.id}/read`, {}); await load(mount); }
            catch (error) { toast(error.message ?? 'Could not mark that read.', 'error'); }
          } }, 'Mark read'),
        ),
      )));
    }));
}

function titleFor(kind) { return String(kind ?? 'Notification').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
