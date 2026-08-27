/**
 * Migration CLI tests (Agent B2).
 *
 * The behaviour worth testing here is not "migrations apply" — the schema suite
 * covers that. It is what the command does when something is WRONG, because
 * this runs unattended on container boot and its failure modes are the ones an
 * operator meets at the worst moment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMigrateCli } from '../../server/db/migrate-cli.ts';
import { createPgliteDb, type Db } from '../../server/db/client.ts';

/** Hand the CLI a PGlite database instead of a real server. */
function pgliteConnector(): { connect: (url: string) => Promise<Db>; current: () => Db | null } {
  let db: Db | null = null;
  return {
    connect: async () => {
      // Reuse the same instance across calls so a second run sees the first
      // run's `schema_migration` rows, which is the whole point of the
      // idempotence test below.
      if (db === null) db = await createPgliteDb();
      // The CLI closes what it is given; hand it a non-closing façade so the
      // test can keep inspecting the database afterwards.
      const shared = db;
      return { ...shared, close: async () => {} };
    },
    current: () => db,
  };
}

test('with no DATABASE_URL it exits 2 and says so, rather than connecting to nothing', async () => {
  const outcome = await runMigrateCli({ databaseUrl: undefined });
  assert.equal(outcome.code, 2);
  assert.match(outcome.message, /DATABASE_URL is not set/);
  assert.deepEqual(outcome.applied, []);

  const blank = await runMigrateCli({ databaseUrl: '   ' });
  assert.equal(blank.code, 2, 'whitespace is not a connection string');
});

test('a first run applies the schema and reports what it did', async () => {
  const { connect } = pgliteConnector();
  const outcome = await runMigrateCli({ databaseUrl: 'pglite://test', connect });
  assert.equal(outcome.code, 0, outcome.message);
  assert.deepEqual(outcome.applied, ['001_initial.sql', '002_removals.sql']);
  assert.match(outcome.message, /applied 001_initial\.sql/);
});

test('a second run is a clean no-op — safe to run on every container boot', async () => {
  const { connect } = pgliteConnector();
  await runMigrateCli({ databaseUrl: 'pglite://test', connect });

  const second = await runMigrateCli({ databaseUrl: 'pglite://test', connect });
  assert.equal(second.code, 0);
  assert.deepEqual(second.applied, []);
  assert.match(second.message, /already up to date/);
});

test('an edited migration stops the boot instead of half-applying a divergent schema', async () => {
  const { connect, current } = pgliteConnector();
  await runMigrateCli({ databaseUrl: 'pglite://test', connect });

  // Somebody edits a migration that already shipped.
  const db = current()!;
  await db.query(`update schema_migration set checksum = 'tampered' where name = $1`, [
    '001_initial.sql',
  ]);

  const outcome = await runMigrateCli({ databaseUrl: 'pglite://test', connect });
  assert.equal(outcome.code, 1, 'this must not be treated as success');
  assert.match(outcome.message, /edited after they ran/);
  assert.match(outcome.message, /Write a new migration instead/, 'the message should say what to do');
  assert.deepEqual(outcome.applied, [], 'nothing may be applied once drift is detected');
});

test('a connection failure is a sentence and exit 1, not a stack trace', async () => {
  const outcome = await runMigrateCli({
    databaseUrl: 'postgres://nobody@127.0.0.1:1/nothing',
    connect: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:1');
    },
  });
  assert.equal(outcome.code, 1);
  assert.match(outcome.message, /could not connect/);
  assert.match(outcome.message, /ECONNREFUSED/, 'the operator still needs the underlying cause');
});

test('a failure during migration is reported rather than thrown', async () => {
  const outcome = await runMigrateCli({
    databaseUrl: 'pglite://test',
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      exec: async () => {
        throw new Error('disk full');
      },
      transaction: async <T>(fn: (tx: never) => Promise<T>): Promise<T> => fn(undefined as never),
      close: async () => {},
    }),
  });
  assert.equal(outcome.code, 1);
  assert.match(outcome.message, /failed — disk full/);
});
