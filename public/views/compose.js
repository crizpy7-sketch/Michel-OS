import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { field, input, select, textarea, toast } from '../lib/ui.js';
import { MINI_APPS } from '../lib/miniapps.js';
import { miniAppArt } from '../lib/art.js';

export async function render(mount, _params, { navigate, setTitle }) {
  setTitle('Add');
  if (!state.can('event.create')) {
    mount.replaceChildren(h('div', { class: 'state state--denied' }, h('p', { class: 'state__title' }, 'You can view the calendar'), h('p', { class: 'state__body' }, 'Your account cannot add calendar items.')));
    return;
  }

  const requested = new URLSearchParams(location.search).get('domain');
  const eventDomains = MINI_APPS.filter((x) => x.domain && !['shopping', 'errands', 'reminders', 'inbox', 'shia-baby'].includes(x.domain));
  const domain = eventDomains.some((x) => x.domain === requested) ? requested : 'appointments';

  const title = input({ name: 'title', placeholder: 'Doctor appointment', required: true, maxlength: 200 });
  const domainControl = select(eventDomains.map((x) => [x.domain, x.label]), { name: 'domain', value: domain, class: 'select compose-domain-native' });
  const startsAt = input({ name: 'startsAt', type: 'datetime-local', required: true });
  const endsAt = input({ name: 'endsAt', type: 'datetime-local', required: true });
  const locationInput = input({ name: 'location', placeholder: 'Optional location', maxlength: 200 });
  const notes = textarea({ name: 'notes', placeholder: 'Add note (optional)' });
  const repeat = select([['', 'Does not repeat'], ['DAILY', 'Daily'], ['WEEKLY', 'Weekly'], ['MONTHLY', 'Monthly']], { name: 'recurrenceFreq' });

  const picker = h('div', { class: 'compose-miniapps', role: 'group', 'aria-label': 'Choose mini-app' });
  const pickerButtons = [];
  eventDomains.forEach((app, index) => {
    const button = h('button', {
      class: `compose-miniapp${app.domain === domain ? ' compose-miniapp--selected' : ''}`,
      type: 'button',
      'aria-pressed': app.domain === domain ? 'true' : 'false',
      onClick: () => {
        domainControl.value = app.domain;
        for (const other of pickerButtons) {
          const selected = other.dataset.domain === app.domain;
          other.classList.toggle('compose-miniapp--selected', selected);
          other.setAttribute('aria-pressed', selected ? 'true' : 'false');
        }
      },
      dataset: { domain: app.domain },
    }, h('span', { class: 'compose-miniapp__art' }), h('span', { class: 'compose-miniapp__label' }, app.label));
    pickerButtons.push(button);
    picker.append(button);
    void miniAppArt(app, { size: 56, eager: index < 5 }).then((art) => {
      art.classList.add('compose-miniapp__image');
      button.querySelector('.compose-miniapp__art')?.replaceChildren(art);
    });
  });

  const people = h('div', { class: 'compose-people' },
    h('h3', { class: 'compose-subtitle' }, 'People'),
    h('div', { class: 'compose-people__list' },
      ...state.members.filter((m) => m.active !== false).map((member) => h('label', { class: 'compose-person' },
        h('input', { type: 'checkbox', name: 'participant', value: member.id }),
        h('span', {}, member.displayName),
      )),
    ),
  );

  const form = h('form', { class: 'compose-form', onSubmit: async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const participantIds = [...form.querySelectorAll('input[name="participant"]:checked')].map((el) => el.value);
      const body = { title: title.value.trim(), domain: domainControl.value, startsAt: startsAt.value, endsAt: endsAt.value, location: locationInput.value.trim(), notes: notes.value.trim(), participantIds };
      if (repeat.value) body.recurrence = { freq: repeat.value, interval: 1, ...(repeat.value === 'WEEKLY' ? { byWeekday: [weekdayFor(startsAt.value)] } : {}) };
      const saved = await api.post(`/api/households/${state.household.id}/events`, body);
      toast('Added to the family schedule');
      navigate(`/event/${encodeURIComponent(saved.id)}`, { replace: true });
    } catch (error) {
      toast(error.message ?? 'Could not add that.', 'error');
    } finally { submit.disabled = false; }
  } },
    h('div', { class: 'card compose-form-card' },
      field('Title', title),
      h('div', { class: 'compose-domain-native-wrap' }, field('Mini-app', domainControl)),
      field('Date & starts', startsAt),
      field('Ends', endsAt),
      field('Location', locationInput),
      field('Repeat', repeat, { hint: 'Weekly repeats on the weekday of the start date.' }),
      people,
      field('Notes', notes),
    ),
    h('div', { class: 'compose-picker-section' },
      h('p', { class: 'page-kicker' }, 'Choose mini-app'),
      picker,
    ),
    h('button', { class: 'btn btn--primary btn--block compose-submit', type: 'submit' }, 'Add to schedule'),
  );

  mount.replaceChildren(h('p', { class: 'page-kicker compose-kicker' }, 'Create a new event'), form);
}

function weekdayFor(local) {
  if (!local) return 'MO';
  const d = new Date(`${local}:00`);
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()] ?? 'MO';
}
