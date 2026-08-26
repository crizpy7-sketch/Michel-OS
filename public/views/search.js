import { h } from '../lib/dom.js';
import { api, query } from '../lib/api.js';
import { state } from '../lib/state.js';
import { empty, field, input, withStates } from '../lib/ui.js';

export async function render(mount, _params, { navigate }) {
  const initial = new URLSearchParams(location.search).get('q') ?? '';
  const box = input({ type: 'search', value: initial, placeholder: 'Search schedules, reminders, people…', enterkeyhint: 'search' });
  const results = h('div', { style: { marginTop: '1rem' } });
  const form = h('form', { role: 'search', onSubmit: async (e) => {
    e.preventDefault(); const q = box.value.trim();
    history.replaceState({}, '', q ? `/search?q=${encodeURIComponent(q)}` : '/search');
    await run(results, q, navigate);
  } }, field('Search Michel OS', box), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Search'));
  mount.replaceChildren(form, results);
  if (initial) await run(results, initial, navigate);
}

async function run(mount, q, navigate) {
  if (!q) { mount.replaceChildren(empty({ title: 'Search everything', body: 'Results are permission-filtered before they reach this screen.' })); return; }
  await withStates(mount, 'list', () => api.get(`/api/households/${state.household.id}/search${query({ q })}`),
    (data) => (data.hits ?? []).length === 0 ? empty({ title: 'No matches', body: `Nothing matched “${q}”.` })
      : h('div', {}, ...(data.hits ?? []).map((hit) => h('button', {
          class: 'entry', type: 'button', onClick: () => { const route = routeFor(hit); if (route) navigate(route); },
        }, h('span', { class: 'entry__time' }, hit.entity ?? hit.type ?? 'result'),
          h('span', {}, h('span', { class: 'entry__title' }, hit.title ?? hit.label ?? hit.name ?? 'Result'), h('span', { class: 'entry__sub' }, cleanSnippet(hit.snippet ?? hit.text ?? ''))), h('span'))))));
}

function cleanSnippet(value) { return String(value).replace(/\[\[/g, '').replace(/\]\]/g, ''); }
function routeFor(hit) {
  const type = hit.entity ?? hit.type;
  if (type === 'event' && (hit.entityId ?? hit.id)) return `/event/${encodeURIComponent(hit.entityId ?? hit.id)}`;
  if (type === 'reminder') return '/reminders'; if (type === 'shopping_item') return '/shopping'; if (type === 'errand') return '/errands';
  if (['employee', 'product', 'expense'].includes(type)) return '/business'; if (type === 'inbox_item') return '/inbox'; return null;
}
