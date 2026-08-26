import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { loadHousehold, state } from '../lib/state.js';
import { card, chip, field, input, select, toast, withStates } from '../lib/ui.js';

export async function render(mount) { await load(mount); }

async function load(mount) {
  await withStates(mount, 'list', () => api.get(`/api/households/${state.household.id}`),
    (data) => h('div', {},
      card(data.household.name, data.household.timezone, h('p', { style: { color: 'var(--muted)' } }, `${(data.members ?? []).length} family profiles`)),
      state.can('member.manage') ? addMember(mount) : null,
      h('div', { style: { marginTop: '1rem' } }, ...(data.members ?? []).map((member) => card(member.displayName, member.role,
        h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
          chip(member.active === false ? 'Inactive' : 'Active', member.active === false ? 'quiet' : 'good'),
          member.userId ? chip('Login', 'info') : chip('Managed profile', 'quiet'),
        ),
      ))),
      state.can('member.manage') ? inviteBox() : null,
    ));
}

function addMember(mount) {
  const name = input({ required: true, placeholder: 'Name' });
  const role = select([['child', 'Child'], ['teen', 'Teen'], ['adult', 'Adult'], ['viewer', 'Viewer'], ['employee', 'Employee']]);
  return card('Add family profile', null, h('form', { onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/households/${state.household.id}/members`, { displayName: name.value.trim(), role: role.value });
      await loadHousehold(state.household.id); toast('Profile added'); await load(mount);
    } catch (error) { toast(error.message ?? 'Could not add profile.', 'error'); }
  } }, field('Name', name), field('Role', role), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add profile')));
}

function inviteBox() {
  const email = input({ type: 'email', placeholder: 'person@example.com' });
  const role = select([['adult', 'Adult'], ['teen', 'Teen'], ['viewer', 'Viewer'], ['employee', 'Employee']]);
  const output = h('div');
  return card('Invite someone with a login', null, h('form', { onSubmit: async (e) => {
    e.preventDefault();
    try {
      const invitation = await api.post(`/api/households/${state.household.id}/invitations`, { email: email.value.trim(), role: role.value });
      const token = invitation.token ?? invitation.invitation?.token;
      output.replaceChildren(token ? h('p', { style: { overflowWrap: 'anywhere', marginTop: '.75rem' } }, `Invitation token: ${token}`) : h('p', { style: { marginTop: '.75rem' } }, 'Invitation created.'));
      toast('Invitation created');
    } catch (error) { toast(error.message ?? 'Could not create invitation.', 'error'); }
  } }, field('Email', email), field('Role', role), h('button', { class: 'btn', type: 'submit' }, 'Create invitation')), output);
}
