/**
 * Michel-OS — the process (Agent B3).
 *
 * Everything below is startup, in a deliberate order:
 *
 *   config  →  database  →  migrations  →  routes  →  listen  →  shutdown
 *
 * The order is the point. Configuration is validated before a connection is
 * opened, so a typo in an environment variable fails in a hundred milliseconds
 * with a sentence naming the variable, rather than sixty seconds later as a
 * connection timeout. Migrations run before the socket is bound, so the first
 * request cannot arrive against a half-built schema.
 *
 * `readConfig` and `buildServerRouter` are exported and pure. A server whose
 * wiring can only be exercised by starting it is a server whose wiring is never
 * tested, and boot is exactly where a mistake is most expensive.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildApiRouter } from './api/routes.ts';
import { registerBusinessAvailabilityRoutes } from './api/business-availability.ts';
import type { AppEnv } from './api/context.ts';
import { createPostgresDb, migrate, verifyMigrations, type Db } from './db/client.ts';
import { Router, dispatch, html, problem, securityHeaders, send } from './http/core.ts';
import { cacheControlFor, resolveAsset, sendAsset } from './http/static.ts';
import { renderManifest, renderShell } from './ui/shell.ts';

/* ---------------------------------------------------------------- config */

export interface Config {
  databaseUrl: string;
  port: number;
  /** Every origin the browser may send us a form from. */
  allowedOrigins: string[];
  https: boolean;
  publicDir: string;
  /** Applied migrations are re-checksummed on boot unless this is off. */
  verifySchema: boolean;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Read and validate configuration.
 *
 * Takes the environment as an argument rather than reading `process.env`, which
 * is what makes the failure cases testable — and there are more of them here
 * than anywhere else in the codebase, because this is the layer where a human
 * typing into a `.env` file is the input.
 */
export function readConfig(source: NodeJS.ProcessEnv): Config {
  const databaseUrl = (source['DATABASE_URL'] ?? '').trim();
  if (databaseUrl.length === 0) {
    throw new ConfigError('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  const rawPort = (source['PORT'] ?? '3000').trim();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`PORT must be a number between 1 and 65535, not ${JSON.stringify(rawPort)}.`);
  }

  const rawBase = (source['BASE_URL'] ?? '').trim();
  if (rawBase.length === 0) {
    throw new ConfigError('BASE_URL is not set. It should be the address you open Michel-OS at, e.g. https://michel.example.com');
  }
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new ConfigError(`BASE_URL is not a valid URL: ${JSON.stringify(rawBase)}`);
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new ConfigError(`BASE_URL must be http or https, not ${base.protocol}`);
  }

  const https = base.protocol === 'https:';
  const allowedOrigins = [base.origin];

  for (const extra of (source['EXTRA_ORIGINS'] ?? '').split(',')) {
    const trimmed = extra.trim();
    if (trimmed.length === 0) continue;
    try {
      allowedOrigins.push(new URL(trimmed).origin);
    } catch {
      throw new ConfigError(`EXTRA_ORIGINS contains something that is not a URL: ${JSON.stringify(trimmed)}`);
    }
  }

  if (!https && source['ALLOW_INSECURE'] !== 'true') {
    throw new ConfigError(
      'BASE_URL is http, which means session cookies cannot be marked Secure. ' +
      'That is fine on a laptop and not fine on the internet. Set ALLOW_INSECURE=true to confirm this is local development.',
    );
  }

  return {
    databaseUrl,
    port,
    allowedOrigins: [...new Set(allowedOrigins)],
    https,
    publicDir: (source['PUBLIC_DIR'] ?? new URL('../public/', import.meta.url).pathname).trim(),
    verifySchema: source['SKIP_SCHEMA_VERIFY'] !== 'true',
  };
}

/* ---------------------------------------------------------------- routes */

/**
 * The API, plus the routes that only the process has: readiness and the app
 * shell fallback.
 *
 * Registration order is load-bearing. `buildApiRouter` goes first so that no
 * later catch-all can shadow an endpoint, and the shell fallback goes last for
 * the same reason in reverse.
 */
export function buildServerRouter(env: AppEnv): Router {
  const router = buildApiRouter(env);
  registerBusinessAvailabilityRoutes(router, env);

  router.get('/api/ready', async () => {
    try {
      await env.db.query('select 1');
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"ready":true}' };
    } catch {
      return problem(503, 'not_ready', 'The database is not reachable.');
    }
  });

  router.get('/manifest.webmanifest', async () => {
    const icons = await installIcons();
    return {
      status: 200,
      headers: {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'public, max-age=300, must-revalidate',
      },
      body: renderManifest(icons),
    };
  });

  router.otherwise(async (req) => {
    if (req.url.pathname === '/api' || req.url.pathname.startsWith('/api/')) {
      return problem(404, 'not_found', 'No such endpoint.');
    }

    return html(200, renderShell({ version: ASSET_VERSION }), {
      headers: { 'cache-control': 'no-cache' },
    });
  });

  return router;
}

/**
 * A version stamp for the CSS and JS URLs.
 *
 * Resolved once at startup from the icon manifest's own content, which changes
 * whenever the assets do. Not a timestamp: a timestamp changes on every restart
 * and busts the cache for clients whose files did not change at all.
 */
let ASSET_VERSION = 'dev';

interface InstallIcon { src: string; sizes: string }
let installIconCache: InstallIcon[] | null = null;

/**
 * The 192px and 512px icons an install prompt uses.
 *
 * Read from disk once and cached: a manifest request on every cold start of
 * every phone in the house should not re-read a directory.
 */
async function installIcons(): Promise<InstallIcon[]> {
  if (installIconCache !== null) return installIconCache;

  const dir = new URL('../public/icons/derived/', import.meta.url).pathname;
  try {
    const names = await readdir(dir);
    const found: InstallIcon[] = [];
    for (const size of [192, 512]) {
      const match = names.find((n) => n.startsWith(`appointments-${size}-`) && n.endsWith('.png'));
      if (match !== undefined) found.push({ src: `/icons/derived/${match}`, sizes: `${size}x${size}` });
    }
    installIconCache = found;
  } catch {
    installIconCache = [];
  }
  return installIconCache;
}

/** Stamp the asset URLs from the icon manifest's content, if it is there. */
async function resolveAssetVersion(): Promise<void> {
  const path = new URL('../public/icons/derived/manifest.json', import.meta.url).pathname;
  try {
    const bytes = await readFile(path);
    ASSET_VERSION = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  } catch {
    ASSET_VERSION = 'dev';
  }
}

/* ---------------------------------------------------------------- server */

export interface ServeOptions {
  config: Config;
  db: Db;
  now?: () => string;
}

/**
 * Build the HTTP server. Does not listen — the caller decides that, which is
 * what lets a test bind an ephemeral port and close it again.
 */
export function createHttpServer(options: ServeOptions): Server {
  const env: AppEnv = {
    db: options.db,
    now: options.now ?? ((): string => new Date().toISOString()),
    https: options.config.https,
  };

  const router = buildServerRouter(env);
  const baseHeaders = securityHeaders({ https: options.config.https });

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, { router, baseHeaders, config: options.config });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { router: Router; baseHeaders: Record<string, string>; config: Config },
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const path = new URL(req.url ?? '/', 'http://placeholder').pathname;

  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/')) {
    const asset = await resolveAsset(deps.config.publicDir, path);
    if (asset !== null) {
      const ifNoneMatch = req.headers['if-none-match'];
      sendAsset(res, asset, {
        baseHeaders: deps.baseHeaders,
        cacheControl: cacheControlFor(path),
        ...(typeof ifNoneMatch === 'string' ? { ifNoneMatch } : {}),
      });
      return;
    }
  }

  const reply = await dispatch(req, {
    router: deps.router,
    allowedOrigins: deps.config.allowedOrigins,
    https: deps.config.https,
  });
  send(res, reply, deps.baseHeaders);
}

/* ------------------------------------------------------------------ boot */

export async function boot(source: NodeJS.ProcessEnv = process.env): Promise<{ server: Server; db: Db; config: Config }> {
  const config = readConfig(source);
  const db = await createPostgresDb(config.databaseUrl);

  const applied = await migrate(db);
  if (applied.length > 0) console.log(`[boot] applied ${applied.length} migration(s): ${applied.join(', ')}`);

  if (config.verifySchema) {
    const drifted = await verifyMigrations(db);
    if (drifted.length > 0) {
      await db.close();
      throw new Error(
        `Migrations have been edited after being applied: ${drifted.join(', ')}. ` +
        'Add a new migration instead of changing an old one.',
      );
    }
  }

  await resolveAssetVersion();

  const server = createHttpServer({ config, db });
  return { server, db, config };
}

/**
 * Shut down in the order that loses the least: stop accepting connections,
 * let the ones in flight finish, then close the pool.
 */
export async function shutdown(server: Server, db: Db, timeoutMs = 10_000): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn('[shutdown] connections still open after timeout; closing anyway');
      server.closeAllConnections?.();
      resolve();
    }, timeoutMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  await db.close();
}

async function runDirectly(): Promise<void> {
  let booted: Awaited<ReturnType<typeof boot>>;
  try {
    booted = await boot();
  } catch (error) {
    console.error(`[boot] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const { server, db, config } = booted;
  server.listen(config.port, () => {
    console.log(`[boot] Michel-OS listening on port ${config.port} for ${config.allowedOrigins.join(', ')}`);
  });

  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      console.log(`[shutdown] ${signal} received`);
      void shutdown(server, db).then(() => process.exit(0));
    });
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await runDirectly();
}
