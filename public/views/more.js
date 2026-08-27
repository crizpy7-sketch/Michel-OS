import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { reset, state } from '../lib/state.js';
import { card, select, toast } from '../lib/ui.js';
import { APPEARANCE_OPTIONS, getAppearancePreference, setAppearancePreference } from '../lib/theme.js';

export async function render(mount) {
  const appearance = select(APPEARANCE_OPTIONS, { value: getAppearancePreference(), 'aria-label': 'Seasonal appearance' });
  appearance.addEventListener('change', () => {
    setAppearancePreference(appearance.value);
    toast(appearance.value === 'auto' ? 'Seasonal appearance set to automatic' : 'Appearance updated');
  });

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

  const appearanceCard = card('Appearance', 'visual only',
    h('p', { class: 'muted' }, 'Seasonal skins change atmosphere, accents and motion only. Your schedule, Assistant, permissions and Shia Baby engine stay exactly the same.'),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Seasonal appearance'), appearance),
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
