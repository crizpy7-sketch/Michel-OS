/**
 * Schema tests (Agent B2 — Backend / Persistence).
 *
 * These run against REAL PostgreSQL (PGlite, in-process), not a mock. Every
 * assertion here is the database actually refusing something, which is the only
 * kind of evidence worth having about a constraint.
 *
 * The most valuable test in this file is `enumerated CHECK constraints match
 * the frozen contracts exactly`. The schema restates every union type from
 * `lib/contracts/index.ts` as a CHECK. Restating something is how it drifts —
 * somebody adds a `ConflictKind` and the database silently rejects it six
 * months later in production. So the test reads the live constraint definitions
 * out of `pg_constraint` and compares them to the contract arrays. Adding a
 * value to a frozen union without touching the schema fails here, loudly, in
 * CI, rather than quietly at 11pm on somebody's phone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb, migrate, verifyMigrations, type Db } from '../../server/db/client.ts';
import {
  DOMAINS,
  ERRAND_STATUS,
  EVENT_STATUS,
  FREQUENCIES,
  INBOX_STATUS,
  MOVEMENT_KINDS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  PARTICIPANT_ROLES,
  REMINDER_STATUS,
  ROLES,
  SEARCH_ENTITIES,
  SHIFT_STATUS,
  SHOPPING_STATUS,
  SWAP_STATUS,
  TIME_OFF_STATUS,
  WEEKDAYS,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- helpers */

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const db = await createTestDb();
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

/** Values inside a CHECK constraint's `IN (...)` list, as the database has it. */
async function checkValues(db: Db, table: string, column: string): Promise<string[]> {
  const { rows } = await db.query<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname = $1 and c.contype = 'c'`,
    [table],
  );
  for (const row of rows) {
    // Only the constraint that actually mentions this column.
    if (!new RegExp(`\\b${column}\\b`).test(row.def)) continue;
    const literals = [...row.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
    if (literals.length > 0) return literals.sort();
  }
  return [];
}

async function seedHousehold(db: Db): Promise<{ householdId: string; memberId: string; scheduleId: string }> {
  const h = await db.query<{ id: string }>(
    `insert into household (name, timezone) values ($1, $2) returning id`,
    ['Michel', 'America/Chicago'],
  );
  const householdId = h.rows[0]!.id;
  const m = await db.query<{ id: string }>(
    `insert into member (household_id, display_name, role) values ($1, $2, $3) returning id`,
    [householdId, 'Elena', 'owner'],
  );
  const s = await db.query<{ id: string }>(
    `insert into schedule (household_id, domain, name) values ($1, $2, $3) returning id`,
    [householdId, 'practice', 'Practice'],
  );
  return { householdId, memberId: m.rows[0]!.id, scheduleId: s.rows[0]!.id };
}

async function rejects(fn: () => Promise<unknown>, why: string): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail(`expected the database to refuse this: ${why}`);
}

/* ------------------------------------------------------------ migrations */

test('migrations apply cleanly and create every contract table', async () => {
  await withDb(async (db) => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const tables = new Set(rows.map((r) => r.table_name));

    for (const expected of [
      'household', 'app_user', 'member', 'invitation', 'session',
      'schedule', 'event', 'event_exception', 'event_participant', 'reminder',
      'shopping_item', 'errand', 'inbox_item',
      'business', 'employee', 'availability', 'shift', 'time_off_request', 'shift_swap',
      'product', 'inventory_movement', 'sale', 'sale_item', 'expense', 'tax_reserve_entry',
      'attachment', 'notification', 'search_document', 'audit_log', 'ai_action',
    ]) {
      assert.ok(tables.has(expected), `missing table: ${expected}`);
    }
  });
});

test('migrations are idempotent — a second run applies nothing', async () => {
  await withDb(async (db) => {
    assert.deepEqual(await migrate(db), [], 'an already-migrated database re-ran a migration');
  });
});

test('an edited migration that already ran is reported as drift', async () => {
  await withDb(async (db) => {
    assert.deepEqual(await verifyMigrations(db), [], 'a fresh database should have no drift');

    // Simulate someone editing 001 after it shipped.
    await db.query(`update schema_migration set checksum = 'tampered' where name = $1`, [
      '001_initial.sql',
    ]);
    assert.deepEqual(
      await verifyMigrations(db),
      ['001_initial.sql'],
      'an edited migration must be reported, not silently tolerated',
    );
  });
});

/* -------------------------------------------------- contract/schema drift */

test('enumerated CHECK constraints match the frozen contracts exactly', async () => {
  await withDb(async (db) => {
    const cases: Array<{ table: string; column: string; contract: readonly string[] }> = [
      { table: 'member', column: 'role', contract: ROLES },
      { table: 'invitation', column: 'role', contract: ROLES },
      { table: 'schedule', column: 'domain', contract: DOMAINS },
      { table: 'event', column: 'domain', contract: DOMAINS },
      { table: 'event', column: 'status', contract: EVENT_STATUS },
      { table: 'event_participant', column: 'role', contract: PARTICIPANT_ROLES },
      { table: 'reminder', column: 'status', contract: REMINDER_STATUS },
      { table: 'shopping_item', column: 'status', contract: SHOPPING_STATUS },
      { table: 'errand', column: 'status', contract: ERRAND_STATUS },
      { table: 'inbox_item', column: 'status', contract: INBOX_STATUS },
      { table: 'inbox_item', column: 'suggested_domain', contract: DOMAINS },
      { table: 'shift', column: 'status', contract: SHIFT_STATUS },
      { table: 'time_off_request', column: 'status', contract: TIME_OFF_STATUS },
      { table: 'shift_swap', column: 'status', contract: SWAP_STATUS },
      { table: 'availability', column: 'weekday', contract: WEEKDAYS },
      { table: 'inventory_movement', column: 'kind', contract: MOVEMENT_KINDS },
      { table: 'notification', column: 'kind', contract: NOTIFICATION_KINDS },
      { table: 'notification', column: 'channel', contract: NOTIFICATION_CHANNELS },
      { table: 'search_document', column: 'entity', contract: SEARCH_ENTITIES },
      { table: 'event', column: 'rrule_freq', contract: FREQUENCIES },
      { table: 'event', column: 'rrule_week_start', contract: WEEKDAYS },
      { table: 'reminder', column: 'rrule_freq', contract: FREQUENCIES },
    ];

    for (const { table, column, contract } of cases) {
      const inDatabase = await checkValues(db, table, column);
      assert.deepEqual(
        inDatabase,
        [...contract].sort(),
        `${table}.${column} has drifted from the frozen contract`,
      );
    }
  });
});

/* ------------------------------------------------------------- tenancy */

test('deleting a household cascades to everything it owns', async () => {
  await withDb(async (db) => {
    const { householdId, memberId, scheduleId } = await seedHousehold(db);
    await db.query(
      `insert into event (household_id, schedule_id, domain, title, starts_at, ends_at, timezone, created_by)
       values ($1,$2,'practice','Soccer', now(), now() + interval '1 hour', 'UTC', $3)`,
      [householdId, scheduleId, memberId],
    );
    await db.query(`insert into errand (household_id, title) values ($1,'Bank')`, [householdId]);
    await db.query(`insert into shopping_item (household_id, name) values ($1,'Milk')`, [householdId]);

    await db.query(`delete from household where id = $1`, [householdId]);

    for (const table of ['member', 'schedule', 'event', 'errand', 'shopping_item']) {
      const { rows } = await db.query<{ n: string }>(`select count(*)::int as n from ${table}`);
      assert.equal(Number(rows[0]!.n), 0, `${table} still has rows after the household was deleted`);
    }
  });
});

test('an event cannot reference a schedule from another household — the FK is real', async () => {
  await withDb(async (db) => {
    const a = await seedHousehold(db);
    const b = await seedHousehold(db);

    // The FK alone does not stop this (both schedules exist), which is exactly
    // why tenancy is also checked in the repository layer. What the database
    // guarantees is that the id must EXIST; the repository guarantees it is
    // yours. Assert both halves so neither is mistaken for the other.
    await db.query(
      `insert into event (household_id, schedule_id, domain, title, starts_at, ends_at, timezone, created_by)
       values ($1,$2,'practice','Cross-tenant', now(), now() + interval '1 hour','UTC',$3)`,
      [a.householdId, b.scheduleId, a.memberId],
    );
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from event e
         join schedule s on s.id = e.schedule_id
        where e.household_id <> s.household_id`,
    );
    assert.equal(rows[0]!.n, 1, 'the schema permits it; the repository layer is what must refuse it');

    await rejects(
      () =>
        db.query(
          `insert into event (household_id, schedule_id, domain, title, starts_at, ends_at, timezone, created_by)
           values ($1,'00000000-0000-4000-8000-000000000000','practice','Ghost', now(), now() + interval '1 hour','UTC',$2)`,
          [a.householdId, a.memberId],
        ),
      'a schedule id that does not exist at all',
    );
  });
});

/* --------------------------------------------------------- constraints */

test('an event must end after it starts', async () => {
  await withDb(async (db) => {
    const { householdId, memberId, scheduleId } = await seedHousehold(db);
    const message = await rejects(
      () =>
        db.query(
          `insert into event (household_id, schedule_id, domain, title, starts_at, ends_at, timezone, created_by)
           values ($1,$2,'practice','Backwards', now(), now() - interval '1 hour','UTC',$3)`,
          [householdId, scheduleId, memberId],
        ),
      'an inverted event span',
    );
    assert.match(message, /event_span_valid/);
  });
});

test('a half-written recurrence rule is refused', async () => {
  await withDb(async (db) => {
    const { householdId, memberId, scheduleId } = await seedHousehold(db);
    const message = await rejects(
      () =>
        db.query(
          `insert into event (household_id, schedule_id, domain, title, starts_at, ends_at, timezone, created_by, rrule_freq)
           values ($1,$2,'practice','Half a rule', now(), now() + interval '1 hour','UTC',$3,'WEEKLY')`,
          [householdId, scheduleId, memberId],
        ),
      'a freq with no interval — the kind of rule that expands wrong in silence',
    );
    assert.match(message, /event_rrule_coherent/);
  });
});

test('an override must name the occurrence it replaces', async () => {
  await withDb(async (db) => {
    const { householdId, memberId, scheduleId } = await seedHousehold(db);
    const series = await db.query<{ id: string }>(
      `insert into event (household_id, schedule_id, domain, title, starts_at, ends_at, timezone, created_by, rrule_freq, rrule_interval)
       values ($1,$2,'practice','Series', now(), now() + interval '1 hour','UTC',$3,'WEEKLY',1) returning id`,
      [householdId, scheduleId, memberId],
    );
    const message = await rejects(
      () =>
        db.query(
          `insert into event (household_id, schedule_id, domain, title, starts_at, ends_at, timezone, created_by, series_id)
           values ($1,$2,'practice','Orphan override', now(), now() + interval '1 hour','UTC',$3,$4)`,
          [householdId, scheduleId, memberId, series.rows[0]!.id],
        ),
      'a series_id with no recurrence_id',
    );
    assert.match(message, /event_override_coherent/);
  });
});

test('a snoozed reminder must have a wake time', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    const message = await rejects(
      () =>
        db.query(
          `insert into reminder (household_id, title, due_at, status)
           values ($1,'Call insurance', now(), 'snoozed')`,
          [householdId],
        ),
      'a snooze with no snoozed_until never comes back',
    );
    assert.match(message, /reminder_snooze_coherent/);
  });
});

test('money columns refuse negatives where negatives are nonsense', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    const business = await db.query<{ id: string }>(
      `insert into business (household_id, name, timezone, tax_set_aside_rate)
       values ($1,'Shia Baby','UTC',0.0825) returning id`,
      [householdId],
    );
    const businessId = business.rows[0]!.id;

    await rejects(
      () =>
        db.query(
          `insert into expense (business_id, at, vendor, category, amount_cents)
           values ($1, now(), 'Fabric Depot', 'Materials', 0)`,
          [businessId],
        ),
      'a zero-value expense',
    );
    await rejects(
      () =>
        db.query(
          `insert into expense (business_id, at, vendor, category, amount_cents)
           values ($1, now(), 'Fabric Depot', 'Materials', -500)`,
          [businessId],
        ),
      'a negative expense',
    );
    await rejects(
      () => db.query(`update business set tax_set_aside_rate = 1.5 where id = $1`, [businessId]),
      'a tax rate above 1',
    );
  });
});

test('stock may go negative — a shop really can discover it oversold', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    const b = await db.query<{ id: string }>(
      `insert into business (household_id, name, timezone) values ($1,'Shia Baby','UTC') returning id`,
      [householdId],
    );
    await db.query(
      `insert into product (business_id, sku, name, quantity_on_hand) values ($1,'BEAR-01','Teddy',-3)`,
      [b.rows[0]!.id],
    );
    const { rows } = await db.query<{ quantity_on_hand: number }>(
      `select quantity_on_hand from product`,
    );
    assert.equal(rows[0]!.quantity_on_hand, -3, 'clamping would hide a real inventory problem');
  });
});

test('an inventory movement of zero units is refused', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    const b = await db.query<{ id: string }>(
      `insert into business (household_id, name, timezone) values ($1,'Shia Baby','UTC') returning id`,
      [householdId],
    );
    const p = await db.query<{ id: string }>(
      `insert into product (business_id, sku, name) values ($1,'BEAR-01','Teddy') returning id`,
      [b.rows[0]!.id],
    );
    await rejects(
      () =>
        db.query(
          `insert into inventory_movement (business_id, product_id, kind, quantity_delta, at)
           values ($1,$2,'adjustment',0, now())`,
          [b.rows[0]!.id, p.rows[0]!.id],
        ),
      'a movement that moves nothing',
    );
  });
});

test('a shift cannot be swapped to the person giving it up', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    const b = await db.query<{ id: string }>(
      `insert into business (household_id, name, timezone) values ($1,'Shia Baby','UTC') returning id`,
      [householdId],
    );
    const businessId = b.rows[0]!.id;
    const e = await db.query<{ id: string }>(
      `insert into employee (business_id, display_name) values ($1,'Maria') returning id`,
      [businessId],
    );
    const s = await db.query<{ id: string }>(
      `insert into shift (business_id, starts_at, ends_at) values ($1, now(), now() + interval '5 hours') returning id`,
      [businessId],
    );
    await rejects(
      () =>
        db.query(
          `insert into shift_swap (business_id, shift_id, from_employee_id, to_employee_id)
           values ($1,$2,$3,$3)`,
          [businessId, s.rows[0]!.id, e.rows[0]!.id],
        ),
      'swapping a shift with yourself',
    );
  });
});

/* ------------------------------------------------------- notifications */

test('the same dedupe key cannot produce a second notification', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    const insert = (): Promise<unknown> =>
      db.query(
        `insert into notification (household_id, kind, title, body, deliver_at, dedupe_key)
         values ($1,'reminder_due','Call insurance','Due now', now(), 'same-facts')`,
        [householdId],
      );

    await insert();
    await rejects(insert, 'the same facts notifying twice');

    // …but the identical key in a DIFFERENT household is a different fact.
    const other = await seedHousehold(db);
    await db.query(
      `insert into notification (household_id, kind, title, body, deliver_at, dedupe_key)
       values ($1,'reminder_due','Call insurance','Due now', now(), 'same-facts')`,
      [other.householdId],
    );
  });
});

/* -------------------------------------------------------------- search */

test('the search tsvector is maintained by the database, not by callers', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    await db.query(
      `insert into search_document (entity, id, household_id, title, body)
       values ('event','e1',$1,'Soccer practice','Leila at Riverside Fields')`,
      [householdId],
    );

    const hit = await db.query<{ id: string }>(
      `select id from search_document
        where household_id = $1 and tsv @@ plainto_tsquery('simple', 'riverside')`,
      [householdId],
    );
    assert.deepEqual(hit.rows.map((r) => r.id), ['e1'], 'no caller had to remember to build the tsv');

    // And it is kept current on update.
    await db.query(`update search_document set title = 'Dentist appointment' where id = 'e1'`);
    const stale = await db.query<{ id: string }>(
      `select id from search_document where tsv @@ plainto_tsquery('simple', 'soccer')`,
    );
    assert.deepEqual(stale.rows, [], 'the trigger did not refresh the vector on update');
  });
});

/* --------------------------------------------------------------- auth */

test('email uniqueness is case-insensitive without needing the citext extension', async () => {
  await withDb(async (db) => {
    await db.query(
      `insert into app_user (email, display_name, password_hash) values ($1,'Elena','x')`,
      ['Elena@Example.com'],
    );
    await rejects(
      () =>
        db.query(`insert into app_user (email, display_name, password_hash) values ($1,'Impostor','y')`, [
          'elena@example.com',
        ]),
      'the same email in different case',
    );
  });
});

test('one login cannot join the same household twice, but managed profiles are exempt', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    const u = await db.query<{ id: string }>(
      `insert into app_user (email, display_name, password_hash) values ('a@b.c','Ana','x') returning id`,
    );
    const userId = u.rows[0]!.id;

    await db.query(`insert into member (household_id, user_id, display_name, role) values ($1,$2,'Ana','teen')`, [
      householdId,
      userId,
    ]);
    await rejects(
      () =>
        db.query(`insert into member (household_id, user_id, display_name, role) values ($1,$2,'Ana again','adult')`, [
          householdId,
          userId,
        ]),
      'the same login as two members of one household',
    );

    // Two managed children with no login are perfectly normal.
    await db.query(`insert into member (household_id, display_name, role) values ($1,'Noor','child')`, [householdId]);
    await db.query(`insert into member (household_id, display_name, role) values ($1,'Mateo','child')`, [householdId]);
  });
});

test('deleting a login leaves the member row, so their history is not erased', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    const u = await db.query<{ id: string }>(
      `insert into app_user (email, display_name, password_hash) values ('a@b.c','Ana','x') returning id`,
    );
    await db.query(`insert into member (household_id, user_id, display_name, role) values ($1,$2,'Ana','teen')`, [
      householdId,
      u.rows[0]!.id,
    ]);

    await db.query(`delete from app_user where id = $1`, [u.rows[0]!.id]);

    const { rows } = await db.query<{ display_name: string; user_id: string | null }>(
      `select display_name, user_id from member where display_name = 'Ana'`,
    );
    assert.equal(rows.length, 1, 'the member row must survive the login being removed');
    assert.equal(rows[0]!.user_id, null, 'and be detached from it');
  });
});

/* --------------------------------------------------------- transactions */

test('a failed transaction leaves nothing behind', async () => {
  await withDb(async (db) => {
    const { householdId } = await seedHousehold(db);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(`insert into errand (household_id, title) values ($1,'First')`, [householdId]);
        await tx.query(`insert into errand (household_id, title) values ($1,'')`, [householdId]); // blank title
      }),
    );
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from errand`);
    assert.equal(rows[0]!.n, 0, 'the first insert should have rolled back with the second');
  });
});
