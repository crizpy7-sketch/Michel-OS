/**
 * Sign in, register, and first-run onboarding (Agent L).
 *
 * The first screen anybody sees, so it is the one that has to be clearest.
 * Three decisions worth stating:
 *
 * The sign-in and register forms are one component with a toggle, not two
 * screens. Somebody who taps the wrong one should not have to navigate back and
 * retype an email.
 *
 * The password field never has a maxlength and never blocks paste. Both are
 * common and both actively push people towards worse passwords — a manager
 * generates a long one, and a field that refuses it teaches them to type
 * something they can remember instead.
 *
 * The server's failure message for a bad login is deliberately the same whether
 * the account exists or not, and this screen shows it verbatim. Softening it to
 * "we couldn't find that account" would undo the server's care and turn the
 * form into a way to test whether an address has an account here.
 */

// `paint` is dom.js's `render`, renamed: every view EXPORTS a `render`, so
// importing one under the same name shadows it and the module fails to parse.
import { h, render as paint } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { button, card, field, input, select, toast } from '../lib/ui.js';

/** The zones a family in this app is plausibly in, plus whatever the device says. */
function timezoneOptions() {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const common = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'UTC',
  ];
  const all = [detected, ...common.filter((z) => z !== detected)];
  return all.map((zone) => [zone, zone.replace(/_/g, ' ')]);
}

function wrap(...children) {
  return h('div', { style: { maxWidth: '26rem', margin: '0 auto', paddingTop: '2rem' } }, ...children);
}

/* ------------------------------------------------------------- sign in */

export function render(mount, { onSignedIn }) {
  let mode = 'signin';
  let busy = false;
  let error = null;

  function draw() {
    const email = input({ type: 'email', name: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com' });
    const password = input({
      type: 'password', name: 'password', required: true,
      // `new-password` on the register form is what makes a password manager
      // offer to generate one rather than autofill the last thing typed.
      autocomplete: mode === 'signin' ? 'current-password' : 'new-password',
    });
    const displayName = input({ type: 'text', name: 'displayName', autocomplete: 'name', required: true, placeholder: 'Your name' });
    const householdName = input({ type: 'text', name: 'householdName', placeholder: 'The Michels' });
    const timezone = select(timezoneOptions(), { name: 'timezone' });
    const joinToken = input({ type: 'text', name: 'joinToken', placeholder: 'Paste an invitation code' });

    const form = h('form', {
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        if (busy) return;
        busy = true; error = null; draw();

        try {
          if (mode === 'signin') {
            await api.post('/api/auth/login', { email: email.value, password: password.value });
          } else {
            const joining = joinToken.value.trim().length > 0;
            await api.post('/api/auth/register', {
              email: email.value,
              password: password.value,
              displayName: displayName.value,
              ...(joining
                ? { joinToken: joinToken.value.trim() }
                : { householdName: householdName.value, timezone: timezone.value }),
            });
          }
          onSignedIn();
          return;
        } catch (failure) {
          error = failure;
        }
        busy = false;
        draw();
      },
    },
      field('Email', email, { error: error?.fieldErrors.get('email') }),
      field('Password', password, {
        hint: mode === 'register' ? 'At least 12 characters. A phrase you can remember beats a word with symbols in it.' : undefined,
        error: error?.fieldErrors.get('password'),
      }),
      mode === 'register' ? field('Your name', displayName) : null,
      mode === 'register' ? field('Household name', householdName, {
        hint: 'Leave blank if you were sent an invitation code.',
      }) : null,
      mode === 'register' ? field('Timezone', timezone, {
        hint: 'Every time in the app is shown in this zone, wherever anyone happens to be.',
      }) : null,
      mode === 'register' ? field('Invitation code', joinToken, {
        hint: 'Only if somebody sent you one.',
      }) : null,

      error && error.fieldErrors.size === 0
        ? h('p', { class: 'field__error', role: 'alert' }, error.message)
        : null,

      button(busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Create household',
        { kind: 'primary', type: 'submit', disabled: busy, class: 'btn btn--primary btn--block' }),
    );

    paint(mount, wrap(
      h('div', { class: 'center', style: { marginBottom: '2rem' } },
        h('h1', {}, 'Michel-OS'),
        h('p', { class: 'muted' }, "One place for the family's schedule."),
      ),
      card(null, null, form),
      h('p', { class: 'center muted tiny', style: { marginTop: '1rem' } },
        mode === 'signin' ? 'New here? ' : 'Already have an account? ',
        button(mode === 'signin' ? 'Create an account' : 'Sign in',
          { kind: 'quiet', onClick: () => { mode = mode === 'signin' ? 'register' : 'signin'; error = null; draw(); } }),
      ),
    ));
  }

  draw();
}

/* ---------------------------------------------------------- onboarding */

/**
 * Signed in, but in no household.
 *
 * Happens after accepting an invitation that was since revoked, or if somebody
 * was removed. Offering only "sign out" here would be a dead end, so both ways
 * forward are on the screen.
 */
export function renderOnboarding(mount, { onReady }) {
  const householdName = input({ type: 'text', placeholder: 'The Michels', required: true });
  const timezone = select(timezoneOptions());
  const token = input({ type: 'text', placeholder: 'Invitation code' });

  paint(mount, wrap(
    h('div', { class: 'center', style: { marginBottom: '2rem' } },
      h('h1', {}, 'Almost there'),
      h('p', { class: 'muted' }, 'You are signed in but not part of a household yet.'),
    ),

    card('Start a household', null,
      h('form', {
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            await api.post('/api/households', { name: householdName.value, timezone: timezone.value });
            onReady();
          } catch (error) { toast(error.message, 'error'); }
        },
      },
        field('Household name', householdName),
        field('Timezone', timezone),
        button('Create', { kind: 'primary', type: 'submit', class: 'btn btn--primary btn--block' }),
      ),
    ),

    card('Join with an invitation', null,
      h('form', {
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            await api.post(`/api/invitations/${encodeURIComponent(token.value.trim())}/accept`);
            onReady();
          } catch (error) { toast(error.message, 'error'); }
        },
      },
        field('Invitation code', token),
        button('Join', { type: 'submit', class: 'btn btn--block' }),
      ),
    ),
  ));
}
