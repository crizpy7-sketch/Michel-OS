import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { loadHousehold, state } from '../lib/state.js';
import { card, chip, field, input, select, toast, withStates } from '../lib/ui.js';

export async function render(mount) { await load(mount); }

async function load(mount) {
  await withStates(mount, 'list', async () => {
    const household = await api.get(`/api/households/${state.household.id}`);
    const invitations = state.can('member.manage')
      ? await api.get(`/api/households/${state.household.id}/invitations`).catch(() => ({ invitations: [] }))
      : { invitations: [] };
    return { household, invitations: invitations.invitations ?? [] };
  }, ({ household: data, invitations }) => {
    const members = data.members ?? [];
    const activeCount = members.filter((member) => member.active !== false).length;
    return h('div', {},
      state.households.length > 1 ? householdSwitcher(mount) : null,
      card(data.household.name, data.household.timezone,
        h('p', { style: { color: 'var(--muted)' } }, `${activeCount} active family profile${activeCount === 1 ? '' : 's'}`),
        h('p', { class: 'muted tiny', style: { marginTop: '.5rem' } }, 'Appointments, reminders and schedules are shared only with people viewing this same household.')),
      state.can('member.manage') ? addMember(mount) : null,
      h('div', { style: { marginTop: '1rem' } }, ...members.map((member) => memberCard(member, mount))),
      state.can('member.manage') ? inviteBox(mount, invitations) : null,
    );
  });
}

function householdSwitcher(mount) {
  const options = state.households.map((entry) => [entry.household.id, entry.household.name]);
  const picker = select(options, { 'aria-label': 'Household being viewed' });
  picker.value = state.household.id;

  return card('Which household are you viewing?', `${state.households.length} memberships`,
    h('p', { class: 'muted' },
      'This account belongs to more than one household. Both phones must be on the same household to see the same appointments and schedule.'),
    field('Current household', picker),
    h('button', {
      class: 'btn btn--primary',
      type: 'button',
      onClick: async (event) => {
        if (picker.value === state.household.id) {
          toast(`Already viewing ${state.household.name}`);
          return;
        }
        event.currentTarget.disabled = true;
        try {
          await loadHousehold(picker.value);
          toast(`Now viewing ${state.household.name}`);
          await load(mount);
        } catch (error) {
          toast(error.message ?? 'Could not switch households.', 'error');
          event.currentTarget.disabled = false;
        }
      },
    }, 'Switch household'));
}

function memberCard(member, mount) {
  const active = member.active !== false;
  return card(member.displayName, member.role,
    h('div', { class: 'row row--wrap' },
      chip(active ? 'Active' : 'Inactive', active ? 'good' : 'quiet'),
      member.userId ? chip('Login', 'info') : chip('Managed profile', 'quiet'),
      state.can('member.manage') && active ? h('button', {
        class: 'btn btn--danger',
        type: 'button',
        onClick: async (event) => {
          const button = event.currentTarget;
          const meaning = member.userId
            ? `${member.displayName} will no longer be able to access this household. Their history stays intact.`
            : `${member.displayName} will be removed from active family choices. Their past schedule history stays intact.`;
          if (!confirm(`Remove ${member.displayName}?\n\n${meaning}`)) return;
          button.disabled = true;
          try {
            await api.del(`/api/households/${state.household.id}/members/${member.id}`);
            await loadHousehold(state.household.id);
            toast(`${member.displayName} removed from active household access`);
            await load(mount);
          } catch (error) {
            toast(error.message ?? 'Could not remove that person.', 'error');
            button.disabled = false;
          }
        },
      }, member.userId ? 'Remove access' : 'Remove profile') : null,
    ),
  );
}

function addMember(mount) {
  const name = input({ required: true, placeholder: 'Name' });
  const role = select([['child', 'Child'], ['teen', 'Teen'], ['adult', 'Adult'], ['viewer', 'Viewer'], ['employee', 'Employee']]);
  return card('Add someone without a login', 'no sign-in',
    h('p', { class: 'muted' }, 'For a young child, or anyone who should appear on the family schedule but will not sign in themselves. They get no email and no password.'),
    h('form', { onSubmit: async (e) => {
      e.preventDefault();
      try {
        await api.post(`/api/households/${state.household.id}/members`, { displayName: name.value.trim(), role: role.value });
        await loadHousehold(state.household.id); toast('Profile added'); await load(mount);
      } catch (error) { toast(error.message ?? 'Could not add profile.', 'error'); }
    } }, field('Name', name), field('Role', role, { hint: 'To give someone their own login instead, use "Invite someone with a login" below.' }),
      h('button', { class: 'btn', type: 'submit' }, 'Add profile')));
}

function inviteBox(mount, invitations) {
  const email = input({ type: 'email', placeholder: 'person@example.com' });
  const role = select([['adult', 'Adult'], ['teen', 'Teen'], ['viewer', 'Viewer'], ['employee', 'Employee']]);
  const output = h('div');
  const pending = invitations.length === 0 ? null : h('div', { class: 'stack', style: { marginTop: '1rem' } },
    h('p', { class: 'muted tiny' }, `Pending invitation${invitations.length === 1 ? '' : 's'}`),
    ...invitations.map((invitation) => h('div', { class: 'row row--wrap' },
      h('div', { style: { flex: '1 1 12rem' } },
        h('strong', {}, invitation.email || 'Invitation'),
        h('p', { class: 'muted tiny', style: { margin: '.15rem 0 0' } }, invitation.role ? `Role: ${invitation.role}` : 'Pending'),
      ),
      h('button', {
        class: 'btn btn--danger', type: 'button',
        onClick: async (event) => {
          if (!confirm(`Revoke the invitation for ${invitation.email || 'this person'}?`)) return;
          event.currentTarget.disabled = true;
          try {
            await api.del(`/api/households/${state.household.id}/invitations/${invitation.id}`);
            toast('Invitation revoked'); await load(mount);
          } catch (error) {
            toast(error.message ?? 'Could not revoke that invitation.', 'error');
            event.currentTarget.disabled = false;
          }
        },
      }, 'Revoke'),
    )),
  );

  const box = card('Invite someone with a login', 'their own account',
    h('p', { class: 'muted' }, 'For a partner or an older child who should sign in on their own phone. This is the one to use so two people can both add to the same schedule.'),
    h('form', { onSubmit: async (e) => {
      e.preventDefault();
      try {
        const invitation = await api.post(`/api/households/${state.household.id}/invitations`, { email: email.value.trim(), role: role.value });
        const token = invitation.token ?? invitation.invitation?.token;
        output.replaceChildren(token ? inviteCode(token) : h('p', { style: { marginTop: '.75rem' } }, 'Invitation created.'));
        toast('Invitation created');
      } catch (error) { toast(error.message ?? 'Could not create invitation.', 'error'); }
    } }, field('Email', email), field('Role', role), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Create invitation')),
    output,
    pending,
  );
  box.classList.add('invite-card');
  return box;
}

function inviteCode(token) {
  const copy = h('button', { class: 'btn', type: 'button', onClick: async () => {
    try { await navigator.clipboard.writeText(token); toast('Invitation code copied'); }
    catch { toast('Select the code and copy it by hand.', 'error'); }
  } }, 'Copy code');

  return h('div', { class: 'invite-code' },
    h('p', { class: 'invite-code__value' }, token),
    h('p', { class: 'muted tiny' },
      'Send this to them, then have them open the app, choose Create account → Join household, check the invitation, and join. The shared household becomes active automatically.'),
    copy,
  );
}
