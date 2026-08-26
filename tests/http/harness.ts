/**
 * A real Michel-OS server, on a real socket, for one test file (Agent B3).
 *
 * These tests drive the app over HTTP with `fetch` rather than calling handlers
 * directly. That is slower and it is worth it: calling a handler skips
 * `dispatch`, which is where CSRF, the body limit, cookie parsing and the
 * security headers live. A test that skips those proves the handler works and
 * says nothing about whether the application does — and the interesting
 * failures in a family calendar are exactly the ones at that boundary.
 *
 * The clock is injected and mutable so a test can advance it. Nothing under
 * `server/` reads the clock itself, so pinning it here pins it everywhere.
 */

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTestDb, type Db } from '../../server/db/client.ts';
import { createHttpServer, readConfig, type Config } from '../../server/main.ts';

export const ORIGIN_HOST = '127.0.0.1';

export interface Harness {
  base: string;
  db: Db;
  config: Config;
  /** Move the injected clock. Everything computed afterwards sees the new time. */
  setNow: (iso: string) => void;
  now: () => string;
  close: () => Promise<void>;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  /** Session cookie value, if any. `Agent.token` is the usual source. */
  token?: string | undefined;
  headers?: Record<string, string>;
  /**
   * Omit the `Origin` header entirely. Only a test that is specifically about
   * CSRF should do this — everything else should look like a browser.
   */
  noOrigin?: boolean;
  /** Send a hostile origin, for the same reason. */
  origin?: string;
}

export interface Response_<T> {
  status: number;
  body: T;
  headers: Headers;
  /** The session cookie this response set, if it set one. */
  setCookie: string | undefined;
}

export async function startHarness(options: { now?: string } = {}): Promise<Harness> {
  const db = await createTestDb();

  let current = options.now ?? '2026-09-07T12:00:00.000Z';

  // Through `readConfig` rather than a hand-built object, so the tests exercise
  // the same validation a deploy does. A config shape that only tests use is a
  // config shape whose failures only production discovers.
  const config = readConfig({
    DATABASE_URL: 'postgres://unused/in-tests',
    BASE_URL: `http://${ORIGIN_HOST}`,
    ALLOW_INSECURE: 'true',
    PORT: '3000',
    PUBLIC_DIR: new URL('../fixtures/public/', import.meta.url).pathname,
  } as NodeJS.ProcessEnv);

  const server = createHttpServer({ config, db, now: () => current });
  server.listen(0, ORIGIN_HOST);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  // The real origin is only known after binding, and the CSRF check compares
  // against this exact array. Pushing into it — rather than handing the tests a
  // corrected copy — means the allowlist the tests reason about IS the one the
  // server enforces; a copy would let every Origin test pass for the wrong
  // reason.
  config.allowedOrigins.push(`http://${ORIGIN_HOST}:${port}`);

  return {
    base: `http://${ORIGIN_HOST}:${port}`,
    db,
    config,
    setNow: (iso: string): void => { current = iso; },
    now: (): string => current,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

/**
 * One request.
 *
 * `Sec-Fetch-Site: same-origin` is sent by default because that is what a real
 * browser sends for a fetch from the app's own page, and testing against
 * anything else would make the CSRF check a decoration.
 */
export async function call<T = unknown>(
  h: Harness, path: string, options: CallOptions = {},
): Promise<Response_<T>> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    'sec-fetch-site': 'same-origin',
    ...(options.noOrigin ? {} : { origin: options.origin ?? h.base }),
    ...(options.token !== undefined ? { cookie: `michel_session=${options.token}` } : {}),
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${h.base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: 'manual',
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  return {
    status: response.status,
    body: parsed as T,
    headers: response.headers,
    setCookie: response.headers.get('set-cookie') ?? undefined,
  };
}

/** The session token out of a Set-Cookie header, or `undefined`. */
export function tokenFrom(setCookie: string | undefined): string | undefined {
  if (setCookie === undefined) return undefined;
  const match = /michel_session=([^;]*)/.exec(setCookie);
  const value = match?.[1];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export interface Agent {
  token: string;
  userId: string;
  householdId: string;
  memberId: string;
  email: string;
}

/** Register a user who owns a brand-new household. */
export async function registerOwner(
  h: Harness, options: { email?: string; householdName?: string; timezone?: string } = {},
): Promise<Agent> {
  const email = options.email ?? `owner-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const response = await call<{
    user: { id: string }; household: { id: string }; member: { id: string };
  }>(h, '/api/auth/register', {
    method: 'POST',
    body: {
      email,
      password: 'a-long-enough-passphrase-42',
      displayName: 'Owner',
      householdName: options.householdName ?? 'The Michels',
      timezone: options.timezone ?? 'America/New_York',
    },
  });

  if (response.status !== 201) {
    throw new Error(`registerOwner failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const token = tokenFrom(response.setCookie);
  if (token === undefined) throw new Error('registerOwner returned no session cookie');

  return {
    token,
    userId: response.body.user.id,
    householdId: response.body.household.id,
    memberId: response.body.member.id,
    email,
  };
}

/**
 * Invite somebody into `owner`'s household and register them against it.
 *
 * Goes through the real invitation flow rather than inserting a member row,
 * because "can a teen see the ledger" is only a meaningful test if the teen
 * arrived the way a teen actually arrives.
 */
export async function joinHousehold(
  h: Harness, owner: Agent, role: string, options: { email?: string; displayName?: string } = {},
): Promise<Agent> {
  const invitation = await call<{ token: string }>(
    h, `/api/households/${owner.householdId}/invitations`,
    { method: 'POST', token: owner.token, body: { role } },
  );
  if (invitation.status !== 201) {
    throw new Error(`invite failed: ${invitation.status} ${JSON.stringify(invitation.body)}`);
  }

  const email = options.email ?? `${role}-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const response = await call<{ user: { id: string }; household: { id: string }; member: { id: string } }>(
    h, '/api/auth/register',
    {
      method: 'POST',
      body: {
        email,
        password: 'another-long-enough-passphrase-42',
        displayName: options.displayName ?? `A ${role}`,
        joinToken: invitation.body.token,
      },
    },
  );
  if (response.status !== 201) {
    throw new Error(`join failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const token = tokenFrom(response.setCookie);
  if (token === undefined) throw new Error('join returned no session cookie');

  return {
    token,
    userId: response.body.user.id,
    householdId: response.body.household.id,
    memberId: response.body.member.id,
    email,
  };
}
