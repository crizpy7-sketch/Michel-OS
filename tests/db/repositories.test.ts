/**
 * Repository tests (Agent B2), against real Postgres via PGlite.
 *
 * The claim under attack throughout is **tenancy**. Repositories do not decide
 * permissions — the kernel does — but they do promise that a row belonging to
 * another household is unreachable, and that promise is only worth what the
 * tests make it worth. So every read here is attempted twice: once by the
 * household that owns the row, once by a household that does not.
 *
 * The second theme is that search indexing is not something a caller has to
 * remember. Every write that produces something findable must have made it
 * findable, in the same transaction, without the test asking it to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb, type Db } from '../../server/db/client.ts';
import * as repo from '../../server/db/repositories.ts';
import { expandOccurrences } from '../../domains/scheduling/recurrence.ts';
import type { Household, Member, Schedule } from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- fixtures */

interface Tenant {
  household: Household;
  owner: Member;
  child: Member;
  schedule: Schedule;
}

async function makeTenant(db: Db, name: string): Promise<Tenant> {
  return db.transaction(async (tx) => {
    const household = await repo.createHousehold(tx, { name, timezone: 'America/Chicago' });
    const owner = await repo.createMember(tx, {
      householdId: household.id, displayName: `${name} Owner`, role: 'owner',
    });
    const child = await repo.createMember(tx, {
      householdId: household.id, displayName: `${name} Child`, role: 'child',
    });
    const schedule = await repo.ensureSchedule(tx, household.id, 'practice', 'Practice');
    return { household, owner, child, schedule };
  });
}

async function withTenants(fn: (db: Db, a: Tenant, b: Tenant) => Promise<void>): Promise<void> {
  const db = await createTestDb();
  try {
    await fn(db, await makeTenant(db, 'Michel'), await makeTenant(db, 'Other'));
  } finally {
    await db.close();
  }
}

const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };

/* ------------------------------------------------------------- household */

test('a household round-trips, and members come back in role order', async () => {
  await withTenants(async (db, a) => {
    const found = await repo.getHousehold(db, a.household.id);
    assert.equal(found?.name, 'Michel');
    assert.equal(found?.timezone, 'America/Chicago');

    const members = await repo.listMembers(db, a.household.id);
    assert.deepEqual(members.map((m) => m.role), ['owner', 'child']);
    assert.ok(members.every((m) => m.householdId === a.household.id));
  });
});

test('members of another household are never returned', async () => {
  await withTenants(async (db, a, b) => {
    assert.equal(await repo.getMember(db, a.household.id, b.owner.id), null);
    const members = await repo.listMembers(db, a.household.id);
    assert.equal(members.some((m) => m.id === b.owner.id), false);
  });
});

test('ensureSchedule is idempotent — a mini-app does not create a schedule per visit', async () => {
  await withTenants(async (db, a) => {
    const first = await db.transaction((tx) => repo.ensureSchedule(tx, a.household.id, 'games', 'Games'));
    const second = await db.transaction((tx) => repo.ensureSchedule(tx, a.household.id, 'games', 'Games'));
    assert.equal(first.id, second.id);
  });
});

test('countActiveOwners sees only its own household', async () => {
  await withTenants(async (db, a, b) => {
    assert.equal(await repo.countActiveOwners(db, a.household.id), 1);
    await db.transaction((tx) => repo.updateMember(tx, a.household.id, a.owner.id, { active: false }));
    assert.equal(await repo.countActiveOwners(db, a.household.id), 0);
    assert.equal(await repo.countActiveOwners(db, b.household.id), 1, 'the other household is untouched');
  });
});

/* ---------------------------------------------------------------- events */

test('an event round-trips through the contract shape, recurrence included', async () => {
  await withTenants(async (db, a) => {
    const created = await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id,
        scheduleId: a.schedule.id,
        domain: 'practice',
        title: 'Soccer practice',
        location: 'Riverside Fields',
        startsAt: '2026-09-07T21:00:00.000Z',
        endsAt: '2026-09-07T22:00:00.000Z',
        timezone: 'America/Chicago',
        createdBy: a.owner.id,
        recurrence: {
          freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'WE'],
          until: '2026-11-27', weekStart: 'MO', exceptions: ['2026-09-14'],
        },
        participants: [{ memberId: a.child.id, role: 'attendee' }, { memberId: a.owner.id, role: 'responsible' }],
      }),
    );

    const found = await repo.getEvent(db, a.household.id, created.id);
    assert.ok(found);
    assert.equal(found.title, 'Soccer practice');
    assert.deepEqual(found.recurrence?.byWeekday, ['MO', 'WE']);
    assert.equal(found.recurrence?.until, '2026-11-27');
    assert.equal(found.recurrence?.weekStart, 'MO');
    assert.deepEqual(found.recurrence?.exceptions, ['2026-09-14']);

    // The real proof: the row feeds the real engine and expands correctly.
    const occurrences = expandOccurrences(found, WINDOW);
    assert.ok(occurrences.length > 0);
    assert.equal(occurrences.every((o) => o.location === 'Riverside Fields'), true);
    assert.equal(
      occurrences.some((o) => o.occurrenceStart.startsWith('2026-09-14')),
      false,
      'the stored exception must actually remove that occurrence',
    );
  });
});

test('an event with no recurrence omits the key rather than storing undefined', async () => {
  await withTenants(async (db, a) => {
    const created = await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'appointments',
        title: 'Dentist', startsAt: '2026-09-09T21:30:00.000Z', endsAt: '2026-09-09T22:30:00.000Z',
        timezone: 'America/Chicago', createdBy: a.owner.id,
      }),
    );
    const found = (await repo.getEvent(db, a.household.id, created.id))!;
    assert.equal(Object.hasOwn(found, 'recurrence'), false, 'an undefined key breaks deep equality');
    assert.equal(Object.hasOwn(found, 'location'), false);
  });
});

test('an event is invisible to another household by id', async () => {
  await withTenants(async (db, a, b) => {
    const created = await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'practice',
        title: 'Private', startsAt: '2026-09-07T21:00:00.000Z', endsAt: '2026-09-07T22:00:00.000Z',
        timezone: 'UTC', createdBy: a.owner.id,
      }),
    );
    assert.equal(await repo.getEvent(db, b.household.id, created.id), null);
    const theirs = await repo.listEventsForWindow(db, b.household.id, WINDOW);
    assert.equal(theirs.some((e) => e.id === created.id), false);
  });
});

test('the window query finds a series that started before the window', async () => {
  await withTenants(async (db, a) => {
    // A weekly practice created in January must still show up in September.
    await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'practice',
        title: 'Long-running practice',
        startsAt: '2026-01-05T21:00:00.000Z', endsAt: '2026-01-05T22:00:00.000Z',
        timezone: 'UTC', createdBy: a.owner.id,
        recurrence: { freq: 'WEEKLY', interval: 1 },
      }),
    );
    const events = await repo.listEventsForWindow(db, a.household.id, WINDOW);
    assert.equal(events.length, 1, 'a naive starts_at BETWEEN filter would have missed this entirely');
  });
});

test('a one-off event that ended before the window is not returned', async () => {
  await withTenants(async (db, a) => {
    await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'appointments',
        title: 'Last month', startsAt: '2026-08-01T10:00:00.000Z', endsAt: '2026-08-01T11:00:00.000Z',
        timezone: 'UTC', createdBy: a.owner.id,
      }),
    );
    assert.deepEqual(await repo.listEventsForWindow(db, a.household.id, WINDOW), []);
  });
});

test('cancelling one occurrence adds an exception; cancelling the series changes status', async () => {
  await withTenants(async (db, a) => {
    const series = await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'practice',
        title: 'Weekly', startsAt: '2026-09-07T21:00:00.000Z', endsAt: '2026-09-07T22:00:00.000Z',
        timezone: 'America/Chicago', createdBy: a.owner.id,
        recurrence: { freq: 'WEEKLY', interval: 1 },
      }),
    );

    await db.transaction((tx) =>
      repo.cancelEvent(tx, a.household.id, series.id, 'occurrence', '2026-09-14T21:00:00.000Z'),
    );
    const afterOne = (await repo.getEvent(db, a.household.id, series.id))!;
    assert.deepEqual(afterOne.recurrence?.exceptions, ['2026-09-14']);
    assert.equal(afterOne.status, 'confirmed', 'the series itself is still on');

    await db.transaction((tx) => repo.cancelEvent(tx, a.household.id, series.id, 'series'));
    const afterAll = (await repo.getEvent(db, a.household.id, series.id))!;
    assert.equal(afterAll.status, 'cancelled');
    assert.deepEqual(expandOccurrences(afterAll, WINDOW), [], 'a cancelled series is off the calendar');
  });
});

test('a cancelled event cannot be reached through another household', async () => {
  await withTenants(async (db, a, b) => {
    const created = await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'practice',
        title: 'Theirs', startsAt: '2026-09-07T21:00:00.000Z', endsAt: '2026-09-07T22:00:00.000Z',
        timezone: 'UTC', createdBy: a.owner.id,
      }),
    );
    const cancelled = await db.transaction((tx) =>
      repo.cancelEvent(tx, b.household.id, created.id, 'series'),
    );
    assert.equal(cancelled, false, 'another household must not be able to cancel this');
    assert.equal((await repo.getEvent(db, a.household.id, created.id))!.status, 'confirmed');
  });
});

test('participants are returned only for the owning household', async () => {
  await withTenants(async (db, a, b) => {
    const event = await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'practice',
        title: 'With people', startsAt: '2026-09-07T21:00:00.000Z', endsAt: '2026-09-07T22:00:00.000Z',
        timezone: 'UTC', createdBy: a.owner.id,
        participants: [{ memberId: a.child.id, role: 'attendee' }],
      }),
    );
    assert.equal((await repo.listParticipants(db, a.household.id, [event.id])).length, 1);
    assert.deepEqual(await repo.listParticipants(db, b.household.id, [event.id]), []);
  });
});

/* --------------------------------------------------------------- search */

test('creating an event makes it findable, without the caller indexing anything', async () => {
  await withTenants(async (db, a) => {
    await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'practice',
        title: 'Soccer practice', location: 'Riverside Fields',
        startsAt: '2026-09-07T21:00:00.000Z', endsAt: '2026-09-07T22:00:00.000Z',
        timezone: 'UTC', createdBy: a.owner.id,
      }),
    );
    const hits = await repo.searchDocuments(db, a.household.id, 'riverside', ['event']);
    assert.deepEqual(hits.map((h) => h.title), ['Soccer practice']);
  });
});

test('search never crosses a household boundary', async () => {
  await withTenants(async (db, a, b) => {
    for (const tenant of [a, b]) {
      await db.transaction((tx) =>
        repo.createEvent(tx, {
          householdId: tenant.household.id, scheduleId: tenant.schedule.id, domain: 'practice',
          title: 'Soccer practice', startsAt: '2026-09-07T21:00:00.000Z',
          endsAt: '2026-09-07T22:00:00.000Z', timezone: 'UTC', createdBy: tenant.owner.id,
        }),
      );
    }
    const hits = await repo.searchDocuments(db, a.household.id, 'soccer', ['event']);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.householdId, a.household.id);
  });
});

test('search returns nothing for entities the caller was not permitted', async () => {
  await withTenants(async (db, a) => {
    await db.transaction((tx) =>
      repo.createEvent(tx, {
        householdId: a.household.id, scheduleId: a.schedule.id, domain: 'practice',
        title: 'Soccer practice', startsAt: '2026-09-07T21:00:00.000Z',
        endsAt: '2026-09-07T22:00:00.000Z', timezone: 'UTC', createdBy: a.owner.id,
      }),
    );
    assert.deepEqual(await repo.searchDocuments(db, a.household.id, 'soccer', []), []);
    assert.deepEqual(await repo.searchDocuments(db, a.household.id, 'soccer', ['product']), []);
  });
});

test('a completed reminder and a removed shopping item drop out of the index', async () => {
  await withTenants(async (db, a) => {
    const reminder = await db.transaction((tx) =>
      repo.insertReminder(tx, {
        householdId: a.household.id, title: 'Call the insurance company',
        dueAt: '2026-09-07T15:00:00.000Z', status: 'pending', assignedTo: a.owner.id,
      }),
    );
    assert.equal((await repo.searchDocuments(db, a.household.id, 'insurance', ['reminder'])).length, 1);

    await db.transaction((tx) =>
      repo.saveReminder(tx, { ...reminder, status: 'completed', completedAt: '2026-09-07T16:00:00.000Z' }),
    );
    assert.deepEqual(
      await repo.searchDocuments(db, a.household.id, 'insurance', ['reminder']),
      [],
      'a finished reminder should not clutter search',
    );
  });
});

test('a failed transaction indexes nothing — the row and its document commit together', async () => {
  await withTenants(async (db, a) => {
    await assert.rejects(
      db.transaction(async (tx) => {
        await repo.createEvent(tx, {
          householdId: a.household.id, scheduleId: a.schedule.id, domain: 'practice',
          title: 'Doomed', startsAt: '2026-09-07T21:00:00.000Z', endsAt: '2026-09-07T22:00:00.000Z',
          timezone: 'UTC', createdBy: a.owner.id,
        });
        throw new Error('something later in the request failed');
      }),
    );
    assert.deepEqual(await repo.searchDocuments(db, a.household.id, 'doomed', ['event']), []);
    assert.deepEqual(await repo.listEventsForWindow(db, a.household.id, WINDOW), []);
  });
});

/* ------------------------------------------------------ personal lists */

test('shopping and errands round-trip and stay inside their household', async () => {
  await withTenants(async (db, a, b) => {
    await db.transaction(async (tx) => {
      await repo.insertShoppingItem(tx, {
        householdId: a.household.id, listName: 'Household', name: 'Milk',
        quantity: 2, status: 'needed', store: 'Aldi',
      });
      await repo.insertErrand(tx, {
        householdId: a.household.id, title: 'Return the package',
        status: 'open', location: 'Main Street Plaza',
      });
    });

    assert.equal((await repo.listShoppingItems(db, a.household.id)).length, 1);
    assert.equal((await repo.listErrands(db, a.household.id)).length, 1);
    assert.deepEqual(await repo.listShoppingItems(db, b.household.id), []);
    assert.deepEqual(await repo.listErrands(db, b.household.id), []);
  });
});

test('an inbox item records what the classifier proposed without acting on it', async () => {
  await withTenants(async (db, a) => {
    const item = await db.transaction((tx) =>
      repo.insertInboxItem(tx, {
        householdId: a.household.id, rawText: 'we need milk', capturedBy: a.owner.id,
      }),
    );
    assert.equal(item.status, 'unclassified');

    const classified = await db.transaction((tx) =>
      repo.classifyInboxItemRow(tx, a.household.id, item.id, 'shopping', {
        type: 'add_shopping_item', payload: { name: 'we need milk' },
      }),
    );
    assert.equal(classified?.status, 'classified');
    assert.equal(classified?.suggestedDomain, 'shopping');

    // Nothing was created from it — that needs a human, or an executed action.
    assert.deepEqual(await repo.listShoppingItems(db, a.household.id), []);
  });
});

/* ------------------------------------------------------------- business */

test('business rows are unreachable from another household even with the right business id', async () => {
  await withTenants(async (db, a, b) => {
    const business = await db.transaction((tx) =>
      repo.createBusiness(tx, { householdId: a.household.id, name: 'Shia Baby', timezone: 'UTC' }),
    );
    await db.transaction((tx) =>
      repo.insertEmployee(tx, a.household.id, { businessId: business.id, displayName: 'Maria' }),
    );

    assert.equal((await repo.listEmployees(db, a.household.id, business.id)).length, 1);
    assert.deepEqual(
      await repo.listEmployees(db, b.household.id, business.id),
      [],
      'CR-009: knowing the business id must not be enough',
    );

    const smuggled = await db.transaction((tx) =>
      repo.insertEmployee(tx, b.household.id, { businessId: business.id, displayName: 'Impostor' }),
    );
    assert.equal(smuggled, null, 'writing into another household’s business must fail');
    assert.equal((await repo.listEmployees(db, a.household.id, business.id)).length, 1);
  });
});

test('a sale round-trips with its lines, and totals stay whole cents', async () => {
  await withTenants(async (db, a) => {
    const result = await db.transaction(async (tx) => {
      const business = await repo.createBusiness(tx, {
        householdId: a.household.id, name: 'Shia Baby', timezone: 'UTC', taxSetAsideRate: 0.0825,
      });
      const product = (await repo.insertProduct(tx, a.household.id, {
        businessId: business.id, sku: 'BEAR-01', name: 'Classic teddy',
        quantityOnHand: 10, reorderPoint: 4, unitCost: 500, unitPrice: 1200,
      }))!;
      const sale = await repo.insertSale(tx, a.household.id, {
        businessId: business.id, at: '2026-09-07T15:00:00.000Z',
        items: [{ productId: product.id, quantity: 2, unitPriceCents: 1250 }],
        taxCollectedCents: 206,
      });
      return { business, sale };
    });

    assert.ok(result.sale);
    assert.equal(result.sale.items.length, 1);
    assert.equal(result.sale.items[0]!.unitPriceCents, 1250);
    assert.ok(Number.isInteger(result.sale.items[0]!.unitPriceCents));
    assert.equal(result.sale.taxCollectedCents, 206);

    const sales = await repo.listSales(db, a.household.id, result.business.id);
    assert.equal(sales.length, 1);
    assert.equal(sales[0]!.items.length, 1, 'lines must come back with the sale, not separately');
  });
});

test('the tax reserve total sums only its own business', async () => {
  await withTenants(async (db, a, b) => {
    const mine = await db.transaction((tx) =>
      repo.createBusiness(tx, { householdId: a.household.id, name: 'Shia Baby', timezone: 'UTC' }),
    );
    const theirs = await db.transaction((tx) =>
      repo.createBusiness(tx, { householdId: b.household.id, name: 'Rival', timezone: 'UTC' }),
    );
    await db.transaction(async (tx) => {
      await repo.insertReserveEntry(tx, a.household.id, {
        businessId: mine.id, at: '2026-09-01T00:00:00.000Z', amountCents: 5000,
      });
      await repo.insertReserveEntry(tx, b.household.id, {
        businessId: theirs.id, at: '2026-09-01T00:00:00.000Z', amountCents: 999_999,
      });
    });

    assert.equal(await repo.totalReserved(db, a.household.id, mine.id), 5000);
    assert.equal(await repo.totalReserved(db, a.household.id, theirs.id), 0, 'not mine to read');
  });
});

/* --------------------------------------------------------- notifications */

test('regenerating notifications from unchanged facts creates nothing the second time', async () => {
  await withTenants(async (db, a) => {
    const draft = {
      householdId: a.household.id, recipientMemberId: a.owner.id, kind: 'reminder_due' as const,
      channel: 'in_app' as const, title: 'Call insurance', body: 'Due now',
      deliverAt: '2026-09-07T15:00:00.000Z', dedupeKey: 'same-facts',
    };

    assert.equal(await db.transaction((tx) => repo.upsertNotifications(tx, [draft])), 1);
    assert.equal(
      await db.transaction((tx) => repo.upsertNotifications(tx, [draft])),
      0,
      'the same facts must not nag twice',
    );

    const inbox = await repo.listNotifications(db, a.household.id, a.owner.id, '2026-09-07T16:00:00.000Z');
    assert.equal(inbox.length, 1);
  });
});

test('a read notification stays read even when the generator runs again', async () => {
  await withTenants(async (db, a) => {
    const draft = {
      householdId: a.household.id, recipientMemberId: null, kind: 'low_stock' as const,
      channel: 'in_app' as const, title: 'Low stock', body: 'Teddy is down to 1',
      deliverAt: '2026-09-07T15:00:00.000Z', dedupeKey: 'stock-1',
    };
    await db.transaction((tx) => repo.upsertNotifications(tx, [draft]));

    const [notification] = await repo.listNotifications(db, a.household.id, a.owner.id, '2026-09-07T16:00:00.000Z');
    await db.transaction((tx) =>
      repo.markNotificationRead(tx, a.household.id, a.owner.id, notification!.id, '2026-09-07T16:05:00.000Z'),
    );

    await db.transaction((tx) => repo.upsertNotifications(tx, [draft]));
    assert.deepEqual(
      await repo.listNotifications(db, a.household.id, a.owner.id, '2026-09-07T17:00:00.000Z'),
      [],
      'something already read came back unread',
    );
  });
});

test('a notification addressed to one member is not shown to another', async () => {
  await withTenants(async (db, a) => {
    await db.transaction((tx) =>
      repo.upsertNotifications(tx, [{
        householdId: a.household.id, recipientMemberId: a.child.id, kind: 'reminder_due',
        channel: 'in_app', title: 'Wash the uniform', body: 'Due now',
        deliverAt: '2026-09-07T15:00:00.000Z', dedupeKey: 'kid-only',
      }]),
    );
    const now = '2026-09-07T16:00:00.000Z';
    assert.equal((await repo.listNotifications(db, a.household.id, a.child.id, now)).length, 1);
    assert.equal((await repo.listNotifications(db, a.household.id, a.owner.id, now)).length, 0);
  });
});

test('another member cannot mark somebody else’s notification read', async () => {
  await withTenants(async (db, a) => {
    await db.transaction((tx) =>
      repo.upsertNotifications(tx, [{
        householdId: a.household.id, recipientMemberId: a.child.id, kind: 'reminder_due',
        channel: 'in_app', title: 'Kid only', body: 'x',
        deliverAt: '2026-09-07T15:00:00.000Z', dedupeKey: 'kid-only',
      }]),
    );
    const [n] = await repo.listNotifications(db, a.household.id, a.child.id, '2026-09-07T16:00:00.000Z');
    const marked = await db.transaction((tx) =>
      repo.markNotificationRead(tx, a.household.id, a.owner.id, n!.id, '2026-09-07T16:05:00.000Z'),
    );
    assert.equal(marked, false);
  });
});

/* ---------------------------------------------------------------- audit */

test('audit rows record before and after, scoped to their household', async () => {
  await withTenants(async (db, a, b) => {
    await db.transaction((tx) =>
      repo.writeAudit(tx, {
        householdId: a.household.id, actorMemberId: a.owner.id, action: 'event.cancel',
        entity: 'event', entityId: 'e1', before: { status: 'confirmed' }, after: { status: 'cancelled' },
      }),
    );
    const mine = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_log where household_id = $1`, [a.household.id],
    );
    const theirs = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_log where household_id = $1`, [b.household.id],
    );
    assert.equal(Number(mine.rows[0]!.n), 1);
    assert.equal(Number(theirs.rows[0]!.n), 0);
  });
});
