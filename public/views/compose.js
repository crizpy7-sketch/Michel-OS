import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { field, input, select, textarea, toast } from '../lib/ui.js';
import { MINI_APPS } from '../lib/miniapps.js';

export async function render(mount, _params, { navigate, setTitle }) {
  setTitle('Add');
  if (!state.can('event.create')) {
    mount.replaceChildren(h('div', { class: 'state state--denied' }, h('p', { class: 'state__title' }, 'You can view the calendar'), h('p', { class: 'state__body' }, 'Your account cannot add calendar items.')));
    return;
  }

  const requested = new URLSearchParams(location.search).get('domain');
  const eventDomains = MINI_APPS.filter((x) => x.domain && !['shopping', 'errands', 'reminders', 'inbox', 'shia-baby'].includes(x.domain));
  const domain = eventDomains.some((x) => x.domain === requested) ? requested : 'appointments';

  const title = input({ name: 'title', placeholder: 'Dentist, practice, school event…', required: true, maxlength: 200 });
  const domainControl = select(eventDomains.map((x) => [x.domain, x.label]), { name: 'domain', value: domain });
  const startsAt = input({ name: 'startsAt', type: 'datetime-local', required: true });
  const endsAt = input({ name: 'endsAt', type: 'datetime-local', required: true });
  const locationInput = input({ name: 'location', placeholder: 'Optional location', maxlength: 200 });
  const notes = textarea({ name: 'notes', placeholder: 'Anything the family should know' });
  const repeat = select([['', 'Does not repeat'], ['DAILY', 'Daily'], ['WEEKLY', 'Weekly'], ['MONTHLY', 'Monthly']], { name: 'recurrenceFreq' });

  const people = h('div', { class: 'card', style: { marginBottom: '1rem' } },
    h('h3', { class: 'card__title', style: { marginBottom: '.75rem' } }, 'People'),
    ...state.members.filter((m) => m.active !== false).map((member) => h('label', { style: { display: 'flex', alignItems: 'center', gap: '.65rem', minHeight: '44px' } }, h('input', { type: 'checkbox', name: 'participant', value: member.id }), h('span', {}, member.displayName))),
  );

  const form = h('form', { onSubmit: async (event) => {
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
    field('Title', title), field('Mini-app', domainControl),
    h('div', { class: 'split' }, field('Starts', startsAt), field('Ends', endsAt)),
    field('Location', locationInput), field('Repeat', repeat, { hint: 'Weekly repeats on the weekday of the start date.' }), people, field('Notes', notes),
    h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Add to schedule'),
  );
  mount.replaceChildren(form);
}

function weekdayFor(local) {
  if (!local) return 'MO';
  const d = new Date(`${local}:00`);
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()] ?? 'MO';
}
