/**
 * Removal, over a real socket (Agent B3).
 *
 * The app could create almost everything and remove almost nothing, and the
 * bug that got reported — "I can't remove test employee" — was that gap rather
 * than a crash. These tests cover the endpoints that closed it, and they are
 * written around two questions that matter more than the happy path:
 *
 *   1. Does a member of ANOTHER household get 404 from every one of them?
 *      A delete is the one verb where a tenancy mistake is unrecoverable, so
 *      every endpoint below has its own cross-household case rather than one
 *      shared loop that a later edit could quietly stop covering.
 *
 *   2. When the row has history, is it kept? An employee who worked shifts, a
 *      product that has sold — those are deactivated and archived, and the
 *      test asserts the ledger still points at something real afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { call, joinHousehold, registerOwner, startHarness, type Agent, type Harness } from './harness.ts';

const NOW = '2026-09-07T12:00:00.000Z';

/** A household with a Shia Baby business, and a stranger who owns another one. */
async function shop(h: Harness): Promise<{ owner: Agent; outsider: Agent }> {
  const owner = await registerOwner(h);
  const outsider = await registerOwner(h);
  const business = await call(h, `/api/households/${owner.householdId}/business`, {
    method: 'POST', token: owner.token,
    body: { name: 'Shia Baby', timezone: 'America/Chicago', taxSetAsideRate: 0.2 },
  });
  assert.equal(business.status, 201);
  return { owner, outsider };
}

async function addEmployee(h: Harness, owner: Agent, displayName: string): Promise<string> {
  const response = await call<{ id: string }>(
    h, `/api/households/${owner.householdId}/business/employees`,
    { method: 'POST', token: owner.token, body: { displayName, hourlyRateCents: 1600 } },
  );
  assert.equal(response.status, 201);
  return response.body.id;
}

async function addProduct(h: Harness, owner: Agent, sku: string): Promise<string> {
  const response = await call<{ id: string }>(
    h, `/api/households/${owner.householdId}/business/products`,
    {
      method: 'POST', token: owner.token,
      body: { sku, name: `Product ${sku}`, quantityOnHand: 0, reorderPoint: 1, unitPriceCents: 2400 },
    },
  );
  assert.equal(response.status, 201);
  return response.body.id;
}

interface BusinessView {
  employees: Array<{ id: string; active: boolean }>;
  shifts: Array<{ id: string; status: string }>;
  products: Array<{ id: string; sku: string }>;
}

const readBusiness = (h: Harness, owner: Agent): Promise<{ status: number; body: BusinessView }> =>
  call<BusinessView>(h, `/api/households/${owner.householdId}/business`, { token: owner.token });

/* ============================================================== employees */

test('an employee who never worked is deleted outright — the reported bug', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner } = await shop(h);
  const employeeId = await addEmployee(h, owner, 'Test Employee');

  const removed = await call<{ outcome: string }>(
    h, `/api/households/${owner.householdId}/business/employees/${employeeId}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.outcome, 'deleted');

  const after = await readBusiness(h, owner);
  assert.equal(after.body.employees.length, 0, 'the employee is still on the roster');

  // And out of search, not merely off the screen.
  const hits = await call<{ hits: unknown[] }>(
    h, `/api/households/${owner.householdId}/search?q=Test`, { token: owner.token });
  assert.deepEqual(hits.body.hits, []);
});

test('an employee with shifts is deactivated, not deleted — the hours stay attributed', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner } = await shop(h);
  const employeeId = await addEmployee(h, owner, 'Maria');

  const shift = await call<{ shift: { id: string } }>(
    h, `/api/households/${owner.householdId}/business/shifts`,
    {
      method: 'POST', token: owner.token,
      body: { employeeId, startsAt: '2026-09-10T09:00', endsAt: '2026-09-10T17:00', role: 'Front' },
    },
  );
  assert.equal(shift.status, 201);

  const removed = await call<{ outcome: string; employee: { active: boolean } }>(
    h, `/api/households/${owner.householdId}/business/employees/${employeeId}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.outcome, 'deactivated');
  assert.equal(removed.body.employee.active, false);

  const after = await readBusiness(h, owner);
  assert.equal(after.body.employees.length, 1, 'the row was destroyed with shifts pointing at it');
  assert.equal(after.body.employees[0]?.active, false);
  assert.equal(after.body.shifts.length, 1, 'the shift they worked disappeared with them');
});

test('a member of another household cannot remove an employee', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner, outsider } = await shop(h);
  const employeeId = await addEmployee(h, owner, 'Maria');

  const denied = await call(
    h, `/api/households/${owner.householdId}/business/employees/${employeeId}`,
    { method: 'DELETE', token: outsider.token },
  );
  assert.equal(denied.status, 404, 'a cross-tenant delete is the worst possible bug here');
  assert.equal((await readBusiness(h, owner)).body.employees.length, 1);
});

test('a viewer cannot remove an employee', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner } = await shop(h);
  const employeeId = await addEmployee(h, owner, 'Maria');
  const viewer = await joinHousehold(h, owner, 'viewer');

  const denied = await call(
    h, `/api/households/${owner.householdId}/business/employees/${employeeId}`,
    { method: 'DELETE', token: viewer.token },
  );
  assert.equal(denied.status, 403);
});

/* ================================================================= shifts */

test('a draft shift is deleted; a published one is cancelled and kept', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner } = await shop(h);
  const employeeId = await addEmployee(h, owner, 'Maria');

  const draft = await call<{ shift: { id: string } }>(
    h, `/api/households/${owner.householdId}/business/shifts`,
    {
      method: 'POST', token: owner.token,
      body: { employeeId, startsAt: '2026-09-10T09:00', endsAt: '2026-09-10T17:00' },
    },
  );
  assert.equal(draft.status, 201);

  const keeper = await call<{ shift: { id: string } }>(
    h, `/api/households/${owner.householdId}/business/shifts`,
    {
      method: 'POST', token: owner.token,
      body: { employeeId, startsAt: '2026-09-11T09:00', endsAt: '2026-09-11T17:00' },
    },
  );
  assert.equal(keeper.status, 201);

  const published = await call(h, `/api/households/${owner.householdId}/business/publish`, {
    method: 'POST', token: owner.token, body: { force: true },
  });
  assert.equal(published.status, 200);

  // Both are published now, so both take the cancel path.
  const cancelled = await call<{ outcome: string; shift: { status: string } }>(
    h, `/api/households/${owner.householdId}/business/shifts/${keeper.body.shift.id}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.outcome, 'cancelled');
  assert.equal(cancelled.body.shift.status, 'cancelled');

  const after = await readBusiness(h, owner);
  assert.equal(after.body.shifts.length, 2, 'a published shift must survive its cancellation');
  assert.equal(
    after.body.shifts.find((s) => s.id === keeper.body.shift.id)?.status, 'cancelled');

  // A fresh draft, never published, leaves nothing behind.
  const fresh = await call<{ shift: { id: string } }>(
    h, `/api/households/${owner.householdId}/business/shifts`,
    {
      method: 'POST', token: owner.token,
      body: { employeeId, startsAt: '2026-09-12T09:00', endsAt: '2026-09-12T17:00' },
    },
  );
  const deleted = await call<{ outcome: string }>(
    h, `/api/households/${owner.householdId}/business/shifts/${fresh.body.shift.id}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.outcome, 'deleted');
  assert.equal((await readBusiness(h, owner)).body.shifts.length, 2);
});

test('a member of another household cannot remove a shift', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner, outsider } = await shop(h);
  const employeeId = await addEmployee(h, owner, 'Maria');
  const shift = await call<{ shift: { id: string } }>(
    h, `/api/households/${owner.householdId}/business/shifts`,
    {
      method: 'POST', token: owner.token,
      body: { employeeId, startsAt: '2026-09-10T09:00', endsAt: '2026-09-10T17:00' },
    },
  );

  const denied = await call(
    h, `/api/households/${owner.householdId}/business/shifts/${shift.body.shift.id}`,
    { method: 'DELETE', token: outsider.token },
  );
  assert.equal(denied.status, 404);
  assert.equal((await readBusiness(h, owner)).body.shifts.length, 1);
});

/* =============================================================== products */

test('a product with no ledger history is deleted', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner } = await shop(h);
  const productId = await addProduct(h, owner, 'TEST-1');

  const removed = await call<{ outcome: string }>(
    h, `/api/households/${owner.householdId}/business/products/${productId}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.outcome, 'deleted');
  assert.equal((await readBusiness(h, owner)).body.products.length, 0);
});

test('a product with stock movements is archived, and its movements survive', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner } = await shop(h);
  const productId = await addProduct(h, owner, 'SOLD-1');

  const received = await call(h, `/api/households/${owner.householdId}/business/inventory`, {
    method: 'POST', token: owner.token,
    body: { productId, kind: 'receive', quantityDelta: 12 },
  });
  assert.equal(received.status, 201);

  const removed = await call<{ outcome: string }>(
    h, `/api/households/${owner.householdId}/business/products/${productId}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.outcome, 'archived');

  const inventory = await call<{ products: unknown[]; drift: unknown[] }>(
    h, `/api/households/${owner.householdId}/business/inventory`, { token: owner.token });
  assert.equal(inventory.body.products.length, 0, 'an archived product is still for sale');

  // The row itself is still there for the ledger to point at.
  const { rows } = await h.db.query<{ n: number }>(
    `select count(*)::int as n from inventory_movement where product_id = $1`, [productId]);
  assert.equal(Number(rows[0]?.n), 1, 'archiving a product destroyed its stock ledger');

  // Removing it twice is a 404, not a second archive.
  const again = await call(
    h, `/api/households/${owner.householdId}/business/products/${productId}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(again.status, 404);
});

test('a member of another household cannot remove a product', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const { owner, outsider } = await shop(h);
  const productId = await addProduct(h, owner, 'TEST-1');

  const denied = await call(
    h, `/api/households/${owner.householdId}/business/products/${productId}`,
    { method: 'DELETE', token: outsider.token },
  );
  assert.equal(denied.status, 404);
  assert.equal((await readBusiness(h, owner)).body.products.length, 1);
});

/* =============================================================== shopping */

test('a shopping item can be deleted, and un-bought back to needed', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const item = await call<{ id: string }>(h, `/api/households/${owner.householdId}/shopping`, {
    method: 'POST', token: owner.token, body: { name: 'Oat milk', store: 'Aldi' },
  });
  assert.equal(item.status, 201);

  // "Got it" — and then the mistake everyone makes, undone.
  const bought = await call<{ status: string }>(
    h, `/api/households/${owner.householdId}/shopping/${item.body.id}`,
    { method: 'PATCH', token: owner.token, body: { status: 'purchased' } });
  assert.equal(bought.status, 200);
  assert.equal(bought.body.status, 'purchased');

  const unbought = await call<{ status: string }>(
    h, `/api/households/${owner.householdId}/shopping/${item.body.id}`,
    { method: 'PATCH', token: owner.token, body: { status: 'needed' } });
  assert.equal(unbought.status, 200);
  assert.equal(unbought.body.status, 'needed', 'un-buying is a legal transition and must stay one');

  const deleted = await call(h, `/api/households/${owner.householdId}/shopping/${item.body.id}`,
    { method: 'DELETE', token: owner.token });
  assert.equal(deleted.status, 204);

  const list = await call<{ items: unknown[] }>(
    h, `/api/households/${owner.householdId}/shopping`, { token: owner.token });
  assert.deepEqual(list.body.items, []);

  // The second delete is a 404 rather than a silent success.
  const again = await call(h, `/api/households/${owner.householdId}/shopping/${item.body.id}`,
    { method: 'DELETE', token: owner.token });
  assert.equal(again.status, 404);
});

test('a member of another household cannot delete a shopping item', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  const outsider = await registerOwner(h);

  const item = await call<{ id: string }>(h, `/api/households/${owner.householdId}/shopping`, {
    method: 'POST', token: owner.token, body: { name: 'Oat milk' },
  });

  const denied = await call(h, `/api/households/${owner.householdId}/shopping/${item.body.id}`,
    { method: 'DELETE', token: outsider.token });
  assert.equal(denied.status, 404);

  const list = await call<{ items: unknown[] }>(
    h, `/api/households/${owner.householdId}/shopping`, { token: owner.token });
  assert.equal(list.body.items.length, 1, 'a stranger deleted this household\'s list');
});

/* ================================================================ errands */

test('an errand can be deleted and stops coming back in the list', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const errand = await call<{ id: string }>(h, `/api/households/${owner.householdId}/errands`, {
    method: 'POST', token: owner.token, body: { title: 'Return the parcel', location: 'Post office' },
  });
  assert.equal(errand.status, 201);

  const deleted = await call(h, `/api/households/${owner.householdId}/errands/${errand.body.id}`,
    { method: 'DELETE', token: owner.token });
  assert.equal(deleted.status, 204);

  const list = await call<{ errands: unknown[] }>(
    h, `/api/households/${owner.householdId}/errands`, { token: owner.token });
  assert.deepEqual(list.body.errands, []);
});

test('a member of another household cannot delete an errand', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  const outsider = await registerOwner(h);

  const errand = await call<{ id: string }>(h, `/api/households/${owner.householdId}/errands`, {
    method: 'POST', token: owner.token, body: { title: 'Return the parcel' },
  });

  const denied = await call(h, `/api/households/${owner.householdId}/errands/${errand.body.id}`,
    { method: 'DELETE', token: outsider.token });
  assert.equal(denied.status, 404);

  const list = await call<{ errands: unknown[] }>(
    h, `/api/households/${owner.householdId}/errands`, { token: owner.token });
  assert.equal(list.body.errands.length, 1);
});

/* ============================================================== reminders */

test('a reminder can be deleted', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const reminder = await call<{ id: string }>(h, `/api/households/${owner.householdId}/reminders`, {
    method: 'POST', token: owner.token, body: { title: 'Test reminder', dueAt: '2026-09-09T09:00' },
  });
  assert.equal(reminder.status, 201);

  const deleted = await call(h, `/api/households/${owner.householdId}/reminders/${reminder.body.id}`,
    { method: 'DELETE', token: owner.token });
  assert.equal(deleted.status, 204);

  const list = await call<{ reminders: unknown[] }>(
    h, `/api/households/${owner.householdId}/reminders`, { token: owner.token });
  assert.deepEqual(list.body.reminders, []);
});

test('a member of another household cannot delete a reminder', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  const outsider = await registerOwner(h);

  const reminder = await call<{ id: string }>(h, `/api/households/${owner.householdId}/reminders`, {
    method: 'POST', token: owner.token, body: { title: 'Test reminder', dueAt: '2026-09-09T09:00' },
  });

  const denied = await call(h, `/api/households/${owner.householdId}/reminders/${reminder.body.id}`,
    { method: 'DELETE', token: outsider.token });
  assert.equal(denied.status, 404);

  const list = await call<{ reminders: unknown[] }>(
    h, `/api/households/${owner.householdId}/reminders`, { token: owner.token });
  assert.equal(list.body.reminders.length, 1);
});

/* ================================================================ members */

test('removing a member deactivates them, and their access stops', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  const teen = await joinHousehold(h, owner, 'teen');

  assert.equal((await call(h, `/api/households/${owner.householdId}`, { token: teen.token })).status, 200);

  const removed = await call<{ outcome: string; member: { active: boolean } }>(
    h, `/api/households/${owner.householdId}/members/${teen.memberId}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.outcome, 'deactivated');
  assert.equal(removed.body.member.active, false);

  // The row stays — a deactivated member is still the person on last month's
  // events — but nothing they hold works any more.
  const members = await call<Array<{ id: string; active: boolean }>>(
    h, `/api/households/${owner.householdId}/members`, { token: owner.token });
  assert.equal(members.body.find((m) => m.id === teen.memberId)?.active, false);

  // 404, not 403: `resolveActor` refuses an inactive membership outright, so a
  // removed person cannot even confirm the household is still there. That is
  // the same answer a total stranger gets, which is the point.
  const afterwards = await call(h, `/api/households/${owner.householdId}/shopping`,
    { method: 'POST', token: teen.token, body: { name: 'Anything' } });
  assert.equal(afterwards.status, 404, 'a removed member could still write to the household');
});

test('the last owner cannot remove themselves and lock the household out', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const refused = await call<{ error: { code: string } }>(
    h, `/api/households/${owner.householdId}/members/${owner.memberId}`,
    { method: 'DELETE', token: owner.token },
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'last_owner');
});

test('a member of another household cannot remove a member', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  const outsider = await registerOwner(h);
  const teen = await joinHousehold(h, owner, 'teen');

  const denied = await call(h, `/api/households/${owner.householdId}/members/${teen.memberId}`,
    { method: 'DELETE', token: outsider.token });
  assert.equal(denied.status, 404);

  const members = await call<Array<{ id: string; active: boolean }>>(
    h, `/api/households/${owner.householdId}/members`, { token: owner.token });
  assert.equal(members.body.find((m) => m.id === teen.memberId)?.active, true);
});

/* ============================================================ invitations */

test('a pending invitation can be listed and revoked, and the token stops working', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const invitation = await call<{ token: string }>(
    h, `/api/households/${owner.householdId}/invitations`,
    { method: 'POST', token: owner.token, body: { role: 'adult', email: 'aunt@example.com' } },
  );
  assert.equal(invitation.status, 201);

  const listed = await call<{ invitations: Array<{ id: string; role: string; email: string | null }> }>(
    h, `/api/households/${owner.householdId}/invitations`, { token: owner.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.invitations.length, 1);
  assert.equal(listed.body.invitations[0]?.role, 'adult');
  assert.equal(listed.body.invitations[0]?.email, 'aunt@example.com');
  // The secret half must never be reachable through a list.
  assert.ok(!JSON.stringify(listed.body).includes(invitation.body.token));

  const revoked = await call(
    h, `/api/households/${owner.householdId}/invitations/${listed.body.invitations[0]!.id}`,
    { method: 'DELETE', token: owner.token });
  assert.equal(revoked.status, 204);

  const preview = await call(h, `/api/invitations/${invitation.body.token}`);
  assert.equal(preview.status, 404, 'a revoked invitation still let someone in');

  const empty = await call<{ invitations: unknown[] }>(
    h, `/api/households/${owner.householdId}/invitations`, { token: owner.token });
  assert.deepEqual(empty.body.invitations, []);
});

test('an accepted invitation is not revocable — it is the record of how someone joined', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  await joinHousehold(h, owner, 'adult');

  const all = await call<{ invitations: Array<{ id: string }> }>(
    h, `/api/households/${owner.householdId}/invitations`, { token: owner.token });
  // Accepted invitations are not pending, so the list is empty and the id has
  // to come from the database; the point is what the endpoint does with it.
  assert.deepEqual(all.body.invitations, []);

  const { rows } = await h.db.query<{ id: string }>(
    `select id from invitation where household_id = $1`, [owner.householdId]);
  const refused = await call<{ error: { code: string } }>(
    h, `/api/households/${owner.householdId}/invitations/${rows[0]!.id}`,
    { method: 'DELETE', token: owner.token });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'accepted');
});

test('a member of another household cannot list or revoke invitations', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  const outsider = await registerOwner(h);

  await call(h, `/api/households/${owner.householdId}/invitations`,
    { method: 'POST', token: owner.token, body: { role: 'adult' } });
  const listed = await call<{ invitations: Array<{ id: string }> }>(
    h, `/api/households/${owner.householdId}/invitations`, { token: owner.token });

  assert.equal(
    (await call(h, `/api/households/${owner.householdId}/invitations`, { token: outsider.token })).status,
    404);
  assert.equal(
    (await call(h, `/api/households/${owner.householdId}/invitations/${listed.body.invitations[0]!.id}`,
      { method: 'DELETE', token: outsider.token })).status,
    404);

  const survived = await call<{ invitations: unknown[] }>(
    h, `/api/households/${owner.householdId}/invitations`, { token: owner.token });
  assert.equal(survived.body.invitations.length, 1);
});

test('a teen cannot see who has been invited', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  const teen = await joinHousehold(h, owner, 'teen');

  const denied = await call(h, `/api/households/${owner.householdId}/invitations`, { token: teen.token });
  assert.equal(denied.status, 403);
});

/* ========================================================== notifications */

test('marking a notification read works and is idempotent', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  // A reminder that is already overdue, so the refresh has a real fact to
  // draft from rather than a fixture inserted behind the API's back.
  const reminder = await call<{ id: string }>(h, `/api/households/${owner.householdId}/reminders`, {
    method: 'POST', token: owner.token, body: { title: 'Overdue thing', dueAt: '2026-09-06T09:00' },
  });
  assert.equal(reminder.status, 201);

  const refreshed = await call<{ created: number }>(
    h, `/api/households/${owner.householdId}/notifications/refresh`,
    { method: 'POST', token: owner.token });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.created >= 1);

  const unread = await call<{ notifications: Array<{ id: string }> }>(
    h, `/api/households/${owner.householdId}/notifications`, { token: owner.token });
  assert.equal(unread.body.notifications.length, 1);
  const notificationId = unread.body.notifications[0]!.id;

  const read = await call(h, `/api/households/${owner.householdId}/notifications/${notificationId}/read`,
    { method: 'POST', token: owner.token });
  assert.equal(read.status, 204);

  const after = await call<{ notifications: unknown[] }>(
    h, `/api/households/${owner.householdId}/notifications`, { token: owner.token });
  assert.deepEqual(after.body.notifications, [], 'a read notification came back unread');

  // Reading it twice must not fail — a double tap is not an error — and the
  // regenerate cycle must not resurrect it.
  assert.equal(
    (await call(h, `/api/households/${owner.householdId}/notifications/${notificationId}/read`,
      { method: 'POST', token: owner.token })).status, 204);
  await call(h, `/api/households/${owner.householdId}/notifications/refresh`,
    { method: 'POST', token: owner.token });
  const stillRead = await call<{ notifications: unknown[] }>(
    h, `/api/households/${owner.householdId}/notifications`, { token: owner.token });
  assert.deepEqual(stillRead.body.notifications, []);
});

test('a member of another household cannot mark a notification read', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);
  const outsider = await registerOwner(h);

  await call(h, `/api/households/${owner.householdId}/reminders`, {
    method: 'POST', token: owner.token, body: { title: 'Overdue thing', dueAt: '2026-09-06T09:00' },
  });
  await call(h, `/api/households/${owner.householdId}/notifications/refresh`,
    { method: 'POST', token: owner.token });
  const unread = await call<{ notifications: Array<{ id: string }> }>(
    h, `/api/households/${owner.householdId}/notifications`, { token: owner.token });
  const notificationId = unread.body.notifications[0]!.id;

  const denied = await call(
    h, `/api/households/${owner.householdId}/notifications/${notificationId}/read`,
    { method: 'POST', token: outsider.token });
  assert.equal(denied.status, 404);

  const still = await call<{ notifications: unknown[] }>(
    h, `/api/households/${owner.householdId}/notifications`, { token: owner.token });
  assert.equal(still.body.notifications.length, 1, 'a stranger marked this household\'s alert read');
});
