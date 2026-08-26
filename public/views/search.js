import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { empty, field, input, withStates } from '../lib/ui.js';

export async function render(mount, _params, { navigate }) {
  const initial = new URLSearchParams(location.search).get('q') ?? '';
  const box = input({
    type: 'search',
    value: initial,
    placeholder: 'Search schedules, reminders, people…',
    enterkeyhint: 'search',
  });
  const results = h('div', { style: { marginTop: '1rem' } });
  const form = h(
    'form',
    {
      role: 'search',
      onSubmit: async (event) => {
        event.preventDefault();
        const value = box.value.trim();
        history.replaceState({}, '', value ? `/search?q=${encodeURIComponent(value)}` : '/search');
        await run(results, value, navigate);
      },
    },
    field('Search Michel OS', box),
    h('button', { class: 'btn btn--primary', type: 'submit' }, 'Search'),
  );

  mount.replaceChildren(form, results);
  if (initial) await run(results, initial, navigate);
}

async function run(mount, value, navigate) {
  if (!value) {
    mount.replaceChildren(empty({
      title: 'Search everything',
      body: 'Results are permission-filtered before they reach this screen.',
    }));
    return;
  }

  await withStates(
    mount,
    'list',
    () => api.get(`/api/households/${state.household.id}/search${query({ q: value })}`),
    (data) => {
      const hits = data.hits ?? [];
      if (hits.length === 0) {
        return empty({ title: 'No matches', body: `Nothing matched “${value}”.` });
      }
      return h('div', {}, ...hits.map((hit) => resultRow(hit, navigate)));
    },
  );
}

function resultRow(hit, navigate) {
  return h(
    'button',
    {
      class: 'entry',
      type: 'button',
      onClick: () => {
        const route = routeFor(hit);
        if (route) navigate(route);
      },
    },
    h('span', { class: 'entry__time' }, hit.entity ?? hit.type ?? 'result'),
    h(
      'span',
      {},
      h('span', { class: 'entry__title' }, hit.title ?? hit.label ?? hit.name ?? 'Result'),
      h('span', { class: 'entry__sub' }, cleanSnippet(hit.snippet ?? hit.text ?? '')),
    ),
    h('span'),
  );
}

function cleanSnippet(value) {
  return String(value).replace(/\[\[/g, '').replace(/\]\]/g, '');
}

function routeFor(hit) {
  const type = hit.entity ?? hit.type;
  const id = hit.entityId ?? hit.id;
  if (type === 'event' && id) return `/event/${encodeURIComponent(id)}`;
  if (type === 'reminder') return '/reminders';
  if (type === 'shopping_item') return '/shopping';
  if (type === 'errand') return '/errands';
  if (['employee', 'product', 'expense'].includes(type)) return '/business';
  if (type === 'inbox_item') return '/inbox';
  return null;
}
