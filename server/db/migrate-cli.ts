/**
 * `npm run migrate` — apply pending migrations to the configured database.
 *
 * Run by the app container on boot before the server starts listening, and
 * runnable by hand on the VPS. Safe to run repeatedly: already-applied
 * migrations are skipped.
 *
 * Exits non-zero on failure so a container that cannot migrate does not go on
 * to serve requests against a schema it does not understand.
 */

import { createPostgresDb, migrate, verifyMigrations } from './client.ts';

const url = process.env['DATABASE_URL'];

if (url === undefined || url.trim().length === 0) {
  console.error('migrate: DATABASE_URL is not set.');
  process.exit(2);
}

const db = await createPostgresDb(url);

try {
  const drifted = await verifyMigrations(db);
  if (drifted.length > 0) {
    // An already-applied migration has been edited. Applying the rest would
    // leave this database describing itself with a file it does not match, and
    // every other environment would keep the old shape forever.
    console.error(
      `migrate: these migrations were edited after they ran: ${drifted.join(', ')}\n` +
        'Write a new migration instead of editing one that has already been applied.',
    );
    process.exit(1);
  }

  const ran = await migrate(db);
  console.log(ran.length === 0 ? 'migrate: already up to date.' : `migrate: applied ${ran.join(', ')}`);
} catch (error) {
  console.error('migrate: failed —', error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await db.close();
}
