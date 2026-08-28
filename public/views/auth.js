/**
 * Sign in, register, and first-run onboarding (Agent L).
 *
 * Registration has two explicit paths: create a household, or join one with an
 * invitation. Mixing both into one long form made an invitation look like an
 * optional afterthought and left the primary button saying "Create household"
 * even when somebody was trying to join one.
 */

import { h, render as paint } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { button, card, field, input, select, toast } from '../lib/ui.js';

function timezoneOptions() {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const common = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'UTC',
  ];
  const all = [detected, ...common.filter((z) => z !== detected)];
  return all.map((zone) => [zone, zone.replace(/_/g, ' ')]);
}

function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

function wrap(...children) {
  return h('div', { style: { maxWidth: '26rem', margin: '0 auto', paddingTop: '2rem' } }, ...children);
}

/** Account setup is not part of the signed-in application navigation. */
function setAuthChromeHidden(hidden) {
  for (const selector of ['.tabbar', '.sidenav', '.topbar']) {
    const node = document.querySelector(selector);
    if (node) node.hidden = hidden;
  }
}

function friendlyInvitationError(error) {
  switch (error?.code) {
    case 'invitation_expired': return 'That invitation expired. Ask the household owner to create a new one.';
    case 'invitation_used': return 'That invitation has already been used. Ask the household owner for a new one.';
    case 'invitation_invalid':
    case 'not_found': return 'That invitation code is not valid. Check the code or ask for a new invitation.';
    default: return error?.message ?? 'That invitation could not be checked.';
  }
}

function friendlyRegistrationError(error, joining = false) {
  switch (error?.code) {
    case 'email_taken': return joining
      ? 'That email already has a Michel OS account. Use the same password and we will join the household instead.'
      : 'That email already has a Michel OS account. Sign in instead.';
    case 'invalid_email': return 'Enter a valid email address and your name.';
    case 'invitation_expired':
    case 'invitation_used':
    case 'invitation_invalid': return friendlyInvitationError(error);
    default: return error?.message ?? 'That registration could not be completed.';
  }
}

function roleLabel(role) {
  return String(role ?? 'member').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------- sign in */

export function render(mount, { onSignedIn }) {
  setAuthChromeHidden(true);
  let mode = 'signin';
  let registerPath = 'create';
  let busy = false;
  let error = null;
  let invitation = null;

  // Form values live outside draw(). A failed request used to redraw fresh
  // controls and erase the email, password, name and invitation code the person
  // had just typed — especially painful on a phone after pasting a long token.
  const draft = {
    email: '',
    password: '',
    displayName: '',
    householdName: '',
    timezone: defaultTimezone(),
    joinToken: '',
  };

  const localError = (message) => ({ message, fieldErrors: new Map() });

  async function previewInvitation() {
    const token = draft.joinToken.trim();
    if (!token) {
      invitation = null;
      error = localError('Paste the invitation code first.');
      return false;
    }
    try {
      invitation = await api.get(`/api/invitations/${encodeURIComponent(token)}`);
      error = null;
      return true;
    } catch (failure) {
      invitation = null;
      error = localError(friendlyInvitationError(failure));
      return false;
    }
  }

  async function registerOrJoin() {
    if (registerPath === 'create') {
      await api.post('/api/auth/register', {
        email: draft.email,
        password: draft.password,
        displayName: draft.displayName,
        householdName: draft.householdName,
        timezone: draft.timezone,
      });
      return;
    }

    if (!(await previewInvitation())) throw error;

    const token = draft.joinToken.trim();
    try {
      await api.post('/api/auth/register', {
        email: draft.email,
        password: draft.password,
        displayName: draft.displayName,
        joinToken: token,
      });
    } catch (failure) {
      if (failure?.code !== 'email_taken') throw failure;

      // The invitation may be going to somebody who already made an account in
      // an earlier attempt. Do not force them through an undocumented second
      // flow: authenticate that existing account, then accept the invitation.
      try {
        await api.post('/api/auth/login', { email: draft.email, password: draft.password });
        await api.post(`/api/invitations/${encodeURIComponent(token)}/accept`, {});
      } catch (existingFailure) {
        // login() has already set a session cookie if authentication succeeded;
        // clear it when invitation acceptance fails so the form is not secretly
        // signed in behind an error state.
        await api.post('/api/auth/logout', {}).catch(() => {});
        if (existingFailure?.code === 'invalid_credentials') {
          throw localError('That email already has an account. Enter its existing password to join this household.');
        }
        throw localError(friendlyInvitationError(existingFailure));
      }
    }
  }

  function draw() {
    const email = input({
      type: 'email', name: 'email', autocomplete: 'email', required: true,
      placeholder: 'you@example.com', value: draft.email,
      onInput: (e) => { draft.email = e.currentTarget.value; },
    });
    const password = input({
      type: 'password', name: 'password', required: true,
      autocomplete: mode === 'signin' ? 'current-password' : 'new-password',
      value: draft.password,
      onInput: (e) => { draft.password = e.currentTarget.value; },
    });
    const displayName = input({
      type: 'text', name: 'displayName', autocomplete: 'name', required: true,
      placeholder: 'Your name', value: draft.displayName,
      onInput: (e) => { draft.displayName = e.currentTarget.value; },
    });
    const householdName = input({
      type: 'text', name: 'householdName', required: true,
      placeholder: 'The Michels', value: draft.householdName,
      onInput: (e) => { draft.householdName = e.currentTarget.value; },
    });
    const timezone = select(timezoneOptions(), {
      name: 'timezone',
      onChange: (e) => { draft.timezone = e.currentTarget.value; },
    });
    timezone.value = draft.timezone;
    const joinToken = input({
      type: 'text', name: 'joinToken', required: true,
      autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
      placeholder: 'Paste an invitation code', value: draft.joinToken,
      onInput: (e) => {
        draft.joinToken = e.currentTarget.value;
        invitation = null;
        error = null;
      },
    });

    const joining = mode === 'register' && registerPath === 'join';
    const createOrJoin = mode === 'register' ? h('div', {
      class: 'row row--wrap',
      style: { marginBottom: '1rem' },
      role: 'group',
      'aria-label': 'Account setup choice',
    },
    h('button', {
      class: `btn${registerPath === 'create' ? ' btn--primary' : ' btn--quiet'}`,
      type: 'button',
      'aria-pressed': registerPath === 'create' ? 'true' : 'false',
      onClick: () => { registerPath = 'create'; invitation = null; error = null; draw(); },
    }, 'Create household'),
    h('button', {
      class: `btn${registerPath === 'join' ? ' btn--primary' : ' btn--quiet'}`,
      type: 'button',
      'aria-pressed': registerPath === 'join' ? 'true' : 'false',
      onClick: () => { registerPath = 'join'; error = null; draw(); },
    }, 'Join household')) : null;

    const invitationStatus = joining && invitation
      ? h('p', { class: 'muted', role: 'status' },
          `Invitation confirmed: ${invitation.householdName} · ${roleLabel(invitation.role)}`)
      : null;

    const form = h('form', {
      onSubmit: async (event) => {
        event.preventDefault();
        if (busy) return;
        busy = true; error = null; draw();

        try {
          if (mode === 'signin') {
            await api.post('/api/auth/login', { email: draft.email, password: draft.password });
          } else {
            await registerOrJoin();
          }
          setAuthChromeHidden(false);
          onSignedIn();
          return;
        } catch (failure) {
          error = failure?.fieldErrors instanceof Map
            ? failure
            : localError(mode === 'register'
              ? friendlyRegistrationError(failure, joining)
              : (failure?.message ?? 'That email and password do not match.'));
        }
        busy = false;
        draw();
      },
    },
      mode === 'register' ? createOrJoin : null,
      mode === 'register' ? h('p', { class: 'muted', style: { marginBottom: '1rem' } },
        joining
          ? 'Use the invitation code you were sent. You will join the existing household — you are not creating a second one.'
          : 'Create a new household for your family. If somebody already invited you, choose Join household instead.') : null,
      field('Email', email, { error: error?.fieldErrors?.get?.('email') }),
      field('Password', password, {
        hint: mode === 'register' ? 'At least 12 characters. A phrase you can remember beats a word with symbols in it.' : undefined,
        error: error?.fieldErrors?.get?.('password'),
      }),
      mode === 'register' ? field('Your name', displayName) : null,
      mode === 'register' && !joining ? field('Household name', householdName) : null,
      mode === 'register' && !joining ? field('Timezone', timezone, {
        hint: 'Every time in the app is shown in this zone, wherever anyone happens to be.',
      }) : null,
      joining ? field('Invitation code', joinToken, {
        hint: 'Paste the code exactly as it was sent to you.',
      }) : null,
      joining ? h('div', { class: 'row row--wrap', style: { marginBottom: '.75rem' } },
        button('Check invitation', {
          kind: 'quiet',
          onClick: async () => { if (busy) return; busy = true; error = null; draw(); await previewInvitation(); busy = false; draw(); },
          disabled: busy,
        }),
        invitationStatus,
      ) : null,

      error && error.fieldErrors?.size === 0
        ? h('p', { class: 'field__error', role: 'alert' }, error.message)
        : null,

      button(
        busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : joining ? 'Join household' : 'Create household',
        { kind: 'primary', type: 'submit', disabled: busy, class: 'btn btn--primary btn--block' },
      ),
    );

    paint(mount, wrap(
      h('div', { class: 'center', style: { marginBottom: '2rem' } },
        h('h1', {}, 'Michel-OS'),
        h('p', { class: 'muted' }, "One place for the family's schedule."),
      ),
      card(null, null, form),
      h('p', { class: 'center muted tiny', style: { marginTop: '1rem' } },
        mode === 'signin' ? 'New here? ' : 'Already have an account? ',
        button(mode === 'signin' ? 'Create an account' : 'Sign in', {
          kind: 'quiet',
          onClick: () => {
            mode = mode === 'signin' ? 'register' : 'signin';
            error = null; invitation = null; draw();
          },
        }),
      ),
    ));
  }

  draw();
}

/* ---------------------------------------------------------- onboarding */

export function renderOnboarding(mount, { onReady }) {
  setAuthChromeHidden(true);
  const householdName = input({ type: 'text', placeholder: 'The Michels', required: true });
  const timezone = select(timezoneOptions());
  const token = input({ type: 'text', placeholder: 'Invitation code', required: true, autocapitalize: 'none', spellcheck: 'false' });

  paint(mount, wrap(
    h('div', { class: 'center', style: { marginBottom: '2rem' } },
      h('h1', {}, 'Almost there'),
      h('p', { class: 'muted' }, 'You are signed in but not part of a household yet.'),
    ),

    card('Start a household', null,
      h('form', {
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            await api.post('/api/households', { name: householdName.value, timezone: timezone.value });
            setAuthChromeHidden(false);
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
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            await api.post(`/api/invitations/${encodeURIComponent(token.value.trim())}/accept`);
            setAuthChromeHidden(false);
            onReady();
          } catch (error) { toast(friendlyInvitationError(error), 'error'); }
        },
      },
        field('Invitation code', token),
        button('Join household', { type: 'submit', class: 'btn btn--block' }),
      ),
    ),
  ));
}