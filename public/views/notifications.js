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
  await withStates(
    mount,
    'list',
    () => api.get(`/api/households/${state.household.id}/notifications`),
    (data) => {
      const rows = data.notifications ?? [];
      if (rows.length === 0) {
        return empty({
          title: 'Nothing needs attention',
          body: 'Conflicts, due reminders and low stock will appear here.',
        });
      }
      return h('div', {}, ...rows.map((notification) => notificationCard(notification, mount)));
    },
  );
}

function notificationCard(notification, mount) {
  const when = notification.createdAt
    ? `${dayShort(notification.createdAt, state.timezone)} · ${time(notification.createdAt, state.timezone)}`
    : null;
  const tone = notification.severity === 'blocking'
    ? 'alert'
    : notification.severity === 'warning'
      ? 'warn'
      : 'info';

  const status = notification.readAt
    ? chip('Read', 'quiet')
    : h('button', {
        class: 'btn btn--quiet',
        type: 'button',
        onClick: async () => {
          try {
            await api.post(`/api/households/${state.household.id}/notifications/${notification.id}/read`, {});
            await load(mount);
          } catch (error) {
            toast(error.message ?? 'Could not mark that read.', 'error');
          }
        },
      }, 'Mark read');

  return card(
    notification.title ?? titleFor(notification.kind),
    when,
    h('p', {}, notification.message ?? notification.body ?? ''),
    h(
      'div',
      { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
      chip(notification.kind ?? 'notice', tone),
      status,
    ),
  );
}

function titleFor(kind) {
  return String(kind ?? 'Notification')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
