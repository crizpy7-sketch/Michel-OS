import 'server-only';

/**
 * Process-wide store. Seeded once, held on globalThis so Next's dev server
 * keeps the same database across hot reloads instead of resetting the family's
 * week on every keystroke.
 */
import { SqliteRepository } from './sqlite.ts';
import { seed, HOUSEHOLD_ID, BUSINESS_ID } from './seed.ts';
import type { Repository } from './repository.ts';

const KEY = Symbol.for('michel-os.repository');
type Global = typeof globalThis & { [KEY]?: SqliteRepository };

export function getRepository(): Repository {
  const g = globalThis as Global;
  if (!g[KEY]) {
    const repo = new SqliteRepository(process.env.MICHEL_DB ?? ':memory:');
    seed(repo);
    g[KEY] = repo;
  }
  return g[KEY];
}

export { HOUSEHOLD_ID, BUSINESS_ID };
export type { Repository };
