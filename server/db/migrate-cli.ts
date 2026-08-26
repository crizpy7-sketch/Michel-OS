/**
 * `npm run migrate` — apply pending migrations to the configured database.
 *
 * Run by the app container on boot before the server starts listening, and
 * runnable by hand on the VPS. Safe to run repeatedly.
 *
 * The work is an exported function rather than a bare script, so the behaviour
 * that actually matters — refusing to proceed when an applied migration has
 * been edited — is testable instead of only observable in production. The
 * bottom of the file is the thin shell that turns it into a command.
 */

import { createPostgresDb, migrate, verifyMigrations, type Db } from './client.ts';

export interface MigrateOutcome {
  code: 0 | 1 | 2;
  message: string;
  applied: string[];
}

export interface MigrateOptions {
  databaseUrl?: string | undefined;
  /** Injected so tests can run this against PGlite instead of a real server. */
  connect?: (url: string) => Promise<Db>;
  /** Injected so a test can point at a fixture directory. */
  migrationsDir?: string;
}

/**
 * Apply migrations and report what happened.
 *
 * Never throws: every failure becomes a non-zero `code` and a message, because
 * a stack trace from a boot script tells an operator less than a sentence does.
 */
export async function runMigrateCli(options: MigrateOptions = {}): Promise<MigrateOutcome> {
  const url = options.databaseUrl;
  if (url === undefined || url.trim().length === 0) {
    return { code: 2, message: 'migrate: DATABASE_URL is not set.', applied: [] };
  }

  const connect = options.connect ?? createPostgresDb;
  let db: Db;
  try {
    db = await connect(url);
  } catch (error) {
    return {
      code: 1,
      message: `migrate: could not connect — ${error instanceof Error ? error.message : String(error)}`,
      applied: [],
    };
  }

  try {
    const drifted = await verifyMigrations(db, options.migrationsDir);
    if (drifted.length > 0) {
      // An already-applied migration has been edited. Applying the rest would
      // leave this database describing itself with a file it does not match,
      // and every other environment would keep the old shape forever.
      return {
        code: 1,
        applied: [],
        message:
          `migrate: these migrations were edited after they ran: ${drifted.join(', ')}\n` +
          'Write a new migration instead of editing one that has already been applied.',
      };
    }

    const applied = await migrate(db, options.migrationsDir);
    return {
      code: 0,
      applied,
      message: applied.length === 0
        ? 'migrate: already up to date.'
        : `migrate: applied ${applied.join(', ')}`,
    };
  } catch (error) {
    return {
      code: 1,
      applied: [],
      message: `migrate: failed — ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await db.close().catch(() => {
      /* closing a broken pool must not mask the real outcome */
    });
  }
}

/* ------------------------------------------------------------------ shell */

/** True when this file was run directly, rather than imported by a test. */
function runDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry.replace(/^.*\/(?=server\/)/, ''));
}

if (runDirectly()) {
  const outcome = await runMigrateCli({ databaseUrl: process.env['DATABASE_URL'] });
  (outcome.code === 0 ? console.log : console.error)(outcome.message);
  process.exit(outcome.code);
}
