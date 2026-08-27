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

  // One control, not two. This screen used to carry a native <select> near the
  // top AND the artwork picker below the notes field — the same value, roughly
  // 1500px apart, where choosing in one silently changed the other off-screen.
  let chosenDomain = domain;

  const defaults = defaultWindow();
  const startsAt = input({ name: 'startsAt', type: 'datetime-local', required: true, value: defaults.start });
  const endsAt = input({ name: 'endsAt', type: 'datetime-local', required: true, value: defaults.end });

  // Moving the start drags the end with it, keeping whatever length was set.
  // Otherwise every change of mind about the time means editing two fields, and
  // the ones people forget are the ends that quietly go backwards.
  let span = Date.parse(`${defaults.end}:00`) - Date.parse(`${defaults.start}:00`);
  startsAt.addEventListener('change', () => {
    const started = Date.parse(`${startsAt.value}:00`);
    if (!Number.isFinite(started) || !Number.isFinite(span) || span <= 0) return;
    endsAt.value = localInput(new Date(started + span));
  });
  endsAt.addEventListener('change', () => {
    const next = Date.parse(`${endsAt.value}:00`) - Date.parse(`${startsAt.value}:00`);
    if (Number.isFinite(next) && next > 0) span = next;
  });
  const locationInput = input({ name: 'location', placeholder: 'Optional location', maxlength: 200 });
  const notes = textarea({ name: 'notes', placeholder: 'Add note (optional)' });
  const repeat = select([['', 'Does not repeat'], ['DAILY', 'Daily'], ['WEEKLY', 'Weekly'], ['MONTHLY', 'Monthly']], { name: 'recurrenceFreq' });

  // A radiogroup rather than a row of toggle buttons: picking a mini-app is one
  // choice out of nine, which is what a radiogroup announces and what arrow keys
  // are expected to move through. Roving tabindex, so the group is one tab stop.
  const picker = h('div', { class: 'compose-miniapps', role: 'radiogroup', 'aria-label': 'Mini-app' });
  const pickerButtons = [];

  function choose(domainKey, { focus = false } = {}) {
    chosenDomain = domainKey;
    for (const other of pickerButtons) {
      const selected = other.dataset.domain === domainKey;
      other.classList.toggle('compose-miniapp--selected', selected);
      other.setAttribute('aria-checked', selected ? 'true' : 'false');
      other.tabIndex = selected ? 0 : -1;
      if (selected && focus) other.focus();
    }
  }

  eventDomains.forEach((app, index) => {
    const button = h('button', {
      class: `compose-miniapp${app.domain === domain ? ' compose-miniapp--selected' : ''}`,
      type: 'button',
      role: 'radio',
      'aria-checked': app.domain === domain ? 'true' : 'false',
      tabIndex: app.domain === domain ? 0 : -1,
      onClick: () => choose(app.domain),
      onKeyDown: (event) => {
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        const at = eventDomains.findIndex((x) => x.domain === chosenDomain);
        const next = eventDomains[(at + step + eventDomains.length) % eventDomains.length];
        choose(next.domain, { focus: true });
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

  const active = state.members.filter((m) => m.active !== false);

  /**
   * Who is responsible.
   *
   * The conflict engine flags a child's event with nobody marked responsible,
   * and it is right to — but this screen had no way to mark anyone, so every
   * event with a child in it was born as a blocking conflict the family could
   * not clear. A household of four opened on six clashes, five of them this.
   *
   * The API takes `responsibleIds` and always has; only the form was missing.
   */
  const canBeResponsible = active.filter((m) => m.role === 'owner' || m.role === 'adult' || m.role === 'teen');
  const responsible = select(
    [['', 'Nobody yet'], ...canBeResponsible.map((m) => [m.id, m.displayName])],
    { name: 'responsible' },
  );
  // The person adding it is usually the one taking it on.
  if (canBeResponsible.some((m) => m.id === state.member?.id)) responsible.value = state.member.id;

  const people = h('div', { class: 'compose-people' },
    h('h3', { class: 'compose-subtitle' }, 'People'),
    h('div', { class: 'compose-people__list' },
      ...active.map((member) => h('label', { class: 'compose-person' },
        h('input', { type: 'checkbox', name: 'participant', value: member.id }),
        h('span', {}, member.displayName),
      )),
    ),
    field('Responsible', responsible, {
      hint: 'Who is taking this one. An event with a child and nobody responsible is flagged as a clash.',
    }),
  );

  const form = h('form', { class: 'compose-form', onSubmit: async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const participantIds = [...form.querySelectorAll('input[name="participant"]:checked')].map((el) => el.value);
      // The role is only applied to people who are already participants, so
      // whoever is responsible joins the roster whether or not they were ticked.
      const responsibleId = responsible.value;
      if (responsibleId && !participantIds.includes(responsibleId)) participantIds.push(responsibleId);
      const body = {
        title: title.value.trim(), domain: chosenDomain,
        startsAt: startsAt.value, endsAt: endsAt.value,
        location: locationInput.value.trim(), notes: notes.value.trim(),
        participantIds,
        ...(responsibleId ? { responsibleIds: [responsibleId] } : {}),
      };
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
      h('div', { class: 'field compose-picker-section' },
        h('span', { class: 'field__label' }, 'Mini-app'),
        picker,
      ),
      field('Starts', startsAt),
      field('Ends', endsAt),
      field('Location', locationInput),
      field('Repeat', repeat, { hint: 'Weekly repeats on the weekday of the start date.' }),
      people,
      field('Notes', notes),
    ),
    h('button', { class: 'btn btn--primary btn--block compose-submit', type: 'submit' }, 'Add to schedule'),
  );

  mount.replaceChildren(h('p', { class: 'page-kicker compose-kicker' }, 'Create a new event'), form);
}

/** `2026-08-27T15:30` — the value a `datetime-local` input wants. */
function localInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The next half hour, running an hour — the shape of most things people add. */
function defaultWindow() {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() > 30 ? 60 : 30);
  const end = new Date(start.getTime() + 3600_000);
  return { start: localInput(start), end: localInput(end) };
}

function weekdayFor(local) {
  if (!local) return 'MO';
  const d = new Date(`${local}:00`);
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()] ?? 'MO';
}
