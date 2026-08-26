/**
 * Session state (Agent L).
 *
 * One module holds who is signed in, which household is active, and the roster.
 * Views read it; only `refresh()` and `setHousehold()` write it.
 *
 * The important rule here is the one about permissions. `state.can()` exists
 * for AFFORDANCES only — whether to render the "Add" button, whether to show
 * the ledger tile. It is never a security decision, because it cannot be: this
 * code runs on a phone the family owns and anything it decides can be decided
 * differently by anyone with the developer tools open. The server's
 * `authorize()` is the only thing that actually protects a row, and every
 * mutation reaches it. Hiding a button the server would refuse anyway is a
 * courtesy, not a control.
 */

import { api } from './api.js';

const LAST_HOUSEHOLD = 'michel.household';

export const state = {
  user: null,
  household: null,
  member: null,
  households: [],
  members: [],
  business: null,
  permissions: new Set(),
  iconManifest: null,

  get signedIn() { return this.user !== null; },
  get timezone() { return this.household?.timezone ?? 'UTC'; },

  /** UI affordance only — see the note above. */
  can(permission) { return this.permissions.has(permission); },

  memberById(id) { return this.members.find((m) => m.id === id) ?? null; },
  nameOf(id) { return this.memberById(id)?.displayName ?? 'Someone'; },
};

/**
 * The role → permission table, mirrored from `domains/household/permissions.ts`.
 *
 * A copy, and knowingly so: the server does not send the actor's permission
 * list, and adding an endpoint for it would publish the authorization model to
 * anyone who asks. Because this is affordance-only, a copy that drifts shows a
 * button that the server then refuses with a clear message — annoying, not
 * unsafe. If it were load-bearing it would have to be derived, not copied.
 */
const ROLE_MATRIX = {
  owner: ['event.read', 'event.create', 'event.update.own', 'event.update.any', 'event.delete.own',
    'event.delete.any', 'reminder.complete.own', 'reminder.snooze.own', 'reminder.manage.any',
    'member.manage', 'household.manage', 'business.read', 'business.manage', 'employee.schedule',
    'finance.read', 'finance.manage', 'ai.propose', 'ai.execute.autonomous'],
  adult: ['event.read', 'event.create', 'event.update.own', 'event.update.any', 'event.delete.own',
    'event.delete.any', 'reminder.complete.own', 'reminder.snooze.own', 'reminder.manage.any',
    'member.manage', 'business.read', 'finance.read', 'ai.propose'],
  teen: ['event.read', 'event.create', 'event.update.own', 'event.delete.own',
    'reminder.complete.own', 'reminder.snooze.own', 'ai.propose'],
  child: ['event.read', 'reminder.complete.own', 'reminder.snooze.own'],
  employee: ['business.read', 'employee.schedule', 'ai.propose'],
  viewer: ['event.read'],
};

/**
 * Load the signed-in user and the active household.
 *
 * Returns `false` when nobody is signed in, so the caller shows the sign-in
 * screen rather than treating it as an error — a 401 on boot is the normal
 * first visit, not a failure.
 */
export async function refresh() {
  let me;
  try {
    me = await api.get('/api/me');
  } catch (error) {
    if (error.isAuth) { reset(); return false; }
    throw error;
  }

  state.user = me.user;
  state.households = me.households ?? [];

  if (state.households.length === 0) {
    state.household = null;
    return true;
  }

  // The last household used, if it is still one this person belongs to. The
  // membership check matters: a stale id from before somebody left a household
  // would otherwise ask the server for a household it will answer 404 for, and
  // the app would look broken rather than just picking the other one.
  const remembered = safeRead(LAST_HOUSEHOLD);
  const chosen = state.households.find((entry) => entry.household.id === remembered)
    ?? state.households[0];

  await loadHousehold(chosen.household.id);
  return true;
}

export async function loadHousehold(householdId) {
  const detail = await api.get(`/api/households/${householdId}`);
  state.household = detail.household;
  state.member = detail.member;
  state.members = detail.members ?? [];
  state.business = detail.business ?? null;
  state.permissions = new Set(ROLE_MATRIX[detail.member?.role] ?? []);
  safeWrite(LAST_HOUSEHOLD, householdId);
  return detail;
}

export function reset() {
  state.user = null;
  state.household = null;
  state.member = null;
  state.households = [];
  state.members = [];
  state.business = null;
  state.permissions = new Set();
}

/** Icon URLs, fetched once. */
export async function icons() {
  if (state.iconManifest === null) {
    try {
      state.iconManifest = await api.get('/icons/derived/manifest.json');
    } catch {
      // A missing manifest must not take the home screen down with it; the
      // tiles fall back to a lettered placeholder.
      state.iconManifest = { icons: [] };
    }
  }
  return state.iconManifest;
}

/**
 * `localStorage` throws outright in a locked-down browser or a private window
 * on some platforms, so both accessors are wrapped. A remembered household is
 * a convenience; losing it must never stop the app from starting.
 */
function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); } catch { /* nothing to do */ }
}
