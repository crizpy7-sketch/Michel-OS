import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, empty, field, icon, ICONS, input, select, toast, withStates } from '../lib/ui.js';
import { dayShort, statusLabel, time } from '../lib/format.js';

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
  if (items.length === 0) {
    return h('div', { class: 'shopping-page' },
      state.can('event.create') ? addShopping(mount) : null,
      empty({ title: 'Shopping list is clear', body: 'Add something when you need it.' }));
  }

  // Still needed first, then what is already in the trolley. A list you are
  // working down should not make you scroll past six ticked-off rows to find
  // the seventh thing you still have to pick up.
  const outstanding = items.filter((item) => item.status !== 'purchased');
  const bought = items.filter((item) => item.status === 'purchased');

  const groups = aisles(outstanding);
  // Headings are only worth their space when they actually gather something.
  // Six items in six aisles is six headings and no grouping, which is longer to
  // scroll and no easier to shop.
  const grouped = outstanding.length >= 4 && groups.length * 2 <= outstanding.length;

  return h('div', { class: 'shopping-page' },
    state.can('event.create') ? addShopping(mount) : null,
    ...(grouped
      ? groups.map(([aisle, group]) => h('section', { class: 'shopping-aisle' },
          h('h2', { class: 'shopping-aisle__title' }, aisle),
          h('div', { class: 'shopping-list' }, ...group.map((item) => shoppingItem(item, mount))),
        ))
      : [h('div', { class: 'shopping-list' }, ...outstanding.map((item) => shoppingItem(item, mount)))]),
    bought.length === 0 ? null : h('section', { class: 'shopping-aisle shopping-aisle--done' },
      h('h2', { class: 'shopping-aisle__title' }, `In the trolley · ${bought.length}`),
      h('div', { class: 'shopping-list' }, ...bought.map((item) => shoppingItem(item, mount))),
    ),
  );
}

/**
 * Group by aisle, in the order the aisles first appear.
 *
 * A grocery list is walked, not read: two things from the same aisle should be
 * next to each other on screen so they are picked up in one stop. Items with no
 * category collect at the end rather than each forming their own heading.
 */
function aisles(items) {
  const groups = new Map();
  for (const item of items) {
    const key = (item.category ?? '').trim() || (item.store ?? '').trim() || 'Anything else';
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    const list = groups.get(label) ?? [];
    list.push(item);
    groups.set(label, list);
  }
  const entries = [...groups.entries()];
  const other = entries.filter(([label]) => label === 'Anything else');
  return [...entries.filter(([label]) => label !== 'Anything else'), ...other];
}

function shoppingItem(item, mount) {
  const purchased = item.status === 'purchased';
  const quantity = Number(item.quantity);
  return h('article', { class: `shopping-item${purchased ? ' shopping-item--bought' : ''}` },
    h('div', { class: 'shopping-item__art', 'aria-hidden': 'true' },
      icon(purchased ? ICONS.check : ICONS.cart, 24)),
    h('div', { class: 'shopping-item__main' },
      h('h3', { class: 'shopping-item__name' }, item.name),
      // `Qty 1` on every row of a shopping list is six words that say nothing.
      // A quantity is worth the line only when it is not one.
      Number.isFinite(quantity) && quantity > 1
        ? h('p', { class: 'shopping-item__qty' }, `× ${quantity}`) : null,
      item.store ? h('p', { class: 'shopping-item__store' }, item.store) : null,
    ),
    h('div', { class: 'shopping-item__state' },
      purchased
        ? chip(statusLabel('purchased'), 'good')
        // The control used to be labelled with the state it was already in
        // ("needed"), which reads as a status badge rather than something you
        // can press. It now says what pressing it does.
        : h('button', {
            class: 'btn shopping-item__buy', type: 'button',
            'aria-label': `Mark ${item.name} as bought`,
            onClick: async (event) => {
              event.currentTarget.disabled = true;
              try {
                await api.patch(`/api/households/${state.household.id}/shopping/${item.id}`, { status: 'purchased' });
                toast(`${item.name} — got it`); await load(mount, 'shopping');
              } catch (error) { toast(error.message ?? 'That did not work.', 'error'); event.currentTarget.disabled = false; }
            },
          }, 'Got it'),
    ),
  );
}

function addShopping(mount) {
  const name = input({ placeholder: 'What do you need?', required: true });
  const store = input({ placeholder: 'Store (optional)' });
  const box = card('Add item', null, h('form', { class: 'shopping-add__form', onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/households/${state.household.id}/shopping`, { name: name.value.trim(), store: store.value.trim() });
      name.value = ''; store.value = ''; toast('Added'); await load(mount, 'shopping');
    } catch (error) { toast(error.message ?? 'Could not add it.', 'error'); }
  } }, field('Item', name), field('Store', store), h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Add')));
  box.classList.add('shopping-add');
  return box;
}

function errands(data, mount) {
  const items = data.errands ?? [];
  return h('div', { class: 'utility-list-page' }, state.can('event.create') ? addErrand(mount) : null,
    items.length === 0 ? empty({ title: 'No errands', body: 'Nothing to run out for right now.' })
      : h('div', { class: 'stack' }, ...items.map((item) => card(item.title, item.location || null,
          item.dueAt ? h('p', {}, `${dayShort(item.dueAt, state.timezone)} · ${time(item.dueAt, state.timezone)}`) : null,
          h('div', { class: 'row row--wrap' },
            chip(statusLabel(item.status, 'Open'), item.status === 'done' ? 'good' : 'quiet'),
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
  return h('div', { class: 'utility-list-page' }, state.can('event.create') ? addReminder(mount) : null,
    items.length === 0 ? empty({ title: 'No reminders', body: 'Your reminder list is clear.' })
      : h('div', { class: 'stack' }, ...items.map((item) => card(item.title, statusLabel(item.status) || null,
          h('p', {}, `${dayShort(item.dueAt, state.timezone)} · ${time(item.dueAt, state.timezone)}`),
          h('div', { class: 'row row--wrap' },
            !['completed', 'dismissed'].includes(item.status) ? action('Complete', async () => {
              await api.post(`/api/households/${state.household.id}/reminders/${item.id}/complete`);
              toast('Reminder complete'); await load(mount, 'reminders');
            }) : chip(statusLabel(item.status), 'good'),
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
