import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { reset, state } from '../lib/state.js';
import { card } from '../lib/ui.js';
import { getAppearancePreference } from '../lib/theme.js';

export async function render(mount) {
  const account = card(state.member?.displayName ?? 'Account', state.member?.role ?? null,
    link('/household', 'Household & family'),
    link('/notifications', 'Notifications'),
    link('/search', 'Search'),
    link('/inbox', 'Inbox'),
    link('/reminders', 'Reminders'),
    link('/schedule', 'All schedules'),
    state.can('business.read') ? link('/business', 'Shia Baby business') : null,
  );
  account.classList.add('settings-card');

  // The picker itself lives at /design, where each skin can be previewed
  // before it is chosen. A dropdown of names you cannot see is a guess.
  const appearanceCard = card('Appearance', getAppearancePreference(),
    link('/design', 'Seasonal appearance'),
  );
  appearanceCard.classList.add('appearance-card');

  const signOut = h('button', { class: 'btn btn--danger btn--block', type: 'button', onClick: async () => {
    try { await api.post('/api/auth/logout', {}); } catch {}
    reset(); location.href = '/';
  } }, 'Sign out');

  mount.replaceChildren(account, appearanceCard, signOut);
}

function link(href, label) {
  return h('a', { class: 'entry settings-link', href },
    h('span', { class: 'entry__title' }, label),
    h('span', { class: 'settings-link__chevron', 'aria-hidden': 'true' }, '›'));
}
