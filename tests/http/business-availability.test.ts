import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, joinHousehold, registerOwner, startHarness, type Agent, type Harness } from './harness.ts';

let h: Harness;
let owner: Agent;
let employeeId: string;

before(async () => {
  h = await startHarness({ now: '2026-09-07T12:00:00.000Z' });
  owner = await registerOwner(h, { timezone: 'America/Chicago' });

  const business = await call(h, `/api/households/${owner.householdId}/business`, {
    method: 'POST', token: owner.token,
    body: { name: 'Shia Baby', timezone: 'America/Chicago', taxSetAsideRate: 0.2 },
  });
  assert.equal(business.status, 201);

  const employee = await call<{ id: string }>(h, `/api/households/${owner.householdId}/business/employees`, {
    method: 'POST', token: owner.token, body: { displayName: 'Maria', hourlyRateCents: 1600 },
  });
  assert.equal(employee.status, 201);
  employeeId = employee.body.id;
});

after(async () => { await h.close(); });

test('owner can persist and read weekly availability', async () => {
  const saved = await call(h, `/api/households/${owner.householdId}/business/availability`, {
    method: 'POST', token: owner.token,
    body: { employeeId, weekday: 'TH', startMinute: 9 * 60, endMinute: 17 * 60, available: true, preferredWeeklyHours: 32 },
  });
  assert.equal(saved.status, 201);

  const list = await call<{ availability: Array<{ employeeId: string; weekday: string; preferredWeeklyHours?: number }> }>(
    h, `/api/households/${owner.householdId}/business/availability`, { token: owner.token },
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.availability.length, 1);
  assert.equal(list.body.availability[0]?.employeeId, employeeId);
  assert.equal(list.body.availability[0]?.weekday, 'TH');
  assert.equal(list.body.availability[0]?.preferredWeeklyHours, 32);
});

test('owner can record time off and it returns through the same staffing resource', async () => {
  const saved = await call(h, `/api/households/${owner.householdId}/business/time-off`, {
    method: 'POST', token: owner.token,
    body: { employeeId, startsAt: '2026-09-10T09:00', endsAt: '2026-09-10T17:00', reason: 'Appointment' },
  });
  assert.equal(saved.status, 201);

  const list = await call<{ timeOff: Array<{ employeeId: string; status: string; reason?: string }> }>(
    h, `/api/households/${owner.householdId}/business/availability`, { token: owner.token },
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.timeOff.length, 1);
  assert.equal(list.body.timeOff[0]?.employeeId, employeeId);
  assert.equal(list.body.timeOff[0]?.status, 'requested');
  assert.equal(list.body.timeOff[0]?.reason, 'Appointment');
});

test('invalid availability is rejected instead of normalized silently', async () => {
  const bad = await call(h, `/api/households/${owner.householdId}/business/availability`, {
    method: 'POST', token: owner.token,
    body: { employeeId, weekday: 'TH', startMinute: 1020, endMinute: 540, available: true },
  });
  assert.equal(bad.status, 422);
});

test('a viewer cannot change employee availability', async () => {
  const viewer = await joinHousehold(h, owner, 'viewer');
  const denied = await call(h, `/api/households/${owner.householdId}/business/availability`, {
    method: 'POST', token: viewer.token,
    body: { employeeId, weekday: 'FR', startMinute: 540, endMinute: 1020, available: true },
  });
  assert.equal(denied.status, 403);
});
