/**
 * PHASE D — INTEGRATION.
 *
 * Owner: Lead Orchestrator. Four agents built four modules in parallel against
 * one frozen contract and never imported each other's code. This test is the
 * first time those modules meet. It walks the pipeline from ARCHITECTURE.md §3
 * end to end:
 *
 *   user input -> structured proposal -> schema validation -> permission
 *   validation -> conflict analysis -> confirmation -> deterministic command
 *
 * Unit tests prove each agent kept its own promise. This proves the promises
 * fit together — which is a different question, and the one that usually fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authorize, permissionOracle } from '../../domains/household/permissions.ts';
import { expandOccurrences } from '../../domains/scheduling/recurrence.ts';
import { detectConflicts, explainConflict } from '../../domains/scheduling/conflicts.ts';
import { validateAction } from '../../domains/ai/validator.ts';
import { classifyInboxItem } from '../../domains/ai/inbox.ts';
import { buildMorningBrief, summarizeBrief } from '../../domains/ai/brief.ts';
import { addShoppingItem } from '../../domains/personal/lists.ts';
import { analyzeSchedule } from '../../domains/shia-baby/staffing.ts';
import { lowStockAlerts, recordMovement, recordSale } from '../../domains/shia-baby/ledger.ts';
import { SearchIndex, search } from '../../domains/platform/search.ts';
import {
  conflictsDetected,
  lowStock,
  materializeNotification,
  mergeNotifications,
} from '../../domains/platform/notifications.ts';
import type { Employee, EventRecord, Member, Occurrence } from '../../lib/contracts/index.ts';

/* ---------------------------------------------------------- a household */

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const OTHER_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';

const MOM: Member = {
  id: 'm-mom', householdId: HOUSEHOLD, userId: 'u-mom', displayName: 'Michel',
  role: 'owner', color: 'brand.primary', active: true,
};
const TEEN: Member = {
  id: 'm-teen', householdId: HOUSEHOLD, userId: 'u-teen', displayName: 'Ana',
  role: 'teen', color: 'brand.teal', active: true,
};
const CHILD: Member = {
  id: 'm-kid', householdId: HOUSEHOLD, userId: null, displayName: 'Noor',
  role: 'child', color: 'brand.coral', active: true,
};
const SHOP_EMPLOYEE: Member = {
  id: 'm-emp', householdId: HOUSEHOLD, userId: 'u-emp', displayName: 'Riley',
  role: 'employee', color: 'brand.slate', active: true,
};

/** Soccer practice, Mon/Wed/Fri 4–5pm, all through the autumn. */
const PRACTICE: EventRecord = {
  id: 'e-practice',
  householdId: HOUSEHOLD,
  scheduleId: 's-practice',
  domain: 'practice',
  title: 'Soccer practice',
  location: 'Riverside fields',
  startsAt: '2026-09-07T21:00:00.000Z', // 4pm America/Chicago
  endsAt: '2026-09-07T22:00:00.000Z',
  allDay: false,
  timezone: 'America/Chicago',
  status: 'confirmed',
  createdBy: MOM.id,
  recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'WE', 'FR'], until: '2026-11-27' },
};

/** A dentist appointment dropped straight into the middle of a Wednesday practice. */
const DENTIST: EventRecord = {
  id: 'e-dentist',
  householdId: HOUSEHOLD,
  scheduleId: 's-appointments',
  domain: 'appointments',
  title: 'Dentist — Noor',
  location: 'Dr. Vance',
  startsAt: '2026-09-09T21:30:00.000Z',
  endsAt: '2026-09-09T22:30:00.000Z',
  allDay: false,
  timezone: 'America/Chicago',
  status: 'confirmed',
  createdBy: MOM.id,
};

const WEEK = { from: '2026-09-07T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' };

/** The instant every Phase D2 walk is anchored to. Injected, never read. */
const NOW = '2026-09-09T13:00:00.000Z';

const BUSINESS = 'b-shia-baby';

/** Riley's other life: the same person, on the shop's payroll. */
const SHOP_STAFF: Employee = {
  id: 'emp-riley',
  businessId: BUSINESS,
  memberId: SHOP_EMPLOYEE.id,
  displayName: 'Riley',
  hourlyRate: 18,
  active: true,
};

function familyWeek(): Occurrence[] {
  return [
    ...expandOccurrences(PRACTICE, WEEK, { participantIds: [TEEN.id, MOM.id] }),
    ...expandOccurrences(DENTIST, WEEK, { participantIds: [CHILD.id, MOM.id] }),
  ];
}

/* ------------------------------------------------------------- the walk */

test('integration: recurrence feeds the conflict engine through the frozen Occurrence shape', () => {
  const occurrences = familyWeek();

  // Mon, Wed, Fri practice + one dentist.
  assert.equal(occurrences.filter((o) => o.eventId === 'e-practice').length, 3);
  assert.equal(occurrences.filter((o) => o.eventId === 'e-dentist').length, 1);

  const conflicts = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences,
    participants: [
      { eventId: 'e-practice', memberId: TEEN.id, role: 'attendee' },
      { eventId: 'e-practice', memberId: MOM.id, role: 'responsible' },
      { eventId: 'e-dentist', memberId: CHILD.id, role: 'attendee' },
      { eventId: 'e-dentist', memberId: MOM.id, role: 'responsible' },
    ],
    minorMemberIds: [CHILD.id],
  });

  // Michel cannot be responsible at the fields and the dentist at the same time.
  const wednesday = conflicts.filter((c) => c.window.startsAt.startsWith('2026-09-09'));
  assert.ok(wednesday.length > 0, 'expected a Wednesday conflict between practice and the dentist');
  assert.ok(
    wednesday.some((c) => c.memberIds.includes(MOM.id) && c.severity === 'blocking'),
    'a double-booked responsible adult must be blocking',
  );

  // The explanation is what a parent actually reads on their phone.
  const sentence = explainConflict(wednesday[0]!);
  assert.ok(sentence.length > 20, 'explanation should be a real sentence');
  assert.ok(!sentence.includes(HOUSEHOLD), 'explanations must not leak raw ids');
});

test('integration: conflict ids are stable across an independent expansion', () => {
  const input = (occ: Occurrence[]) => ({
    householdId: HOUSEHOLD,
    occurrences: occ,
    participants: [
      { eventId: 'e-practice', memberId: MOM.id, role: 'responsible' as const },
      { eventId: 'e-dentist', memberId: MOM.id, role: 'responsible' as const },
    ],
  });

  // Expand the week twice from scratch, detect twice: the ids must match.
  const first = detectConflicts(input(familyWeek()));
  const second = detectConflicts(input(familyWeek()));
  assert.deepEqual(
    first.map((c) => c.id),
    second.map((c) => c.id),
    'conflict ids must be a pure function of the schedule, not of when it was computed',
  );
});

test('integration: the AI validator runs on the real permission kernel', () => {
  // Michel asks for a new event. The oracle is the real authorization matrix,
  // not a stub — the AI layer never gets to invent its own answer.
  const verdict = validateAction(
    {
      type: 'create_event',
      confidence: 0.95,
      payload: {
        scheduleId: 's-appointments',
        title: 'Parent-teacher conference',
        startsAt: '2026-09-15T21:00:00.000Z',
        endsAt: '2026-09-15T22:00:00.000Z',
      },
    },
    {
      householdId: HOUSEHOLD,
      actorMemberId: MOM.id,
      now: '2026-09-01T12:00:00.000Z',
      can: permissionOracle(MOM, HOUSEHOLD),
    },
  );

  assert.notEqual(verdict.decision, 'reject', `owner creating an event should not be rejected: ${JSON.stringify(verdict.errors)}`);
  assert.ok(verdict.command, 'an accepted action must produce a deterministic command');
  assert.equal(verdict.command?.payload.title, 'Parent-teacher conference');
});

test('integration: a child proposing through the AI layer is refused by the permission kernel', () => {
  const verdict = validateAction(
    {
      type: 'create_event',
      confidence: 0.99,
      payload: {
        scheduleId: 's-appointments',
        title: 'Ice cream, every day, forever',
        startsAt: '2026-09-15T21:00:00.000Z',
        endsAt: '2026-09-15T22:00:00.000Z',
      },
    },
    {
      householdId: HOUSEHOLD,
      actorMemberId: CHILD.id,
      now: '2026-09-01T12:00:00.000Z',
      can: permissionOracle(CHILD, HOUSEHOLD),
    },
  );

  assert.equal(verdict.decision, 'reject');
  assert.ok(verdict.errors.some((e) => e.code === 'permission'));
});

test('integration: tenant isolation holds across both the auth kernel and the AI layer', () => {
  // Same denial, reached by two independent paths.
  const direct = authorize({ member: MOM, permission: 'event.read', householdId: OTHER_HOUSEHOLD });
  assert.equal(direct.allowed, false);
  assert.equal(direct.allowed === false ? direct.code : null, 'tenant');

  const viaAi = validateAction(
    {
      type: 'create_event',
      confidence: 0.99,
      payload: {
        householdId: OTHER_HOUSEHOLD,
        scheduleId: 's-x',
        title: 'Reach into the neighbours',
        startsAt: '2026-09-15T21:00:00.000Z',
        endsAt: '2026-09-15T22:00:00.000Z',
      },
    },
    { householdId: HOUSEHOLD, actorMemberId: MOM.id, now: '2026-09-01T12:00:00.000Z', can: permissionOracle(MOM, HOUSEHOLD) },
  );
  assert.equal(viaAi.decision, 'reject');
  assert.ok(viaAi.errors.some((e) => e.code === 'tenant'));
});

test('integration: a shop employee is walled off from the family calendar', () => {
  const readFamily = authorize({ member: SHOP_EMPLOYEE, permission: 'event.read', householdId: HOUSEHOLD });
  assert.equal(readFamily.allowed, false, 'an employee must not be able to read family appointments');

  const scheduleShift = authorize({ member: SHOP_EMPLOYEE, permission: 'employee.schedule', householdId: HOUSEHOLD });
  assert.equal(scheduleShift.allowed, true, 'but they still work here');
});

test('integration: a proposal the model is unsure about asks before it acts', () => {
  const verdict = validateAction(
    {
      type: 'cancel_event',
      confidence: 0.4,
      payload: { eventId: 'e-practice' },
    },
    { householdId: HOUSEHOLD, actorMemberId: MOM.id, now: '2026-09-01T12:00:00.000Z', can: permissionOracle(MOM, HOUSEHOLD) },
  );

  assert.notEqual(verdict.decision, 'execute', 'a low-confidence destructive action must never execute silently');
  if (verdict.decision === 'confirm') {
    assert.ok((verdict.requiresConfirmationBecause?.length ?? 0) > 0, 'the user deserves a reason for the prompt');
  }
});

test('integration: a teen may schedule, and the schedule they produce still lands in the conflict engine', () => {
  const verdict = validateAction(
    {
      type: 'create_event',
      confidence: 0.9,
      payload: {
        scheduleId: 's-practice',
        title: 'Study group',
        startsAt: '2026-09-09T21:15:00.000Z',
        endsAt: '2026-09-09T22:15:00.000Z',
      },
    },
    { householdId: HOUSEHOLD, actorMemberId: TEEN.id, now: '2026-09-01T12:00:00.000Z', can: permissionOracle(TEEN, HOUSEHOLD) },
  );
  assert.notEqual(verdict.decision, 'reject', `a teen may create events: ${JSON.stringify(verdict.errors)}`);

  // Feed the resulting command straight into the schedule as a real occurrence.
  const studyGroup: Occurrence = {
    eventId: 'e-study',
    seriesId: null,
    occurrenceStart: String(verdict.command?.payload.startsAt),
    occurrenceEnd: String(verdict.command?.payload.endsAt),
    title: String(verdict.command?.payload.title),
    domain: 'school',
    status: 'confirmed',
    participantIds: [TEEN.id],
    isOverride: false,
  };

  const conflicts = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences: [...familyWeek(), studyGroup],
    participants: [
      { eventId: 'e-practice', memberId: TEEN.id, role: 'attendee' },
      { eventId: 'e-study', memberId: TEEN.id, role: 'attendee' },
    ],
  });

  assert.ok(
    conflicts.some((c) => c.memberIds.includes(TEEN.id)),
    'the study group collides with Wednesday practice and the engine should say so',
  );
});

/* ================================================================ PHASE D2 ==
 * The Phase C2 agents join the walk. Five modules that never imported each
 * other now have to meet: the inbox routes text into the validator, the
 * validated command becomes a list row, the row becomes a notification, the
 * notification and the schedule become a morning brief, and the shop's own
 * roster feeds staffing warnings into the same brief.
 * ========================================================================== */

test('integration: a sentence typed into the Inbox reaches a saved shopping item', () => {
  // 1. free text -> proposal (Agent H)
  const classification = classifyInboxItem(
    {
      id: 'inb-1',
      householdId: HOUSEHOLD,
      rawText: 'we need milk',
      capturedBy: MOM.id,
      capturedAt: NOW,
      status: 'unclassified',
    },
    { householdId: HOUSEHOLD, now: NOW, timezone: 'America/Chicago', members: [MOM, TEEN, CHILD] },
  );
  assert.equal(classification.domain, 'shopping');

  // 2. proposal -> verdict (Agent H's validator, on Agent E's kernel)
  const verdict = validateAction(classification.proposal, {
    householdId: HOUSEHOLD,
    actorMemberId: MOM.id,
    now: NOW,
    can: permissionOracle(MOM, HOUSEHOLD),
  });
  assert.notEqual(verdict.decision, 'reject', JSON.stringify(verdict.errors));
  assert.ok(verdict.command);

  // 3. command -> row (Agent I), through the same kernel again
  const saved = addShoppingItem({
    id: 'si-1',
    householdId: HOUSEHOLD,
    actor: MOM,
    name: String(verdict.command.payload['name']),
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.ok === true && saved.value.status, 'needed');
  assert.equal(saved.ok === true && saved.value.name, 'we need milk');
});

test('integration: the inbox cannot route around the permission kernel', () => {
  // The same sentence, from a viewer. The classifier does not know or care who
  // is asking — every gate downstream still holds.
  const viewer: Member = { ...MOM, id: 'm-guest', role: 'viewer' };
  const classification = classifyInboxItem(
    { id: 'inb-2', householdId: HOUSEHOLD, rawText: 'we need milk', capturedBy: viewer.id, capturedAt: NOW, status: 'unclassified' },
    { householdId: HOUSEHOLD, now: NOW, timezone: 'America/Chicago' },
  );

  const saved = addShoppingItem({
    id: 'si-2',
    householdId: HOUSEHOLD,
    actor: viewer,
    name: String(classification.proposal.payload['name'] ?? 'milk'),
  });
  assert.equal(saved.ok, false, 'a read-only guest wrote to the family shopping list');
});

test('integration: a real conflict becomes exactly one notification, however often it is re-detected', () => {
  const conflicts = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences: familyWeek(),
    participants: [
      { eventId: PRACTICE.id, memberId: MOM.id, role: 'responsible' },
      { eventId: DENTIST.id, memberId: MOM.id, role: 'responsible' },
    ],
    memberNames: { [MOM.id]: 'Michel' },
  });
  const real = conflicts.filter((c) => c.severity !== 'info');
  assert.ok(real.length > 0, 'the fixture week is supposed to contain a genuine clash');

  // Agent G's conflicts feed Agent K's notification centre.
  const drafts = conflictsDetected(real, HOUSEHOLD, NOW);
  assert.ok(drafts.length > 0);

  const first = mergeNotifications([], drafts);
  const persisted = first.created.map((draft, i) => materializeNotification(`n-${i}`, draft));

  // Re-detect from scratch, as a page load would, and merge again.
  const redetected = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences: familyWeek(),
    participants: [
      { eventId: PRACTICE.id, memberId: MOM.id, role: 'responsible' },
      { eventId: DENTIST.id, memberId: MOM.id, role: 'responsible' },
    ],
    memberNames: { [MOM.id]: 'Michel' },
  }).filter((c) => c.severity !== 'info');

  const second = mergeNotifications(persisted, conflictsDetected(redetected, HOUSEHOLD, NOW));
  assert.deepEqual(second.created, [], 'the same conflict notified the family twice');
  assert.equal(second.unchanged.length, persisted.length);
});

test('integration: the morning brief assembles what four other agents produced', () => {
  const occurrences = familyWeek();
  const conflicts = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences,
    participants: [
      { eventId: PRACTICE.id, memberId: MOM.id, role: 'responsible' },
      { eventId: DENTIST.id, memberId: MOM.id, role: 'responsible' },
    ],
    memberNames: { [MOM.id]: 'Michel' },
  });

  // Agent J1's warnings, from the shop's own roster.
  const analysis = analyzeSchedule({
    businessId: BUSINESS,
    employees: [SHOP_STAFF],
    shifts: [
      {
        id: 'sh-1',
        businessId: BUSINESS,
        employeeId: SHOP_STAFF.id,
        startsAt: '2026-09-09T15:00:00.000Z',
        endsAt: '2026-09-09T19:00:00.000Z',
        status: 'published',
      },
    ],
    window: { from: '2026-09-07T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' },
  });
  assert.ok(analysis.warnings.length > 0, 'a lone four-hour shift cannot cover a trading day');

  const brief = buildMorningBrief({
    householdId: HOUSEHOLD,
    now: '2026-09-09T13:00:00.000Z', // Wednesday, 8am America/Chicago
    timezone: 'America/Chicago',
    memberName: 'Michel',
    occurrences,
    conflicts,
    staffingWarnings: analysis.warnings.map((w) => w.message),
    shoppingItems: [
      { id: 'si-1', householdId: HOUSEHOLD, listName: 'Household', name: 'Milk', quantity: 1, status: 'needed' },
    ],
  });

  assert.equal(brief.greeting, 'Good morning, Michel.');
  assert.equal(brief.date, '2026-09-09');
  assert.ok(brief.today.length >= 2, 'Wednesday has both the practice and the dentist on it');
  assert.ok(brief.conflicts.length > 0, 'the clash the conflict engine found reaches the brief');
  assert.equal(brief.conflicts[0]!.severity, 'blocking', 'the worst one leads');
  assert.ok(brief.staffingWarnings.length > 0);
  assert.equal(brief.shoppingCount, 1);

  // The brief must be readable by a person, not a dump of ids.
  const summary = summarizeBrief(brief);
  assert.match(summary, /event/);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/.test(summary), false, `ids leaked into the summary: ${summary}`);
});

test('integration: the shop employee is walled off from the family in search too', () => {
  const occurrences = familyWeek();
  const index = SearchIndex.build([
    ...occurrences.map((o) => ({
      entity: 'event' as const,
      id: `${o.eventId}@${o.occurrenceStart}`,
      householdId: HOUSEHOLD,
      title: o.title,
      domain: o.domain,
      at: o.occurrenceStart,
    })),
    {
      entity: 'employee' as const,
      id: SHOP_STAFF.id,
      householdId: HOUSEHOLD,
      title: SHOP_STAFF.displayName,
      businessId: BUSINESS,
    },
  ]);

  // The owner finds the dentist; the employee does not — and the employee can
  // still find the roster they are legitimately part of.
  assert.ok(search(index, 'dentist', MOM, HOUSEHOLD).length > 0);
  assert.deepEqual(search(index, 'dentist', SHOP_EMPLOYEE, HOUSEHOLD, { businessId: BUSINESS }), []);
  assert.ok(search(index, 'riley', SHOP_EMPLOYEE, HOUSEHOLD, { businessId: BUSINESS }).length > 0);
});

test('integration: a shift and an event collide, and the same fact reaches the shop and the family', () => {
  // Riley works the register while their own child's practice runs.
  const shift = {
    id: 'sh-clash',
    businessId: BUSINESS,
    employeeId: SHOP_STAFF.id,
    startsAt: '2026-09-09T20:30:00.000Z',
    endsAt: '2026-09-09T23:00:00.000Z',
    status: 'published' as const,
  };

  // Agent G sees it as a `work` conflict on the family side…
  const conflicts = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences: familyWeek(),
    participants: [{ eventId: PRACTICE.id, memberId: SHOP_EMPLOYEE.id, role: 'responsible' }],
    shifts: [shift],
    employeeMemberIds: { [SHOP_STAFF.id]: SHOP_EMPLOYEE.id },
    memberNames: { [SHOP_EMPLOYEE.id]: 'Riley' },
  });
  const work = conflicts.find((c) => c.kind === 'work');
  assert.ok(work, 'a shift over a practice the same adult is responsible for is a work conflict');

  // …and CR-004 means the shop side can tell which ref is the shift.
  const shiftRefs = work.occurrenceRefs.filter((r) => r.kind === 'shift');
  assert.deepEqual(shiftRefs.map((r) => r.id), ['sh-clash']);

  // Agent J1 reports the same fact to the manager, from the family obligation
  // the conflict engine identified — one source, two audiences.
  const analysis = analyzeSchedule({
    businessId: BUSINESS,
    employees: [SHOP_STAFF],
    shifts: [shift],
    window: { from: '2026-09-07T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' },
    familyObligations: [
      {
        employeeId: SHOP_STAFF.id,
        startsAt: '2026-09-09T21:00:00.000Z',
        endsAt: '2026-09-09T22:00:00.000Z',
        title: 'Soccer practice',
      },
    ],
  });
  assert.ok(analysis.warnings.some((w) => w.code === 'family_conflict'));
});

test('integration: a sale moves stock, and running out reaches the family as one notification', () => {
  const teddy = {
    id: 'p-bear',
    businessId: BUSINESS,
    sku: 'BEAR-01',
    name: 'Classic teddy',
    quantityOnHand: 2,
    reorderPoint: 4,
    unitCost: 500,
    unitPrice: 1200,
  };

  const sale = recordSale({
    id: 'sale-1',
    businessId: BUSINESS,
    actor: MOM,
    householdId: HOUSEHOLD,
    at: NOW,
    items: [{ productId: teddy.id, quantity: 2, unitPriceCents: 1200 }],
  });
  assert.equal(sale.ok, true, JSON.stringify(sale));
  assert.equal(sale.ok === true && sale.value.totalCents, 2400);

  // The sale's movement is applied through the same ledger that guards stock.
  const movement = sale.ok === true ? sale.value.movements[0]! : null;
  assert.ok(movement);
  const applied = recordMovement({
    id: 'mv-1',
    businessId: BUSINESS,
    product: teddy,
    actor: MOM,
    householdId: HOUSEHOLD,
    kind: movement.kind,
    quantityDelta: movement.quantityDelta,
    at: movement.at,
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const sold = applied.ok === true ? applied.value.product : teddy;
  assert.equal(sold.quantityOnHand, 0);

  // Agent J2's alert becomes Agent K's notification, once.
  const alerts = lowStockAlerts(BUSINESS, [sold]);
  assert.deepEqual(alerts.map((a) => a.severity), ['blocking']);

  const first = mergeNotifications([], lowStock(alerts, HOUSEHOLD, NOW));
  const persisted = first.created.map((d, i) => materializeNotification(`n-low-${i}`, d));
  const second = mergeNotifications(persisted, lowStock(alerts, HOUSEHOLD, '2026-09-10T13:00:00.000Z'));
  assert.deepEqual(second.created, [], 'the same empty shelf notified twice');
});

test('integration: the whole walk stays deterministic across two independent runs', () => {
  const run = () => {
    const occurrences = familyWeek();
    const conflicts = detectConflicts({
      householdId: HOUSEHOLD,
      occurrences,
      participants: [
        { eventId: PRACTICE.id, memberId: MOM.id, role: 'responsible' },
        { eventId: DENTIST.id, memberId: MOM.id, role: 'responsible' },
      ],
      memberNames: { [MOM.id]: 'Michel' },
    });
    return buildMorningBrief({
      householdId: HOUSEHOLD,
      now: '2026-09-09T13:00:00.000Z',
      timezone: 'America/Chicago',
      occurrences,
      conflicts,
    });
  };
  assert.deepEqual(run(), run());
});
