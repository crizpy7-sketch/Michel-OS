/**
 * Unit tests for personal organization (Agent I, domains/personal/lists.ts).
 *
 * The three lists share one implementation, so the tests deliberately attack
 * the shared machinery from all three directions: authorization, illegal
 * transitions, and the deterministic grouping the AI layer consumes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SHOPPING_LIST,
  UNGROUPED_STORE,
  addShoppingItem,
  clusterErrandsByLocation,
  completeReminder,
  createErrand,
  createReminder,
  dismissReminder,
  dueReminders,
  groupByStore,
  setErrandStatus,
  setShoppingStatus,
  snoozeReminder,
  wakeSnoozed,
} from '../../domains/personal/lists.ts';
import type {
  Errand,
  Member,
  Reminder,
  Role,
  ShoppingItem,
  UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- fixtures */

const H1: UUID = 'hh-michel';
const H2: UUID = 'hh-other';

const M_OWNER: UUID = 'm-owner';
const M_ADULT: UUID = 'm-adult';
const M_TEEN: UUID = 'm-teen';
const M_CHILD: UUID = 'm-child';
const M_VIEWER: UUID = 'm-viewer';

function member(id: UUID, role: Role, householdId: UUID = H1): Member {
  return { id, householdId, userId: null, displayName: id, role, color: 'slate', active: true };
}

const owner = member(M_OWNER, 'owner');
const adult = member(M_ADULT, 'adult');
const teen = member(M_TEEN, 'teen');
const child = member(M_CHILD, 'child');
const viewer = member(M_VIEWER, 'viewer');

function shoppingItem(patch: Partial<ShoppingItem> = {}): ShoppingItem {
  return {
    id: 'si-1',
    householdId: H1,
    listName: DEFAULT_SHOPPING_LIST,
    name: 'Milk',
    quantity: 1,
    status: 'needed',
    ...patch,
  };
}

function errand(patch: Partial<Errand> = {}): Errand {
  return { id: 'er-1', householdId: H1, title: 'Return the package', status: 'open', ...patch };
}

function reminder(patch: Partial<Reminder> = {}): Reminder {
  return {
    id: 'rm-1',
    householdId: H1,
    title: 'Call the insurance company',
    dueAt: '2026-08-24T15:00:00.000Z',
    status: 'pending',
    ...patch,
  };
}

const NOW = '2026-08-24T16:00:00.000Z';

function value<T>(result: { ok: true; value: T } | { ok: false; issues: unknown[] }): T {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

function issues(result: { ok: boolean; issues?: unknown[] }): Array<{ code: string; path: string }> {
  assert.equal(result.ok, false, 'expected a rejection');
  return (result as { issues: Array<{ code: string; path: string }> }).issues;
}

/* ------------------------------------------------------------- shopping */

test('shopping: an adult can add an item and it starts as needed', () => {
  const item = value(
    addShoppingItem({ id: 'si-9', householdId: H1, actor: adult, name: '  Whole milk  ', quantity: 2 }),
  );
  assert.equal(item.name, 'Whole milk', 'the name is trimmed');
  assert.equal(item.status, 'needed');
  assert.equal(item.quantity, 2);
  assert.equal(item.listName, DEFAULT_SHOPPING_LIST);
  assert.equal(Object.hasOwn(item, 'store'), false, 'an absent store is omitted, not undefined');
});

test('shopping: a viewer cannot add to the list', () => {
  const rejected = addShoppingItem({ id: 'si-9', householdId: H1, actor: viewer, name: 'Milk' });
  assert.deepEqual(issues(rejected).map((i) => i.code), ['permission']);
});

test('shopping: a member of another household is refused as a tenant violation', () => {
  const intruder = member('m-intruder', 'owner', H2);
  const rejected = addShoppingItem({ id: 'si-9', householdId: H1, actor: intruder, name: 'Milk' });
  assert.deepEqual(issues(rejected).map((i) => i.code), ['tenant']);
});

test('shopping: a blank name and a fractional quantity are both rejected, together', () => {
  const rejected = addShoppingItem({
    id: 'si-9',
    householdId: H1,
    actor: adult,
    name: '   ',
    quantity: 1.5,
  });
  const paths = issues(rejected).map((i) => i.path).sort();
  assert.deepEqual(paths, ['name', 'quantity'], 'every problem is reported in one pass');
});

test('shopping: an item can go back on the list after being bought, but removal is final', () => {
  const bought = value(setShoppingStatus(shoppingItem(), 'purchased', adult));
  assert.equal(bought.status, 'purchased');

  const wrongSize = value(setShoppingStatus(bought, 'needed', adult));
  assert.equal(wrongSize.status, 'needed');

  const removed = value(setShoppingStatus(wrongSize, 'removed', adult));
  const resurrect = setShoppingStatus(removed, 'needed', adult);
  assert.deepEqual(issues(resurrect).map((i) => i.code), ['logic']);
});

test('shopping: marking an already-purchased item purchased is an error, not a silent no-op', () => {
  const bought = value(setShoppingStatus(shoppingItem(), 'purchased', adult));
  const again = setShoppingStatus(bought, 'purchased', adult);
  assert.equal(again.ok, false, 'a double-tap must not report success');
});

test('shopping: mutations never modify the row handed in', () => {
  const original = shoppingItem();
  const snapshot = JSON.stringify(original);
  value(setShoppingStatus(original, 'purchased', adult));
  assert.equal(JSON.stringify(original), snapshot, 'the input row was mutated in place');
});

test('groupByStore: groups are deterministic regardless of input order', () => {
  const items: ShoppingItem[] = [
    shoppingItem({ id: 'a', name: 'Bananas', store: 'Aldi' }),
    shoppingItem({ id: 'b', name: 'Nails', store: 'Hardware Depot' }),
    shoppingItem({ id: 'c', name: 'Apples', store: 'aldi  ' }),
    shoppingItem({ id: 'd', name: 'Batteries' }),
  ];

  const forward = groupByStore(items);
  const backward = groupByStore([...items].reverse());
  assert.deepEqual(forward, backward, 'shuffling the list must not reshape the trip');

  assert.deepEqual(forward.map((g) => g.store), ['Aldi', 'Hardware Depot', UNGROUPED_STORE]);
  assert.deepEqual(forward[0]!.items.map((i) => i.name), ['Apples', 'Bananas']);
});

test('groupByStore: purchased and removed items are not part of the trip', () => {
  const groups = groupByStore([
    shoppingItem({ id: 'a', name: 'Milk', store: 'Aldi', status: 'purchased' }),
    shoppingItem({ id: 'b', name: 'Eggs', store: 'Aldi', status: 'removed' }),
    shoppingItem({ id: 'c', name: 'Bread', store: 'Aldi', quantity: 3 }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.items.map((i) => i.name), ['Bread']);
  assert.equal(groups[0]!.totalQuantity, 3, 'the total counts only what is still needed');
});

/* -------------------------------------------------------------- errands */

test('errands: a teen may create one and mark their own done', () => {
  const created = value(
    createErrand({
      id: 'er-9',
      householdId: H1,
      actor: teen,
      title: 'Pharmacy pickup',
      assignedTo: M_TEEN,
      location: 'Walgreens',
    }),
  );
  assert.equal(created.status, 'open');

  const done = value(setErrandStatus(created, 'done', teen));
  assert.equal(done.status, 'done');
});

test('errands: a teen may not close an errand assigned to somebody else', () => {
  const someone_elses = errand({ assignedTo: M_ADULT });
  const rejected = setErrandStatus(someone_elses, 'done', teen);
  assert.deepEqual(issues(rejected).map((i) => i.code), ['permission']);

  // …while an adult holds the broader verb and may.
  assert.equal(setErrandStatus(someone_elses, 'done', adult).ok, true);
});

test('errands: done is terminal', () => {
  const done = value(setErrandStatus(errand({ assignedTo: M_ADULT }), 'done', adult));
  assert.equal(setErrandStatus(done, 'open', adult).ok, false);
});

test('errands: a malformed dueAt is rejected as a format issue', () => {
  const rejected = createErrand({
    id: 'er-9',
    householdId: H1,
    actor: adult,
    title: 'Bank',
    dueAt: 'next tuesday',
  });
  assert.deepEqual(issues(rejected).map((i) => i.path), ['dueAt']);
});

test('clusterErrandsByLocation: only real combining opportunities are surfaced', () => {
  const clusters = clusterErrandsByLocation([
    errand({ id: 'e1', title: 'Return package', location: 'Main Street Plaza' }),
    errand({ id: 'e2', title: 'Bank deposit', location: '  main street plaza ' }),
    errand({ id: 'e3', title: 'Pharmacy', location: 'Walgreens' }),
    errand({ id: 'e4', title: 'Paperwork', location: undefined }),
    errand({ id: 'e5', title: 'Old task', location: 'Main Street Plaza', status: 'done' }),
  ]);

  assert.equal(clusters.length, 1, 'a lone errand is not a combining opportunity');
  assert.equal(clusters[0]!.location, 'Main Street Plaza');
  assert.deepEqual(clusters[0]!.errands.map((e) => e.id), ['e1', 'e2']);
});

/* ------------------------------------------------------------ reminders */

test('reminders: a child may complete the reminder assigned to them', () => {
  const mine = reminder({ assignedTo: M_CHILD });
  const result = value(completeReminder(mine, child, { now: NOW }));
  assert.equal(result.reminder.status, 'completed');
  assert.equal(result.reminder.completedAt, NOW);
  assert.equal(result.next, null, 'a one-off reminder does not respawn');
});

test('reminders: a child may not complete a sibling’s reminder', () => {
  const not_mine = reminder({ assignedTo: M_TEEN });
  assert.deepEqual(issues(completeReminder(not_mine, child, { now: NOW })).map((i) => i.code), [
    'permission',
  ]);
});

test('reminders: an unassigned reminder cannot be completed by a child, but an adult may', () => {
  const orphan = reminder();
  assert.equal(completeReminder(orphan, child, { now: NOW }).ok, false, 'no assignee is no proof');
  assert.equal(completeReminder(orphan, adult, { now: NOW }).ok, true);
});

test('reminders: completing a recurring reminder yields the next occurrence', () => {
  const weekly = reminder({
    assignedTo: M_ADULT,
    recurrence: { freq: 'WEEKLY', interval: 1 },
  });
  const result = value(completeReminder(weekly, adult, { now: NOW, nextId: 'rm-2' }));

  assert.equal(result.reminder.status, 'completed');
  assert.ok(result.next !== null);
  assert.equal(result.next.id, 'rm-2');
  assert.equal(result.next.status, 'pending');
  assert.equal(result.next.dueAt, '2026-08-31T15:00:00.000Z');
  assert.equal(Object.hasOwn(result.next, 'completedAt'), false, 'the new row is genuinely fresh');
});

test('reminders: a recurring reminder refuses to complete without an id for its successor', () => {
  const daily = reminder({ assignedTo: M_ADULT, recurrence: { freq: 'DAILY', interval: 1 } });
  assert.deepEqual(issues(completeReminder(daily, adult, { now: NOW })).map((i) => i.path), ['nextId']);
});

test('reminders: a recurring series stops at its until bound', () => {
  const ending = reminder({
    assignedTo: M_ADULT,
    dueAt: '2026-08-24T15:00:00.000Z',
    recurrence: { freq: 'WEEKLY', interval: 1, until: '2026-08-30' },
  });
  const result = value(completeReminder(ending, adult, { now: NOW, nextId: 'rm-2' }));
  assert.equal(result.next, null, 'the next occurrence would fall past `until`');
});

test('reminders: a monthly reminder skips a month that has no such day, never clamps it', () => {
  const jan31 = reminder({
    assignedTo: M_ADULT,
    dueAt: '2026-01-31T15:00:00.000Z',
    recurrence: { freq: 'MONTHLY', interval: 1 },
  });
  const result = value(completeReminder(jan31, adult, { now: NOW, nextId: 'rm-2' }));
  assert.equal(result.next, null, 'February has no 31st — skip, never silently move to the 28th');
});

test('reminders: snoozing must move forward in time', () => {
  const mine = reminder({ assignedTo: M_CHILD });
  const backwards = snoozeReminder(mine, child, { until: '2026-08-24T15:30:00.000Z', now: NOW });
  assert.deepEqual(issues(backwards).map((i) => i.code), ['logic']);

  const forwards = value(snoozeReminder(mine, child, { until: '2026-08-24T17:00:00.000Z', now: NOW }));
  assert.equal(forwards.status, 'snoozed');
  assert.equal(forwards.snoozedUntil, '2026-08-24T17:00:00.000Z');
});

test('reminders: a completed reminder is terminal and cannot be snoozed or dismissed', () => {
  const done = value(completeReminder(reminder({ assignedTo: M_ADULT }), adult, { now: NOW })).reminder;
  assert.equal(snoozeReminder(done, adult, { until: '2026-08-25T09:00:00.000Z', now: NOW }).ok, false);
  assert.equal(dismissReminder(done, adult).ok, false);
});

test('dueReminders: a snoozed reminder is judged by its snooze, not by its original due time', () => {
  const overdueButSnoozed = reminder({
    id: 'rm-snoozed',
    dueAt: '2026-08-20T09:00:00.000Z',
    status: 'snoozed',
    snoozedUntil: '2026-08-25T09:00:00.000Z',
  });
  const plainOverdue = reminder({ id: 'rm-overdue', dueAt: '2026-08-24T09:00:00.000Z' });
  const notYet = reminder({ id: 'rm-future', dueAt: '2026-08-30T09:00:00.000Z' });
  const finished = reminder({ id: 'rm-done', dueAt: '2026-08-01T09:00:00.000Z', status: 'completed' });

  const due = dueReminders([overdueButSnoozed, plainOverdue, notYet, finished], NOW);
  assert.deepEqual(due.map((r) => r.id), ['rm-overdue'], 'snoozing an overdue reminder must silence it');
});

test('dueReminders: ordering is stable when two reminders share a due instant', () => {
  const a = reminder({ id: 'rm-b', dueAt: '2026-08-24T09:00:00.000Z' });
  const b = reminder({ id: 'rm-a', dueAt: '2026-08-24T09:00:00.000Z' });
  assert.deepEqual(dueReminders([a, b], NOW).map((r) => r.id), ['rm-a', 'rm-b']);
  assert.deepEqual(dueReminders([b, a], NOW).map((r) => r.id), ['rm-a', 'rm-b']);
});

test('wakeSnoozed: an elapsed snooze returns to pending and drops its snoozedUntil', () => {
  const elapsed = reminder({ status: 'snoozed', snoozedUntil: '2026-08-24T15:30:00.000Z' });
  const pending = reminder({ id: 'rm-2', status: 'snoozed', snoozedUntil: '2026-08-25T09:00:00.000Z' });

  const [woken, stillAsleep] = wakeSnoozed([elapsed, pending], NOW);
  assert.equal(woken!.status, 'pending');
  assert.equal(Object.hasOwn(woken!, 'snoozedUntil'), false);
  assert.equal(stillAsleep!.status, 'snoozed');
});

test('wakeSnoozed reads; dueReminders never writes', () => {
  const snoozed = reminder({ status: 'snoozed', snoozedUntil: '2026-08-24T15:30:00.000Z' });
  const before = JSON.stringify(snoozed);
  dueReminders([snoozed], NOW);
  wakeSnoozed([snoozed], NOW);
  assert.equal(JSON.stringify(snoozed), before, 'neither function may mutate its input');
});

test('reminders: everything refuses across a household boundary, whatever the role', () => {
  const foreign = reminder({ householdId: H2, assignedTo: M_OWNER });
  for (const result of [
    completeReminder(foreign, owner, { now: NOW }),
    snoozeReminder(foreign, owner, { until: '2026-08-25T09:00:00.000Z', now: NOW }),
    dismissReminder(foreign, owner),
  ]) {
    assert.deepEqual(issues(result).map((i) => i.code), ['tenant']);
  }
});
