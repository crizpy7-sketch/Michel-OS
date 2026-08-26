import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { reset, state } from '../lib/state.js';
import { card } from '../lib/ui.js';

export async function render(mount) {
  mount.replaceChildren(card(state.member?.displayName ?? 'Account', state.member?.role ?? null,
    link('/household', 'Household & family'), link('/notifications', 'Notifications'), link('/search', 'Search'),
    state.can('business.read') ? link('/business', 'Shia Baby business') : null,
    h('button', { class: 'btn btn--danger btn--block', type: 'button', style: { marginTop: '1rem' }, onClick: async () => {
      try { await api.post('/api/auth/logout', {}); } catch {}
      reset(); location.href = '/';
    } }, 'Sign out'),
  ));
}
function link(href, label) { return h('a', { class: 'entry', href, style: { display: 'flex', minHeight: '52px', marginBottom: '.5rem' } }, h('span', { class: 'entry__title' }, label)); }
