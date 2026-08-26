/**
 * Michel-OS — database client (Agent B-backend).
 *
 * One narrow interface, two implementations, and the SAME SQL through both:
 *
 *   - `pg` against real PostgreSQL, which is what runs on the VPS;
 *   - PGlite — real PostgreSQL compiled to WebAssembly, in-process — which is
 *     what the tests run.
 *
 * That second one is the whole reason this file exists in this shape. The build
 * container has no Docker daemon, so a Postgres container cannot be started to
 * test against (ADR-001). The alternative to PGlite would have been mocking the
 * database, which means shipping SQL that was never executed — a constraint
 * that never fired, a cascade that never cascaded, a query with a typo in a
 * column name that only production discovers. Every migration and every query
 * in this codebase is executed by a real Postgres engine before it ships.
 *
 * The interface is deliberately tiny: `query` and `transaction`. No query
 * builder, no ORM, no lazy-loading. The domain tier is already pure and
 * already decides everything; this layer only has to move rows.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/* ---------------------------------------------------------------- types */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Anything that can run SQL: the pool, or a client inside a transaction.
 *
 * Repositories take this rather than the pool, which is what lets the same
 * repository function be called standalone or as part of a larger transaction
 * without knowing which.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /**
   * Run SQL that may contain several statements, with no parameters.
   *
   * Separate from `query` because a parameterised query is a PREPARED
   * statement, and Postgres refuses multiple commands in one of those. DDL and
   * migrations need the simple query protocol; everything carrying user data
   * must use `query` so its values are bound rather than interpolated. Keeping
   * them as two methods means no caller can reach for string concatenation to
   * get a multi-statement script through.
   */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /**
   * Run `fn` inside a transaction. Commits on return, rolls back on throw.
   *
   * There is no "maybe commit" and no nesting: a nested call reuses the
   * outer transaction rather than opening a savepoint, because partial commits
   * in a family calendar are worse than a clean failure.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------ postgres */

/**
 * The production client. `pg` is imported lazily so that the test path — which
 * never touches it — does not require it to be installed or a server to exist.
 */
export async function createPostgresDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');

  // BIGINT arrives as a string by default because it can exceed Number's safe
  // range. Every bigint in this schema is money in minor units or a byte size,
  // both far inside 2^53, so parsing to Number here keeps the repositories from
  // having to remember. If a column ever genuinely needs the full range this
  // must be revisited rather than silently truncating.
  pg.types.setTypeParser(20, (value: string) => Number(value));
  // NUMERIC likewise: the only numeric column is a 0..1 rate.
  pg.types.setTypeParser(1700, (value: string) => Number(value));

  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pool error with no listener is an uncaught exception that takes the
  // process down; a dropped backend connection should not do that.
  pool.on('error', (error: Error) => {
    console.error('[db] idle client error:', error.message);
  });

  return {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      const result = await pool.query(sql, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async exec(sql: string): Promise<void> {
      // No parameter array at all: that is what selects the simple query
      // protocol, which permits multiple statements.
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const tx: Queryable = {
          async query<R>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
            const result = await client.query(sql, params as unknown[]);
            return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
          },
          async exec(inner: string): Promise<void> {
            await client.query(inner);
          },
        };
        const value = await fn(tx);
        await client.query('commit');
        return value;
      } catch (error) {
        await client.query('rollback').catch(() => {
          /* the connection is already broken; the original error is the useful one */
        });
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/* -------------------------------------------------------------- pglite */

/**
 * The test client: real PostgreSQL, in this process, backed by memory.
 *
 * PGlite is single-connection, so `transaction` serialises rather than checking
 * out a client. That is a genuine difference from production and it is stated
 * here rather than hidden: concurrency behaviour (lock contention, deadlocks,
 * serialisation failures) is NOT exercised by these tests and has to be
 * verified on the VPS.
 */
export async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = await new PGlite();

  let chain: Promise<unknown> = Promise.resolve();

  const run = async <T>(sql: string, params: readonly unknown[]): Promise<QueryResult<T>> => {
    const result = await pglite.query(sql, params as unknown[]);
    // `rows.length` is NOT the row count: an INSERT/UPDATE without RETURNING
    // yields no rows but does affect some, and reporting 0 there made
    // `on conflict do nothing` look like it had always conflicted. Prefer the
    // driver's own affected-row count and fall back to the row count only when
    // it is absent.
    const affected = (result as { affectedRows?: number }).affectedRows;
    return {
      rows: result.rows as T[],
      rowCount: typeof affected === 'number' && affected > 0 ? affected : result.rows.length,
    };
  };

  const exec = async (sql: string): Promise<void> => {
    await pglite.exec(sql);
  };

  return {
    query: run,
    exec,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      // Serialise transactions against the single connection so two concurrent
      // callers cannot interleave their statements into one another's BEGIN.
      const previous = chain;
      let release!: () => void;
      chain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous.catch(() => {
        /* a previous caller's failure must not poison this one */
      });

      try {
        await pglite.exec('begin');
        const value = await fn({ query: run, exec });
        await pglite.exec('commit');
        return value;
      } catch (error) {
        await pglite.exec('rollback').catch(() => {});
        throw error;
      } finally {
        release();
      }
    },
    async close(): Promise<void> {
      await pglite.close();
    },
  };
}

/* ----------------------------------------------------------- migrations */

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url).pathname;

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const name of entries) {
    migrations.push({ name, sql: await readFile(join(dir, name), 'utf8') });
  }
  return migrations;
}

/**
 * Apply every migration that has not run yet, in filename order.
 *
 * Each migration runs inside its own transaction and records itself in the same
 * transaction, so a migration that fails halfway leaves no partial schema and
 * no false record of having succeeded. Applied migrations are never re-run and
 * never re-read from disk — an edited migration that has already run is a
 * mistake, and `verifyMigrations` reports it rather than silently diverging.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migration (
      name        text primary key,
      applied_at  timestamptz not null default now(),
      checksum    text not null
    )
  `);

  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migration')).rows.map((r) => r.name),
  );

  const ran: string[] = [];
  for (const migration of await loadMigrations(dir)) {
    if (applied.has(migration.name)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('insert into schema_migration (name, checksum) values ($1, $2)', [
        migration.name,
        checksum(migration.sql),
      ]);
    });
    ran.push(migration.name);
  }
  return ran;
}

/**
 * Has an already-applied migration been edited since it ran?
 *
 * Editing a migration that has run means the schema on this machine and the
 * schema the file describes have quietly diverged — every environment that
 * applied the old version keeps it forever, and nothing tells you. Cheap to
 * check on boot, so the server does.
 */
export async function verifyMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const rows = (
    await db.query<{ name: string; checksum: string }>('select name, checksum from schema_migration')
  ).rows;
  const recorded = new Map(rows.map((r) => [r.name, r.checksum]));

  const drifted: string[] = [];
  for (const migration of await loadMigrations(dir)) {
    const was = recorded.get(migration.name);
    if (was !== undefined && was !== checksum(migration.sql)) drifted.push(migration.name);
  }
  return drifted;
}

function checksum(sql: string): string {
  // Normalised so that a line-ending change between a Windows checkout and the
  // Linux container does not read as a schema edit.
  const normalised = sql.replace(/\r\n/g, '\n').trimEnd();
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < normalised.length; i += 1) {
    const ch = normalised.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (((h2 >>> 0) * 4294967296 + (h1 >>> 0)) >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0');
}

/* ----------------------------------------------------------- test helper */

/** A migrated, empty database for one test. */
export async function createTestDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}
