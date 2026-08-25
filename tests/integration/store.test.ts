/**
 * PHASE D — store integration.
 *
 * The unit tests prove each engine works on hand-built fixtures. This proves
 * the engines work on data that came out of the actual database, through the
 * actual repository, with the actual seed — which is where shape mismatches
 * (a JSON recurrence rule that round-trips wrong, a null that should be
 * undefined) surface.
 *
 * Imports SqliteRepository directly rather than lib/db/index.ts, because that
 * module is marked `server-only` and belongs to Next's runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteRepository } from '../../lib/db/sqlite.ts';
import { seed, HOUSEHOLD_ID, BUSINESS_ID, MEMBERS } from '../../lib/db/seed.ts';
import { expandOccurrences } from '../../domains/scheduling/recurrence.ts';
import { detectConflicts } from '../../domains/scheduling/conflicts.ts';
import { authorize } from '../../domains/household/permissions.ts';
import type { Occurrence } from '../../lib/contracts/index.ts';

const WEEK = { from: '2026-09-07T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' };
const OTHER_HOUSEHOLD = '99999999-9999-4999-8999-999999999999';

function fresh(): SqliteRepository {
  const repo = new SqliteRepository(':memory:');
  seed(repo);
  return repo;
}

function weekOccurrences(repo: SqliteRepository): Occurrence[] {
  const participants = repo.listParticipants(HOUSEHOLD_ID);
  const byEvent = new Map<string, string[]>();
  for (const p of participants) {
    const list = byEvent.get(p.eventId) ?? [];
    list.push(p.memberId);
    byEvent.set(p.eventId, list);
  }
  return repo
    .listEvents(HOUSEHOLD_ID)
    .flatMap((e) => expandOccurrences(e, WEEK, { participantIds: byEvent.get(e.id) ?? [] }));
}

test('the seed produces a household that can actually be read back', () => {
  const repo = fresh();
  const household = repo.getHousehold(HOUSEHOLD_ID);
  assert.ok(household, 'household should exist');
  assert.equal(household.name, 'The Michel Household');

  const members = repo.listMembers(HOUSEHOLD_ID);
  assert.equal(members.length, 5);
  assert.ok(members.some((m) => m.role === 'owner'));
  assert.ok(members.some((m) => m.role === 'child' && m.userId === null), 'Noor is a managed profile with no login');
});

test('a recurrence rule survives the JSON round-trip through SQLite', () => {
  const repo = fresh();
  const practice = repo.listEvents(HOUSEHOLD_ID).find((e) => e.id === 'evt-practice');
  assert.ok(practice, 'practice event should exist');
  assert.ok(practice.recurrence, 'recurrence should not be lost in storage');
  assert.equal(practice.recurrence.freq, 'WEEKLY');
  assert.deepEqual(practice.recurrence.byWeekday, ['MO', 'WE', 'FR']);

  // And it still expands — the stored shape is one the engine accepts.
  const occ = expandOccurrences(practice, WEEK, {});
  assert.equal(occ.length, 3, 'Mon/Wed/Fri in a one-week window');
});

test('stored events feed the conflict engine and surface the seeded collision', () => {
  const repo = fresh();
  const occurrences = weekOccurrences(repo);
  const participants = repo.listParticipants(HOUSEHOLD_ID);

  const conflicts = detectConflicts({
    householdId: HOUSEHOLD_ID,
    occurrences,
    participants,
    shifts: repo.listShifts(BUSINESS_ID),
    minorMemberIds: [MEMBERS.noor],
  });

  // Wednesday: practice 4:00 and the dentist 4:30, with Michel responsible for both.
  const wednesday = conflicts.filter((c) => c.window.startsAt.startsWith('2026-09-09'));
  assert.ok(wednesday.length > 0, 'the seeded Wednesday collision must be detected');
  assert.ok(
    wednesday.some((c) => c.memberIds.includes(MEMBERS.michel)),
    'Michel cannot be at the fields and the dentist at once',
  );
});

test('conflict ids are stable across two independently seeded databases', () => {
  const a = fresh();
  const b = fresh();
  const input = (repo: SqliteRepository) => ({
    householdId: HOUSEHOLD_ID,
    occurrences: weekOccurrences(repo),
    participants: repo.listParticipants(HOUSEHOLD_ID),
  });
  assert.deepEqual(
    detectConflicts(input(a)).map((c) => c.id),
    detectConflicts(input(b)).map((c) => c.id),
    'ids must depend on the schedule, not on which process built it',
  );
});

test('every read refuses a household it was not given', () => {
  const repo = fresh();
  assert.equal(repo.getHousehold(OTHER_HOUSEHOLD), null);
  assert.deepEqual(repo.listMembers(OTHER_HOUSEHOLD), []);
  assert.deepEqual(repo.listEvents(OTHER_HOUSEHOLD), []);
  assert.deepEqual(repo.listReminders(OTHER_HOUSEHOLD), []);
  assert.deepEqual(repo.listShoppingItems(OTHER_HOUSEHOLD), []);
  assert.deepEqual(repo.listParticipants(OTHER_HOUSEHOLD), []);
  assert.equal(repo.getBusiness(OTHER_HOUSEHOLD), null);
});

test('a write scoped to the wrong household changes nothing', () => {
  const repo = fresh();
  const before = repo.listEvents(HOUSEHOLD_ID).find((e) => e.id === 'evt-dentist');
  assert.ok(before);

  // Same event id, wrong tenant: must be a no-op, not a cross-tenant edit.
  const updated = repo.updateEvent(OTHER_HOUSEHOLD, 'evt-dentist', { title: 'Hijacked' });
  assert.equal(updated, null);
  assert.equal(repo.cancelEvent(OTHER_HOUSEHOLD, 'evt-dentist'), false);

  const after = repo.listEvents(HOUSEHOLD_ID).find((e) => e.id === 'evt-dentist');
  assert.equal(after?.title, before.title, 'the real row must be untouched');
  assert.equal(after?.status, 'confirmed');
});

test('inserting an event ignores a tenant supplied in the payload', () => {
  const repo = fresh();
  const inserted = repo.insertEvent(
    HOUSEHOLD_ID,
    {
      id: 'evt-injected',
      householdId: OTHER_HOUSEHOLD, // hostile: payload claims another tenant
      scheduleId: 'sch-general',
      domain: 'general',
      title: 'Should belong to the caller scope',
      startsAt: '2026-09-10T15:00:00.000Z',
      endsAt: '2026-09-10T16:00:00.000Z',
      allDay: false,
      timezone: 'America/Chicago',
      status: 'confirmed',
      createdBy: MEMBERS.michel,
    },
    [],
  );

  assert.equal(inserted.householdId, HOUSEHOLD_ID, 'tenant comes from the caller, never the payload');
  assert.ok(repo.listEvents(HOUSEHOLD_ID).some((e) => e.id === 'evt-injected'));
  assert.deepEqual(repo.listEvents(OTHER_HOUSEHOLD), []);
});

test('the permission kernel agrees with the seeded roles', () => {
  const repo = fresh();
  const members = repo.listMembers(HOUSEHOLD_ID);
  const owner = members.find((m) => m.role === 'owner');
  const employee = members.find((m) => m.role === 'employee');
  assert.ok(owner && employee);

  assert.equal(authorize({ member: owner, permission: 'finance.manage', householdId: HOUSEHOLD_ID }).allowed, true);
  assert.equal(authorize({ member: employee, permission: 'event.read', householdId: HOUSEHOLD_ID }).allowed, false);
  assert.equal(authorize({ member: owner, permission: 'event.read', householdId: OTHER_HOUSEHOLD }).allowed, false);
});

test('business data is present and shaped for the screens that need it', () => {
  const repo = fresh();
  const business = repo.getBusiness(HOUSEHOLD_ID);
  assert.ok(business);
  assert.equal(business.name, 'Shia Baby');

  const products = repo.listProducts(BUSINESS_ID);
  assert.ok(products.length >= 5);
  assert.ok(
    products.some((p) => p.quantityOnHand <= p.reorderPoint),
    'the seed must include a low-stock product so the alert path is exercised',
  );

  const shifts = repo.listShifts(BUSINESS_ID);
  assert.ok(shifts.some((s) => s.status === 'published' && s.employeeId === null), 'an unstaffed published shift');
  assert.ok(repo.listSales(BUSINESS_ID).length > 0);
  assert.ok(repo.listExpenses(BUSINESS_ID).length > 0);
});

test('inventory adjustment persists and never goes negative', () => {
  const repo = fresh();
  const before = repo.listProducts(BUSINESS_ID).find((p) => p.sku === 'SB-BOW-002');
  assert.ok(before);

  const after = repo.adjustInventory(BUSINESS_ID, before.id, 10);
  assert.equal(after?.quantityOnHand, before.quantityOnHand + 10);

  const floored = repo.adjustInventory(BUSINESS_ID, before.id, -9999);
  assert.equal(floored?.quantityOnHand, 0, 'stock clamps at zero rather than going negative');
});

test('audit entries are readable back in recency order', () => {
  const repo = fresh();
  repo.appendAudit({
    id: 'aud-1', householdId: HOUSEHOLD_ID, actorMemberId: MEMBERS.michel,
    action: 'create_event', entity: 'event', entityId: 'evt-x',
    at: '2026-09-08T10:00:00.000Z',
  });
  const log = repo.listAudit(HOUSEHOLD_ID);
  assert.ok(log.length >= 2);
  assert.equal(log[0]?.entityId, 'evt-x', 'newest first');
  assert.deepEqual(repo.listAudit(OTHER_HOUSEHOLD), []);
});
