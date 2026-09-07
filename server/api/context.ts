/**
 * Request context and the authorization chokepoint (Agent B3).
 *
 * ARCHITECTURE.md §2 says "server-side authorization" and §8 says every mutation
 * is checked. This file is where that actually happens for HTTP: `guard()` is
 * the only way a route reaches the database, and it calls the same
 * `authorize()` kernel the domain modules use.
 *
 * The ordering matters and is fixed:
 *
 *   1. session       — is this a real, unexpired cookie?
 *   2. actor         — is this login a member of the household in the URL?
 *   3. authorize()   — does that member's role permit this?
 *
 * Step 2 is what makes "log in, then change the household id in the URL" a
 * dead end. Step 3 is the kernel, unchanged and un-duplicated: this file never
 * decides an access question itself, it only asks.
 *
 * `now` is resolved once per request and threaded everywhere. The domain tier
 * refuses to read the clock so that its output is reproducible; the edge is
 * where the clock legitimately lives, and reading it once per request means two
 * things computed during one request cannot disagree about what time it is.
 */

import { authorize, permissionOracle } from '../../domains/household/permissions.ts';
import type { Db } from '../db/client.ts';
import * as repo from '../db/repositories.ts';
import { resolveActor, resolveSession, type RequestActor } from '../auth/sessions.ts';
import { json, problem, type Reply, type RequestContext } from '../http/core.ts';
import type { Business, Permission, UUID } from '../../lib/contracts/index.ts';

export const SESSION_COOKIE = 'michel_session';

export interface AppEnv {
  db: Db;
  /** Injected so tests can pin it; production passes `() => new Date().toISOString()`. */
  now: () => string;
  /** False in local development so cookies work without TLS. */
  https: boolean;
  /** Validated exact release provenance. Missing/invalid values are never trusted. */
  releaseSha?: string | null;
}

/** Everything a route handler gets once the three checks have passed. */
export interface AuthedContext {
  req: RequestContext;
  env: AppEnv;
  actor: RequestActor;
  now: string;
  /** Bound to this actor and household — for UI affordances, never for decisions. */
  can: (permission: Permission) => boolean;
}

/* -------------------------------------------------------------- failures */

const UNAUTHENTICATED = problem(401, 'unauthenticated', 'Sign in to continue.');

/**
 * A household the actor is not in returns 404, not 403.
 *
 * 403 would confirm the household exists, which turns the URL into an oracle
 * for guessing valid ids. "Not found" is both true from the actor's point of
 * view and uninformative from an attacker's.
 */
const NOT_YOURS = problem(404, 'not_found', 'No such household.');

const forbidden = (permission: Permission): Reply =>
  problem(403, 'forbidden', `You do not have permission to do that (${permission}).`);

/* ----------------------------------------------------------------- guard */

export interface GuardOptions {
  /** The permission this route needs. Omit for a route that only needs membership. */
  permission?: Permission;
  /**
   * The row being acted on, for `.own` verbs. Resolved lazily because fetching
   * it costs a query that an unauthenticated request should never pay for.
   */
  resource?: (ctx: AuthedContext) => Promise<{ householdId?: UUID; createdBy?: UUID; assignedTo?: UUID } | null>;
}

/**
 * Run `handler` only if the request is authenticated, a member of the household
 * in the path, and permitted.
 *
 * The household comes from `:householdId` in the route. There is no default and
 * no "current household" in the session — a session that carried a household
 * would let a stale cookie act in a household the person has since left.
 */
export function guard(
  env: AppEnv,
  options: GuardOptions,
  handler: (ctx: AuthedContext) => Promise<Reply> | Reply,
): (req: RequestContext) => Promise<Reply> {
  return async (req: RequestContext): Promise<Reply> => {
    const now = env.now();

    const session = await resolveSession(env.db, req.cookies[SESSION_COOKIE], now);
    if (session === null) return UNAUTHENTICATED;

    const householdId = req.params['householdId'];
    if (householdId === undefined || householdId.length === 0) return NOT_YOURS;

    const actor = await resolveActor(env.db, session, householdId);
    if (actor === null) return NOT_YOURS;

    const ctx: AuthedContext = {
      req, env, actor, now,
      can: permissionOracle(actor.member, actor.household.id),
    };

    if (options.permission !== undefined) {
      const resource = options.resource ? await options.resource(ctx) : undefined;
      // A `.own` route whose row does not exist is a 404 before it is a 403:
      // otherwise the permission error confirms the id was real.
      if (options.resource !== undefined && resource === null) {
        return problem(404, 'not_found', 'That item no longer exists.');
      }

      const verdict = authorize({
        member: actor.member,
        householdId: actor.household.id,
        permission: options.permission,
        ...(resource ? { resource } : {}),
      });
      if (!verdict.allowed) {
        // `tenant` denials are reported as 404 for the same reason as above.
        return verdict.code === 'tenant' ? NOT_YOURS : forbidden(options.permission);
      }
    }

    return handler(ctx);
  };
}

/**
 * A route that needs a signed-in user but no household — account settings, the
 * household list, accepting an invitation.
 */
export function guardUser(
  env: AppEnv,
  handler: (ctx: { req: RequestContext; env: AppEnv; now: string; session: NonNullable<Awaited<ReturnType<typeof resolveSession>>> }) => Promise<Reply> | Reply,
): (req: RequestContext) => Promise<Reply> {
  return async (req: RequestContext): Promise<Reply> => {
    const now = env.now();
    const session = await resolveSession(env.db, req.cookies[SESSION_COOKIE], now);
    if (session === null) return UNAUTHENTICATED;
    return handler({ req, env, now, session });
  };
}

/* ------------------------------------------------------------ validation */

/**
 * Read a required string field from the body.
 *
 * Returns `null` rather than throwing so a handler can collect every problem in
 * one pass — a form that reports its errors one per submit is a form people
 * abandon.
 */
export function str(body: Record<string, unknown> | null, key: string, max = 500): string | null {
  const value = body?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

export function optionalStr(body: Record<string, unknown> | null, key: string, max = 2000): string | undefined {
  const value = str(body, key, max);
  return value === null ? undefined : value;
}

export function int(body: Record<string, unknown> | null, key: string): number | null {
  const raw = body?.[key];

  // An empty or blank string is ABSENT, not zero. `Number('')` is 0, which
  // meant an untouched form field arrived as a real value: an empty quantity
  // box became a movement of zero units rather than a 422 asking for a number.
  if (typeof raw === 'string' && raw.trim().length === 0) return null;

  const value = typeof raw === 'string' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** An ISO instant, or null. Accepts what `<input type="datetime-local">` sends. */
export function instantField(body: Record<string, unknown> | null, key: string, timezone: string): string | null {
  const raw = body?.[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const value = raw.trim();

  // Already an instant.
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  // `2026-09-07T16:00` from a datetime-local input: local wall time in the
  // household's zone, which is NOT the same as UTC and not the same as the
  // server's zone either. Converting it here is the only place that knows both.
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value);
  if (match === null) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  return localToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, timezone);
}

/**
 * Local wall-clock fields in a named zone to a UTC instant.
 *
 * Two passes so a time on a DST boundary lands correctly: the first correction
 * can itself cross the jump.
 */
export function localToInstant(
  fields: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): string | null {
  // Range-check before converting. `Date.UTC` rolls over silently, so a typed
  // `2026-13-45T99:99` used to become a real instant in February 2027 — an
  // event eight months from where the person meant it, saved with a 201.
  if (!inRange(fields)) return null;

  const naive = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, 0, 0);
  if (!Number.isFinite(naive)) return null;

  let guess = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = readZoned(guess, timezone);
    if (seen === null) return null;
    const drift = naive - seen;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess).toISOString();
}

/**
 * Are these fields a real calendar date and wall-clock time?
 *
 * Day-of-month is checked against the actual month, so 31 April is refused
 * rather than becoming 1 May. The year bound is deliberately wide but finite:
 * a four-digit typo should not create a row the calendar then has to expand
 * across.
 */
function inRange(fields: { year: number; month: number; day: number; hour: number; minute: number }): boolean {
  const { year, month, day, hour, minute } = fields;
  if (![year, month, day, hour, minute].every(Number.isInteger)) return false;
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  // Day 0 of month N+1 is the last day of month N.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function readZoned(ms: number, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- business */

/**
 * The household's business, or a 404 reply.
 *
 * CR-009 in one function: business scope is always established FROM the
 * household rather than taken from the request, so a business id in a URL can
 * never select somebody else's shop.
 */
export async function requireBusiness(
  ctx: AuthedContext,
): Promise<{ ok: true; business: Business } | { ok: false; reply: Reply }> {
  const business = await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id);
  if (business === null) {
    return {
      ok: false,
      reply: problem(404, 'no_business', 'This household has no Shia Baby business set up yet.'),
    };
  }
  return { ok: true, business };
}

/* ------------------------------------------------------------- helpers */

export const ok = (value: unknown): Reply => json(200, value);
export const created = (value: unknown): Reply => json(201, value);

/**
 * Turn a domain `Result` rejection into an HTTP reply.
 *
 * The issue codes the domain modules use map onto status codes: `permission`
 * and `tenant` are the kernel's, everything else is the caller's fault.
 */
export function fromIssues(issues: ReadonlyArray<{ code: string; path: string; message: string }>): Reply {
  if (issues.some((i) => i.code === 'tenant')) return NOT_YOURS;
  if (issues.some((i) => i.code === 'permission')) {
    return problem(403, 'forbidden', issues.find((i) => i.code === 'permission')!.message);
  }
  return json(422, {
    error: {
      code: 'invalid',
      message: 'That could not be saved.',
      // Every problem at once: a form should not report them one per submit.
      issues: issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
    },
  });
}
