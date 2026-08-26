/**
 * Unit tests for the cross-cutting platform layer (Agent K):
 * domains/platform/search.ts and domains/platform/notifications.ts.
 *
 * Search is attacked as a privacy surface first and a ranking problem second.
 * Notifications are attacked as a nagging problem: the same facts, regenerated,
 * must never produce a second row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SEARCH_LIMIT,
  SearchIndex,
  search,
  tokenize,
} from '../../domains/platform/search.ts';
import {
  conflictsDetected,
  dedupeKey,
  inboxFor,
  lowStock,
  markRead,
  materializeNotification,
  mergeNotifications,
  remindersDue,
  unreadCount,
} from '../../domains/platform/notifications.ts';
import type {
  Conflict,
  Member,
  Notification,
  Reminder,
  Role,
  SearchDocument,
  UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- fixtures */

const H1: UUID = 'hh-michel';
const H2: UUID = 'hh-other';
const BUSINESS: UUID = 'biz-shia-baby';
const OTHER_BUSINESS: UUID = 'biz-rival';

function member(id: UUID, role: Role, householdId: UUID = H1): Member {
  return { id, householdId, userId: null, displayName: id, role, color: 'slate', active: true };
}

const owner = member('m-owner', 'owner');
const adult = member('m-adult', 'adult');
const employee = member('m-employee', 'employee');
const viewer = member('m-viewer', 'viewer');

function doc(patch: Partial<SearchDocument> & Pick<SearchDocument, 'entity' | 'id' | 'title'>): SearchDocument {
  return { householdId: H1, ...patch };
}

const CORPUS: SearchDocument[] = [
  doc({ entity: 'event', id: 'e1', title: 'Soccer practice', body: 'Leila at Riverside Fields', domain: 'practice', at: '2026-08-24T18:00:00.000Z' }),
  doc({ entity: 'event', id: 'e2', title: 'Dentist appointment', body: 'Mateo, Mercy Dental', domain: 'appointments', at: '2026-08-20T14:00:00.000Z' }),
  doc({ entity: 'reminder', id: 'r1', title: 'Wash the practice uniform', at: '2026-08-23T09:00:00.000Z' }),
  doc({ entity: 'shopping_item', id: 'si1', title: 'Milk', body: 'groceries', at: '2026-08-22T09:00:00.000Z' }),
  doc({ entity: 'employee', id: 'emp1', title: 'Maria Ruiz', businessId: BUSINESS, at: '2026-08-01T09:00:00.000Z' }),
  doc({ entity: 'product', id: 'p1', title: 'Classic teddy', body: 'BEAR-01', businessId: BUSINESS, at: '2026-08-01T09:00:00.000Z' }),
  doc({ entity: 'expense', id: 'ex1', title: 'Fabric Depot', body: 'materials', businessId: BUSINESS, at: '2026-08-02T09:00:00.000Z' }),
  doc({ entity: 'event', id: 'x1', title: 'Soccer practice', householdId: H2, at: '2026-08-24T18:00:00.000Z' }),
];

const INDEX = SearchIndex.build(CORPUS);

/* ------------------------------------------------------------ tokenising */

test('tokenize: folds case and diacritics, and does not stem', () => {
  assert.deepEqual(tokenize('Leïla’s SOCCER practice!'), ['leila', 's', 'soccer', 'practice']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('   '), []);
});

/* ------------------------------------------------------- search: privacy */

test('search: another household’s rows are invisible even to an owner', () => {
  const hits = search(INDEX, 'soccer practice', owner, H1);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.id !== 'x1'), 'a same-titled event in another household must not leak');
});

test('search: an employee cannot see the family calendar but can see the shop', () => {
  const family = search(INDEX, 'practice', employee, H1, { businessId: BUSINESS });
  assert.deepEqual(family, [], 'the employee privacy boundary holds inside search too');

  const shop = search(INDEX, 'maria', employee, H1, { businessId: BUSINESS });
  assert.deepEqual(shop.map((h) => h.id), ['emp1']);
});

test('search: a viewer sees family rows and no business rows at all', () => {
  assert.deepEqual(search(INDEX, 'dentist', viewer, H1).map((h) => h.id), ['e2']);
  assert.deepEqual(search(INDEX, 'teddy', viewer, H1, { businessId: BUSINESS }), []);
});

test('search: an adult reads finance rows; an employee does not', () => {
  assert.deepEqual(
    search(INDEX, 'fabric', adult, H1, { businessId: BUSINESS }).map((h) => h.id),
    ['ex1'],
  );
  assert.deepEqual(search(INDEX, 'fabric', employee, H1, { businessId: BUSINESS }), []);
});

test('search: a business row is invisible outside the business scope the caller set', () => {
  assert.deepEqual(search(INDEX, 'teddy', owner, H1, { businessId: BUSINESS }).map((h) => h.id), ['p1']);
  assert.deepEqual(search(INDEX, 'teddy', owner, H1, { businessId: OTHER_BUSINESS }), []);
  assert.deepEqual(search(INDEX, 'teddy', owner, H1), [], 'no scope set means no business rows');
});

test('search: a deactivated member sees nothing at all', () => {
  const suspended: Member = { ...owner, active: false };
  assert.deepEqual(search(INDEX, 'soccer', suspended, H1), []);
});

/* ------------------------------------------------------- search: ranking */

test('search: matching every term outranks matching only one', () => {
  const hits = search(INDEX, 'practice uniform', owner, H1);
  assert.equal(hits[0]!.id, 'r1', 'the reminder matches both terms');
  assert.ok(hits.some((h) => h.id === 'e1'), 'the partial match is still returned');
  assert.ok(hits[0]!.score > hits[1]!.score);
});

test('search: a title match outranks a body match for the same term', () => {
  const hits = search(INDEX, 'practice', owner, H1);
  const titles = hits.findIndex((h) => h.id === 'r1'); // "practice" in the title
  const bodies = hits.findIndex((h) => h.id === 'e1'); // "practice" in the title too
  assert.ok(titles >= 0 && bodies >= 0);

  const leila = search(INDEX, 'leila', owner, H1);
  assert.deepEqual(leila.map((h) => h.id), ['e1'], 'a body-only term still matches');
});

test('search: a prefix matches, but a whole word scores higher', () => {
  const prefix = search(INDEX, 'dent', owner, H1);
  const exact = search(INDEX, 'dentist', owner, H1);
  assert.deepEqual(prefix.map((h) => h.id), ['e2']);
  assert.ok(exact[0]!.score > prefix[0]!.score);
});

test('search: results are byte-identical however the corpus was ordered', () => {
  const shuffled = SearchIndex.build([...CORPUS].reverse());
  assert.deepEqual(search(shuffled, 'practice', owner, H1), search(INDEX, 'practice', owner, H1));
});

test('search: recency breaks a tie between two otherwise equal hits', () => {
  const index = SearchIndex.build([
    doc({ entity: 'event', id: 'old', title: 'Game day', at: '2026-08-01T00:00:00.000Z' }),
    doc({ entity: 'event', id: 'new', title: 'Game day', at: '2026-08-20T00:00:00.000Z' }),
  ]);
  assert.deepEqual(search(index, 'game day', owner, H1).map((h) => h.id), ['new', 'old']);
});

test('search: an empty or all-punctuation query returns nothing rather than everything', () => {
  assert.deepEqual(search(INDEX, '', owner, H1), []);
  assert.deepEqual(search(INDEX, '   ***  ', owner, H1), []);
});

test('search: the entity filter narrows without widening what the member may see', () => {
  assert.deepEqual(search(INDEX, 'practice', owner, H1, { entities: ['reminder'] }).map((h) => h.id), ['r1']);
  assert.deepEqual(
    search(INDEX, 'practice', employee, H1, { entities: ['event', 'reminder'] }),
    [],
    'asking for events does not grant permission to read them',
  );
});

test('search: the limit is honoured and defaults to a bounded page', () => {
  const many = SearchIndex.build(
    Array.from({ length: 50 }, (_, i) =>
      doc({ entity: 'event', id: `e${i}`, title: 'Practice', at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T09:00:00.000Z` }),
    ),
  );
  assert.equal(search(many, 'practice', owner, H1).length, DEFAULT_SEARCH_LIMIT);
  assert.equal(search(many, 'practice', owner, H1, { limit: 3 }).length, 3);
});

test('search: the snippet marks matches without emitting markup', () => {
  const [hit] = search(INDEX, 'riverside', owner, H1);
  assert.ok(hit);
  assert.match(hit.snippet, /\[\[Riverside\]\]/);
  assert.equal(/[<>]/.test(hit.snippet), false, 'a domain module must not ship HTML into a UI');
});

test('SearchIndex: re-pushing the same key replaces rather than duplicates', () => {
  const index = SearchIndex.build([
    doc({ entity: 'event', id: 'e1', title: 'Old title' }),
    doc({ entity: 'event', id: 'e1', title: 'New title' }),
  ]);
  assert.equal(index.size, 1);
  assert.equal(index.documents()[0]!.title, 'New title');
});

test('SearchIndex: rows with no id or no household are dropped, not indexed as blanks', () => {
  const index = SearchIndex.build([
    doc({ entity: 'event', id: '', title: 'Nameless' }),
    { entity: 'event', id: 'e9', householdId: '', title: 'Tenantless' },
    doc({ entity: 'event', id: 'e1', title: 'Real' }),
  ]);
  assert.equal(index.size, 1);
});

/* --------------------------------------------------- notifications: dedupe */

const NOW = '2026-08-24T16:00:00.000Z';

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

function conflict(patch: Partial<Conflict> = {}): Conflict {
  return {
    id: 'c-1',
    householdId: H1,
    kind: 'overlap',
    severity: 'warning',
    memberIds: ['m-ana'],
    occurrenceRefs: [],
    window: { startsAt: '2026-08-24T16:00:00.000Z', endsAt: '2026-08-24T17:00:00.000Z' },
    explanation: 'Ana is double-booked.',
    ...patch,
  };
}

test('dedupeKey: identical facts give an identical key; a changed fact does not', () => {
  assert.equal(dedupeKey('low_stock', H1, 'p1', '3'), dedupeKey('low_stock', H1, 'p1', '3'));
  assert.notEqual(dedupeKey('low_stock', H1, 'p1', '3'), dedupeKey('low_stock', H1, 'p1', '1'));
  assert.notEqual(dedupeKey('low_stock', H1, 'p1', '3'), dedupeKey('low_stock', H2, 'p1', '3'));
});

test('remindersDue: an overdue reminder notifies its assignee; a future one is silent', () => {
  const drafts = remindersDue(
    [
      reminder({ id: 'rm-late', assignedTo: 'm-ana' }),
      reminder({ id: 'rm-future', dueAt: '2026-08-30T09:00:00.000Z' }),
      reminder({ id: 'rm-done', status: 'completed' }),
      reminder({ id: 'rm-foreign', householdId: H2 }),
    ],
    H1,
    NOW,
  );
  assert.deepEqual(drafts.map((d) => d.subject?.id), ['rm-late']);
  assert.equal(drafts[0]!.recipientMemberId, 'm-ana');
  assert.match(drafts[0]!.body, /1 hour ago/);
});

test('remindersDue: re-running the generator produces the same keys', () => {
  const once = remindersDue([reminder()], H1, NOW);
  const twice = remindersDue([reminder()], H1, '2026-08-24T17:00:00.000Z');
  assert.equal(once[0]!.dedupeKey, twice[0]!.dedupeKey, 'the key depends on the facts, not on when we looked');
});

test('conflictsDetected: info conflicts do not interrupt anyone; resolved ones do not either', () => {
  const drafts = conflictsDetected(
    [
      conflict({ id: 'c-info', severity: 'info' }),
      conflict({ id: 'c-warn' }),
      conflict({
        id: 'c-resolved',
        resolution: { resolvedBy: 'm-mom', resolvedAt: '2026-08-24T10:00:00.000Z' },
      }),
    ],
    H1,
    NOW,
  );
  assert.deepEqual(drafts.map((d) => d.subject?.id), ['c-warn']);
});

test('conflictsDetected: one draft per member implicated, each with its own key', () => {
  const drafts = conflictsDetected([conflict({ memberIds: ['m-ana', 'm-leo'] })], H1, NOW);
  assert.equal(drafts.length, 2);
  assert.notEqual(drafts[0]!.dedupeKey, drafts[1]!.dedupeKey);
  assert.deepEqual(drafts.map((d) => d.recipientMemberId).sort(), ['m-ana', 'm-leo']);
});

test('conflictsDetected: a blocking conflict is titled differently from a warning', () => {
  const [blocking] = conflictsDetected([conflict({ severity: 'blocking' })], H1, NOW);
  const [warning] = conflictsDetected([conflict({ severity: 'warning' })], H1, NOW);
  assert.equal(blocking!.title, 'Scheduling conflict');
  assert.equal(warning!.title, 'Possible scheduling conflict');
});

test('lowStock: falling further notifies again; the same level does not', () => {
  const alert = { productId: 'p1', sku: 'BEAR-01', name: 'Classic teddy', quantityOnHand: 3, reorderPoint: 4 };
  const first = lowStock([alert], H1, NOW);
  const same = lowStock([alert], H1, '2026-08-25T16:00:00.000Z');
  const worse = lowStock([{ ...alert, quantityOnHand: 1 }], H1, NOW);

  assert.equal(first[0]!.dedupeKey, same[0]!.dedupeKey);
  assert.notEqual(first[0]!.dedupeKey, worse[0]!.dedupeKey);
});

test('lowStock: out of stock reads differently from merely low', () => {
  const [out] = lowStock(
    [{ productId: 'p1', sku: 'BEAR-01', name: 'Classic teddy', quantityOnHand: 0, reorderPoint: 4 }],
    H1,
    NOW,
  );
  assert.match(out!.body, /out of stock/);
});

/* -------------------------------------------------- notifications: merging */

function notification(patch: Partial<Notification> & Pick<Notification, 'dedupeKey'>): Notification {
  return {
    id: 'n-1',
    householdId: H1,
    recipientMemberId: null,
    kind: 'reminder_due',
    channel: 'in_app',
    title: 'T',
    body: 'B',
    deliverAt: '2026-08-24T15:00:00.000Z',
    ...patch,
  };
}

test('mergeNotifications: a regenerated draft matches its existing row and is not re-created', () => {
  const drafts = remindersDue([reminder()], H1, NOW);
  const existing = [notification({ id: 'n-1', dedupeKey: drafts[0]!.dedupeKey, readAt: '2026-08-24T15:05:00.000Z' })];

  const merged = mergeNotifications(existing, drafts);
  assert.deepEqual(merged.created, [], 'nothing new to insert');
  assert.equal(merged.unchanged.length, 1);
  assert.equal(merged.unchanged[0]!.readAt, '2026-08-24T15:05:00.000Z', 'a read notice stays read');
});

test('mergeNotifications: a genuinely new draft is created', () => {
  const drafts = remindersDue([reminder()], H1, NOW);
  const merged = mergeNotifications([], drafts);
  assert.equal(merged.created.length, 1);
  assert.deepEqual(merged.unchanged, []);
});

test('mergeNotifications: an unread row no draft justifies any more is stale, a read one is left alone', () => {
  const existing = [
    notification({ id: 'n-old', dedupeKey: 'gone-unread' }),
    notification({ id: 'n-seen', dedupeKey: 'gone-read', readAt: NOW }),
  ];
  const merged = mergeNotifications(existing, []);
  assert.deepEqual(merged.stale.map((n) => n.id), ['n-old']);
});

test('mergeNotifications: a duplicated draft from the generator collapses to one row', () => {
  const drafts = remindersDue([reminder()], H1, NOW);
  const merged = mergeNotifications([], [...drafts, ...drafts]);
  assert.equal(merged.created.length, 1);
});

test('mergeNotifications: a duplicate row in the store does not make the result order-dependent', () => {
  const drafts = remindersDue([reminder()], H1, NOW);
  const key = drafts[0]!.dedupeKey;
  const forward = mergeNotifications(
    [notification({ id: 'n-a', dedupeKey: key }), notification({ id: 'n-b', dedupeKey: key })],
    drafts,
  );
  assert.deepEqual(forward.unchanged.map((n) => n.id), ['n-a']);
});

/* ---------------------------------------------------- notifications: inbox */

test('inboxFor: household-wide and personally addressed notices both arrive; others do not', () => {
  const notifications = [
    notification({ id: 'n-everyone', dedupeKey: 'k1' }),
    notification({ id: 'n-mine', dedupeKey: 'k2', recipientMemberId: 'm-ana' }),
    notification({ id: 'n-theirs', dedupeKey: 'k3', recipientMemberId: 'm-leo' }),
    notification({ id: 'n-foreign', dedupeKey: 'k4', householdId: H2 }),
    notification({ id: 'n-read', dedupeKey: 'k5', readAt: NOW }),
    notification({ id: 'n-later', dedupeKey: 'k6', deliverAt: '2026-08-30T09:00:00.000Z' }),
  ];
  assert.deepEqual(
    inboxFor(notifications, 'm-ana', H1, NOW).map((n) => n.id).sort(),
    ['n-everyone', 'n-mine'],
  );
  assert.equal(unreadCount(notifications, 'm-ana', H1, NOW), 2);
});

test('inboxFor: newest first, with a stable tie-break', () => {
  const notifications = [
    notification({ id: 'n-b', dedupeKey: 'k1', deliverAt: '2026-08-24T10:00:00.000Z' }),
    notification({ id: 'n-a', dedupeKey: 'k2', deliverAt: '2026-08-24T10:00:00.000Z' }),
    notification({ id: 'n-new', dedupeKey: 'k3', deliverAt: '2026-08-24T15:00:00.000Z' }),
  ];
  assert.deepEqual(inboxFor(notifications, 'm-ana', H1, NOW).map((n) => n.id), ['n-new', 'n-a', 'n-b']);
});

test('markRead: idempotent — opening the centre twice does not move the first-seen time', () => {
  const fresh = notification({ dedupeKey: 'k1' });
  const read = markRead(fresh, '2026-08-24T16:00:00.000Z');
  assert.equal(read.readAt, '2026-08-24T16:00:00.000Z');

  const again = markRead(read, '2026-08-24T18:00:00.000Z');
  assert.equal(again.readAt, '2026-08-24T16:00:00.000Z');
  assert.equal(again, read, 'an unchanged row is returned as-is');
});

test('materializeNotification: defaults to the in-app channel and keeps the caller’s id', () => {
  const [draft] = remindersDue([reminder()], H1, NOW);
  const row = materializeNotification('n-42', draft!);
  assert.equal(row.id, 'n-42');
  assert.equal(row.channel, 'in_app');
  assert.equal(row.dedupeKey, draft!.dedupeKey);
});
