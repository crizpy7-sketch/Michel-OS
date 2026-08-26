import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, empty, field, input, select, toast, withStates } from '../lib/ui.js';
import { dayShort, time } from '../lib/format.js';

export async function render(mount, _params, { setTitle }) {
  const kind = location.pathname.includes('errands') ? 'errands' : location.pathname.includes('reminders') ? 'reminders' : 'shopping';
  setTitle(kind[0].toUpperCase() + kind.slice(1));
  await load(mount, kind);
}

async function load(mount, kind) {
  await withStates(mount, 'list', () => api.get(`/api/households/${state.household.id}/${kind}`),
    (data) => kind === 'shopping' ? shopping(data, mount) : kind === 'errands' ? errands(data, mount) : reminders(data, mount));
}

function shopping(data, mount) {
  const items = data.items ?? [];
  return h('div', {}, state.can('event.create') ? addShopping(mount) : null,
    items.length === 0 ? empty({ title: 'Shopping list is clear', body: 'Add something when you need it.' })
      : h('div', {}, ...items.map((item) => card(item.name, item.store || item.category || null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', justifyContent: 'space-between' } },
            h('span', {}, item.quantity ? `Qty ${item.quantity}` : ''),
            h('span', { style: { display: 'flex', gap: '.4rem', alignItems: 'center' } },
              chip(item.status ?? 'needed', item.status === 'purchased' ? 'good' : 'quiet'),
              item.status !== 'purchased' ? action('Bought', async () => {
                await api.patch(`/api/households/${state.household.id}/shopping/${item.id}`, { status: 'purchased' });
                toast('Marked bought'); await load(mount, 'shopping');
              }) : null,
            ),
          ),
        ))));
}

function addShopping(mount) {
  const name = input({ placeholder: 'Milk, diapers, printer paper…', required: true });
  const store = input({ placeholder: 'Store (optional)' });
  return card('Add item', null, h('form', { onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/households/${state.household.id}/shopping`, { name: name.value.trim(), store: store.value.trim() });
      name.value = ''; store.value = ''; toast('Added'); await load(mount, 'shopping');
    } catch (error) { toast(error.message ?? 'Could not add it.', 'error'); }
  } }, field('What do you need?', name), field('Store', store), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add')));
}

function errands(data, mount) {
  const items = data.errands ?? [];
  return h('div', {}, state.can('event.create') ? addErrand(mount) : null,
    items.length === 0 ? empty({ title: 'No errands', body: 'Nothing to run out for right now.' })
      : h('div', {}, ...items.map((item) => card(item.title, item.location || null,
          item.dueAt ? h('p', {}, `${dayShort(item.dueAt, state.timezone)} · ${time(item.dueAt, state.timezone)}`) : null,
          h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
            chip(item.status ?? 'open', item.status === 'done' ? 'good' : 'quiet'),
            item.status !== 'done' ? action('Done', async () => {
              await api.patch(`/api/households/${state.household.id}/errands/${item.id}`, { status: 'done' });
              toast('Errand complete'); await load(mount, 'errands');
            }) : null,
          ),
        ))));
}

function addErrand(mount) {
  const title = input({ placeholder: 'Pick up dry cleaning', required: true });
  const locationInput = input({ placeholder: 'Location (optional)' });
  const dueAt = input({ type: 'datetime-local' });
  return card('Add errand', null, h('form', { onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/households/${state.household.id}/errands`, { title: title.value.trim(), location: locationInput.value.trim(), dueAt: dueAt.value });
      toast('Errand added'); await load(mount, 'errands');
    } catch (error) { toast(error.message ?? 'Could not add it.', 'error'); }
  } }, field('Errand', title), field('Location', locationInput), field('Due', dueAt), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add')));
}

function reminders(data, mount) {
  const items = data.reminders ?? [];
  return h('div', {}, state.can('event.create') ? addReminder(mount) : null,
    items.length === 0 ? empty({ title: 'No reminders', body: 'Your reminder list is clear.' })
      : h('div', {}, ...items.map((item) => card(item.title, item.status ?? null,
          h('p', {}, `${dayShort(item.dueAt, state.timezone)} · ${time(item.dueAt, state.timezone)}`),
          h('div', { style: { display: 'flex', gap: '.5rem', flexWrap: 'wrap' } },
            !['completed', 'dismissed'].includes(item.status) ? action('Complete', async () => {
              await api.post(`/api/households/${state.household.id}/reminders/${item.id}/complete`);
              toast('Reminder complete'); await load(mount, 'reminders');
            }) : chip(item.status, 'good'),
            item.status !== 'dismissed' ? action('Snooze 1 hour', async () => {
              await api.post(`/api/households/${state.household.id}/reminders/${item.id}/snooze`, {});
              toast('Snoozed'); await load(mount, 'reminders');
            }) : null,
          ),
        ))));
}

function addReminder(mount) {
  const title = input({ placeholder: 'Call insurance', required: true });
  const dueAt = input({ type: 'datetime-local', required: true });
  const assignedTo = select([['', 'Anyone'], ...state.members.map((m) => [m.id, m.displayName])]);
  return card('Add reminder', null, h('form', { onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/households/${state.household.id}/reminders`, { title: title.value.trim(), dueAt: dueAt.value, assignedTo: assignedTo.value });
      toast('Reminder added'); await load(mount, 'reminders');
    } catch (error) { toast(error.message ?? 'Could not add it.', 'error'); }
  } }, field('Reminder', title), field('When', dueAt), field('For', assignedTo), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add')));
}

function action(label, fn) {
  return h('button', { class: 'btn btn--quiet', type: 'button', onClick: async (e) => {
    e.currentTarget.disabled = true;
    try { await fn(); } catch (error) { toast(error.message ?? 'That did not work.', 'error'); }
    finally { e.currentTarget.disabled = false; }
  } }, label);
}
