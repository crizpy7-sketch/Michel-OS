/**
 * The API tier (Agent B3).
 *
 * Every route here is the same three-step shape, and the shape is the design:
 *
 *     guard(env, { permission })      →  the kernel decides
 *       → a domain engine             →  the rules decide
 *         → a repository              →  rows move
 *
 * No route reimplements a rule. `detectConflicts`, `expandOccurrences`,
 * `analyzeSchedule`, `validateAction` and the rest already exist, are tested,
 * and are the only place their logic lives — this file's job is to feed them
 * real rows and persist what they return.
 *
 * The one thing that IS decided here is which entities a search may touch, and
 * that is computed from `authorize()` rather than from the request, because a
 * client that could name its own entity list could name `expense`.
 */

import { Router, json, noContent, problem, redirect, type Reply } from '../http/core.ts';
import {
  created, fromIssues, guard, guardUser, instantField, int, ok, optionalStr,
  requireBusiness, str, type AppEnv, type AuthedContext,
} from './context.ts';
import * as repo from '../db/repositories.ts';
import { SESSION_COOKIE } from './context.ts';

import { expandOccurrences } from '../../domains/scheduling/recurrence.ts';
import { detectConflicts, explainConflict } from '../../domains/scheduling/conflicts.ts';
import { validateAction } from '../../domains/ai/validator.ts';
import { classifyInboxItem } from '../../domains/ai/inbox.ts';
import { buildMorningBrief, summarizeBrief } from '../../domains/ai/brief.ts';
import {
  addShoppingItem, clusterErrandsByLocation, completeReminder, createErrand,
  createReminder, dismissReminder, dueReminders, groupByStore, setErrandStatus,
  setShoppingStatus, snoozeReminder,
} from '../../domains/personal/lists.ts';
import {
  acceptSwap, analyzeSchedule, approveSwap, assignShift, publishSchedule, reviewTimeOff,
} from '../../domains/shia-baby/staffing.ts';
import {
  estimateTaxSetAside, lowStockAlerts, recordExpense, recordMovement, recordSale,
  reconcileInventory, summarizeExpenses, summarizeSales,
} from '../../domains/shia-baby/ledger.ts';
import { conflictsDetected, lowStock, remindersDue, materializeNotification } from '../../domains/platform/notifications.ts';
import {
  endAllSessions, endSession, login, previewInvitation, register, resolveSession,
  acceptInvitation, changePassword, createInvitation, SESSION_TTL_MS,
} from '../auth/sessions.ts';
import type {
  DomainKey, Occurrence, RecurrenceRule, Role, SearchEntity, ShoppingStatus, ErrandStatus,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- constants */

/** Which search entities each permission unlocks. Computed, never client-supplied. */
const SEARCHABLE: ReadonlyArray<{ entity: SearchEntity; permission: 'event.read' | 'business.read' | 'finance.read' }> = [
  { entity: 'event', permission: 'event.read' },
  { entity: 'reminder', permission: 'event.read' },
  { entity: 'errand', permission: 'event.read' },
  { entity: 'shopping_item', permission: 'event.read' },
  { entity: 'inbox_item', permission: 'event.read' },
  { entity: 'member', permission: 'event.read' },
  { entity: 'employee', permission: 'business.read' },
  { entity: 'product', permission: 'business.read' },
  { entity: 'expense', permission: 'finance.read' },
];

const DOMAIN_LABEL: Readonly<Record<DomainKey, string>> = {
  appointments: 'Appointments', practice: 'Practice', competition: 'Competition',
  games: 'Games', school: 'School', errands: 'Errands', shopping: 'Shopping',
  reminders: 'Reminders', work: 'Hubby Work', 'shia-baby': 'Shia Baby',
  inbox: 'Inbox', general: 'General',
};

const sessionCookie = (value: string, env: AppEnv, maxAgeSeconds: number) => ({
  name: SESSION_COOKIE, value, httpOnly: true, secure: env.https,
  sameSite: 'Lax' as const, path: '/', maxAgeSeconds,
});

/* ---------------------------------------------------------- occurrences */

/**
 * Expand a window into occurrences, with participants attached.
 *
 * Every calendar view goes through here, so "mini-apps are views over one
 * engine" (PRODUCT_SPEC §2) is structural rather than a promise: the Practice
 * screen and All Schedules call the same function with a different `domains`
 * filter.
 */
async function occurrencesFor(
  ctx: AuthedContext,
  window: { from: string; to: string },
  domains?: readonly DomainKey[],
): Promise<{ occurrences: Occurrence[]; participants: Array<{ eventId: string; memberId: string; role: 'attendee' | 'responsible' | 'optional' }> }> {
  const events = await repo.listEventsForWindow(ctx.env.db, ctx.actor.household.id, window,
    domains ? { domains } : {});
  const participants = await repo.listParticipants(
    ctx.env.db, ctx.actor.household.id, events.map((e) => e.id),
  );

  const byEvent = new Map<string, string[]>();
  for (const row of participants) {
    const bucket = byEvent.get(row.eventId);
    if (bucket) bucket.push(row.memberId);
    else byEvent.set(row.eventId, [row.memberId]);
  }

  // Overrides are separate rows in the same result set; hand each series its own.
  const overrides = events.filter((e) => e.seriesId !== undefined);
  const bases = events.filter((e) => e.seriesId === undefined);

  const occurrences: Occurrence[] = [];
  for (const event of bases) {
    occurrences.push(
      ...expandOccurrences(event, window, {
        participantIds: byEvent.get(event.id) ?? [],
        overrides: overrides.filter((o) => o.seriesId === event.id),
      }),
    );
  }
  occurrences.sort((a, b) =>
    a.occurrenceStart === b.occurrenceStart
      ? (a.eventId < b.eventId ? -1 : 1)
      : (a.occurrenceStart < b.occurrenceStart ? -1 : 1),
  );

  return { occurrences, participants };
}

/** Conflicts for a window, from the real engine over the real roster. */
async function conflictsFor(ctx: AuthedContext, window: { from: string; to: string }) {
  const { occurrences, participants } = await occurrencesFor(ctx, window);
  const members = await repo.listMembers(ctx.env.db, ctx.actor.household.id);

  const business = await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id);
  const shifts = business === null
    ? []
    : await repo.listShifts(ctx.env.db, ctx.actor.household.id, business.id, window);
  const employees = business === null
    ? []
    : await repo.listEmployees(ctx.env.db, ctx.actor.household.id, business.id);

  const employeeMemberIds: Record<string, string> = {};
  for (const employee of employees) {
    if (employee.memberId !== null) employeeMemberIds[employee.id] = employee.memberId;
  }

  return detectConflicts({
    householdId: ctx.actor.household.id,
    occurrences,
    participants,
    shifts,
    employeeMemberIds,
    minorMemberIds: members.filter((m) => m.role === 'child').map((m) => m.id),
    timezone: ctx.actor.household.timezone,
    memberNames: Object.fromEntries(members.map((m) => [m.id, m.displayName])),
  });
}

/** A sane default window: today through four weeks out, in household time. */
function defaultWindow(now: string, days = 28): { from: string; to: string } {
  const start = Date.parse(now) - 24 * 3600_000;
  return { from: new Date(start).toISOString(), to: new Date(start + days * 24 * 3600_000).toISOString() };
}

function windowFromQuery(ctx: AuthedContext): { from: string; to: string } {
  const from = ctx.req.query.get('from');
  const to = ctx.req.query.get('to');
  if (from !== null && to !== null && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))) {
    const span = Date.parse(to) - Date.parse(from);
    // A caller asking for a decade would expand a million occurrences; cap it.
    if (span > 0 && span <= 400 * 24 * 3600_000) {
      return { from: new Date(Date.parse(from)).toISOString(), to: new Date(Date.parse(to)).toISOString() };
    }
  }
  return defaultWindow(ctx.now);
}

/* ================================================================ routes */

export function buildApiRouter(env: AppEnv): Router {
  const r = new Router();

  /* ------------------------------------------------------------- health */

  r.get('/api/health', async () => {
    // Touches the database on purpose: a health check that only proves the
    // process is alive is the kind that stays green through an outage.
    try {
      await env.db.query('select 1');
      return json(200, { ok: true });
    } catch {
      return problem(503, 'unavailable', 'The database is not reachable.');
    }
  });

  /* --------------------------------------------------------------- auth */

  r.post('/api/auth/register', async (req) => {
    const email = str(req.body, 'email', 320);
    const password = typeof req.body?.['password'] === 'string' ? String(req.body['password']) : '';
    const displayName = str(req.body, 'displayName', 120);
    const joinToken = optionalStr(req.body, 'joinToken', 200);
    const householdName = str(req.body, 'householdName', 120);
    const timezone = optionalStr(req.body, 'timezone', 64) ?? 'UTC';

    if (email === null || displayName === null) {
      return problem(422, 'invalid', 'An email and a name are required.');
    }
    if (joinToken === undefined && householdName === null) {
      return problem(422, 'invalid', 'Either create a household or supply an invitation.');
    }

    const result = await register(env.db, {
      email, password, displayName, now: env.now(),
      household: joinToken !== undefined
        ? { joinToken }
        : { create: { name: householdName!, timezone } },
    });

    if (!result.ok) {
      const status = result.reason === 'email_taken' ? 409 : 422;
      return problem(status, result.reason,
        'message' in result ? result.message : 'That registration could not be completed.');
    }

    return json(201, {
      user: result.value.user,
      household: result.value.household,
      member: result.value.member,
    }, { cookies: [sessionCookie(result.value.token, env, SESSION_TTL_MS / 1000)] });
  });

  r.post('/api/auth/login', async (req) => {
    const email = str(req.body, 'email', 320);
    const password = typeof req.body?.['password'] === 'string' ? String(req.body['password']) : '';
    if (email === null) {
      return problem(401, 'invalid_credentials', 'That email and password do not match.');
    }

    const userAgent = typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent'].slice(0, 300) : undefined;
    const result = await login(env.db, { email, password, now: env.now(), ...(userAgent ? { userAgent } : {}) });
    if (!result.ok) {
      // One message for every failure — see the auth suite for why.
      return problem(401, 'invalid_credentials', 'That email and password do not match.');
    }

    const households = await repo.listHouseholdsForUser(env.db, result.value.user.id);
    return json(200, {
      user: result.value.user,
      households: households.map((h) => ({ household: h.household, role: h.member.role })),
    }, { cookies: [sessionCookie(result.value.token, env, SESSION_TTL_MS / 1000)] });
  });

  r.post('/api/auth/logout', async (req) => {
    const session = await resolveSession(env.db, req.cookies[SESSION_COOKIE], env.now());
    if (session !== null) await endSession(env.db, session.sessionId);
    // Clear the cookie regardless, so a stale one does not linger.
    return json(200, { ok: true }, { cookies: [sessionCookie('', env, 0)] });
  });

  r.post('/api/auth/logout-everywhere', guardUser(env, async ({ env: e, session }) => {
    const ended = await endAllSessions(e.db, session.user.id);
    return json(200, { sessionsEnded: ended }, { cookies: [sessionCookie('', e, 0)] });
  }));

  r.get('/api/me', guardUser(env, async ({ env: e, session }) => {
    const households = await repo.listHouseholdsForUser(e.db, session.user.id);
    return ok({
      user: session.user,
      households: households.map((h) => ({
        household: h.household, member: h.member, role: h.member.role,
      })),
    });
  }));

  r.post('/api/me/password', guardUser(env, async ({ req, env: e, session }) => {
    const current = typeof req.body?.['currentPassword'] === 'string' ? String(req.body['currentPassword']) : '';
    const next = typeof req.body?.['newPassword'] === 'string' ? String(req.body['newPassword']) : '';
    const result = await changePassword(e.db, {
      userId: session.user.id, currentPassword: current, newPassword: next,
      keepSessionId: session.sessionId,
    });
    if (!result.ok) {
      return problem(result.reason === 'weak_password' ? 422 : 401, result.reason,
        'message' in result ? result.message : 'That password could not be changed.');
    }
    return ok(result.value);
  }));

  /* -------------------------------------------------------- invitations */

  r.get('/api/invitations/:token', async (req) => {
    const result = await previewInvitation(env.db, req.params['token'] ?? '', env.now());
    if (!result.ok) return problem(404, result.reason, 'That invitation is not usable.');
    return ok(result.value);
  });

  r.post('/api/invitations/:token/accept', guardUser(env, async ({ req, env: e, session, now }) => {
    const result = await acceptInvitation(e.db, {
      token: req.params['token'] ?? '', user: session.user, now,
    });
    if (!result.ok) return problem(404, result.reason, 'That invitation is not usable.');
    return ok({ household: result.value.household, member: result.value.member });
  }));

  r.post('/api/households/:householdId/invitations',
    guard(env, { permission: 'member.manage' }, async (ctx) => {
      const role = str(ctx.req.body, 'role', 20) as Role | null;
      const allowed: Role[] = ['owner', 'adult', 'teen', 'child', 'employee', 'viewer'];
      if (role === null || !allowed.includes(role)) {
        return problem(422, 'invalid', 'Pick a role for the person you are inviting.');
      }
      // Only an owner may mint another owner: `member.manage` alone must not be
      // a path to granting yourself a peer who can remove you.
      if (role === 'owner' && ctx.actor.member.role !== 'owner') {
        return problem(403, 'forbidden', 'Only an owner can invite another owner.');
      }

      const invitation = await createInvitation(ctx.env.db, {
        householdId: ctx.actor.household.id, createdBy: ctx.actor.member.id, role,
        now: ctx.now, ...(optionalStr(ctx.req.body, 'email', 320) ? { email: optionalStr(ctx.req.body, 'email', 320)! } : {}),
      });
      // The token is returned exactly once; only its hash is stored.
      return created(invitation);
    }));

  /* ---------------------------------------------------------- household */

  /**
   * Start a second household, or a first one for somebody who arrived by
   * invitation and then lost it.
   *
   * `guardUser`, not `guard`: there is no household to be a member of yet, so
   * the only check available is that this is a real signed-in person. The
   * creator becomes its owner in the same transaction, which is what stops a
   * household from ever existing with nobody able to administer it.
   */
  r.post('/api/households', guardUser(env, async ({ req, env: e, session }) => {
    const name = str(req.body, 'name', 120);
    if (name === null) return problem(422, 'invalid', 'A household needs a name.');

    const timezone = optionalStr(req.body, 'timezone', 64) ?? 'UTC';
    if (!isKnownTimezone(timezone)) {
      return problem(422, 'invalid', 'That is not a timezone this server knows.');
    }

    const result = await e.db.transaction(async (tx) => {
      const household = await repo.createHousehold(tx, { name, timezone });
      const member = await repo.createMember(tx, {
        householdId: household.id, displayName: session.user.displayName,
        role: 'owner', userId: session.user.id,
      });
      return { household, member };
    });
    return created(result);
  }));

  r.get('/api/households/:householdId', guard(env, {}, async (ctx) =>
    ok({
      household: ctx.actor.household,
      member: ctx.actor.member,
      members: await repo.listMembers(ctx.env.db, ctx.actor.household.id),
      schedules: await repo.listSchedules(ctx.env.db, ctx.actor.household.id),
      business: await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id),
    })));

  r.get('/api/households/:householdId/members', guard(env, { permission: 'event.read' },
    async (ctx) => ok(await repo.listMembers(ctx.env.db, ctx.actor.household.id))));

  r.post('/api/households/:householdId/members',
    guard(env, { permission: 'member.manage' }, async (ctx) => {
      const displayName = str(ctx.req.body, 'displayName', 120);
      const role = str(ctx.req.body, 'role', 20) as Role | null;
      if (displayName === null || role === null) {
        return problem(422, 'invalid', 'A name and a role are required.');
      }
      if (role === 'owner' && ctx.actor.member.role !== 'owner') {
        return problem(403, 'forbidden', 'Only an owner can add another owner.');
      }
      // A managed profile: a member row with no login, for a young child.
      const member = await ctx.env.db.transaction((tx) =>
        repo.createMember(tx, {
          householdId: ctx.actor.household.id, displayName, role,
          ...(optionalStr(ctx.req.body, 'color', 40) ? { color: optionalStr(ctx.req.body, 'color', 40)! } : {}),
        }));
      return created(member);
    }));

  r.patch('/api/households/:householdId/members/:memberId',
    guard(env, { permission: 'member.manage' }, async (ctx) => {
      const memberId = ctx.req.params['memberId']!;
      const existing = await repo.getMember(ctx.env.db, ctx.actor.household.id, memberId);
      if (existing === null) return problem(404, 'not_found', 'No such member.');

      const role = str(ctx.req.body, 'role', 20) as Role | null;
      const active = typeof ctx.req.body?.['active'] === 'boolean' ? Boolean(ctx.req.body['active']) : undefined;

      if (role === 'owner' && ctx.actor.member.role !== 'owner') {
        return problem(403, 'forbidden', 'Only an owner can promote someone to owner.');
      }

      // The one integrity rule the API enforces itself: a household must keep
      // at least one active owner, or nobody can ever administer it again.
      const losingAnOwner = existing.role === 'owner' &&
        ((role !== null && role !== 'owner') || active === false);
      if (losingAnOwner && (await repo.countActiveOwners(ctx.env.db, ctx.actor.household.id)) <= 1) {
        return problem(409, 'last_owner',
          'This is the only owner. Make someone else an owner first.');
      }

      const updated = await ctx.env.db.transaction((tx) =>
        repo.updateMember(tx, ctx.actor.household.id, memberId, {
          ...(str(ctx.req.body, 'displayName', 120) ? { displayName: str(ctx.req.body, 'displayName', 120)! } : {}),
          ...(role ? { role } : {}),
          ...(active === undefined ? {} : { active }),
        }));
      return ok(updated);
    }));

  /* ------------------------------------------------------------- events */

  r.get('/api/households/:householdId/occurrences', guard(env, { permission: 'event.read' },
    async (ctx) => {
      const window = windowFromQuery(ctx);
      const domainParam = ctx.req.query.get('domain');
      const domains = domainParam === null
        ? undefined
        : (domainParam.split(',').filter((d) => d in DOMAIN_LABEL) as DomainKey[]);
      const { occurrences } = await occurrencesFor(ctx, window, domains);

      const memberFilter = ctx.req.query.get('member');
      const filtered = memberFilter === null
        ? occurrences
        : occurrences.filter((o) => o.participantIds.includes(memberFilter));

      return ok({ window, occurrences: filtered });
    }));

  r.post('/api/households/:householdId/events', guard(env, { permission: 'event.create' },
    async (ctx) => {
      const body = ctx.req.body;
      const title = str(body, 'title', 200);
      const domain = (str(body, 'domain', 30) ?? 'general') as DomainKey;
      if (title === null) return problem(422, 'invalid', 'An event needs a title.');
      if (!(domain in DOMAIN_LABEL)) return problem(422, 'invalid', 'Unknown mini-app.');

      const timezone = optionalStr(body, 'timezone', 64) ?? ctx.actor.household.timezone;
      const startsAt = instantField(body, 'startsAt', timezone);
      const endsAt = instantField(body, 'endsAt', timezone);
      if (startsAt === null || endsAt === null) {
        return problem(422, 'invalid', 'A start and end time are required.');
      }
      if (Date.parse(endsAt) <= Date.parse(startsAt)) {
        return problem(422, 'invalid', 'The end time must be after the start time.');
      }

      const rawParticipants = body?.['participantIds'];
      const participantIds = Array.isArray(rawParticipants)
        ? rawParticipants.filter((p): p is string => typeof p === 'string')
        : typeof rawParticipants === 'string' ? [rawParticipants] : [];
      const responsible = new Set(
        Array.isArray(body?.['responsibleIds'])
          ? (body!['responsibleIds'] as unknown[]).filter((p): p is string => typeof p === 'string')
          : typeof body?.['responsibleIds'] === 'string' ? [String(body['responsibleIds'])] : [],
      );

      // A participant id from the request must be a member of THIS household.
      const members = await repo.listMembers(ctx.env.db, ctx.actor.household.id);
      const known = new Set(members.map((m) => m.id));
      if (participantIds.some((p) => !known.has(p))) {
        return problem(422, 'invalid', 'One of those people is not in this household.');
      }

      const recurrence = parseRecurrence(body);
      if (recurrence === 'invalid') {
        return problem(422, 'invalid', 'That repeat rule could not be understood.');
      }

      const event = await ctx.env.db.transaction(async (tx) => {
        const schedule = await repo.ensureSchedule(tx, ctx.actor.household.id, domain, DOMAIN_LABEL[domain]);
        const saved = await repo.createEvent(tx, {
          householdId: ctx.actor.household.id,
          scheduleId: schedule.id,
          domain, title,
          ...(optionalStr(body, 'notes') ? { notes: optionalStr(body, 'notes')! } : {}),
          ...(optionalStr(body, 'location', 200) ? { location: optionalStr(body, 'location', 200)! } : {}),
          startsAt, endsAt, timezone,
          allDay: body?.['allDay'] === true || body?.['allDay'] === 'on',
          createdBy: ctx.actor.member.id,
          ...(recurrence ? { recurrence } : {}),
          participants: participantIds.map((memberId) => ({
            memberId,
            role: responsible.has(memberId) ? ('responsible' as const) : ('attendee' as const),
          })),
        });
        await repo.writeAudit(tx, {
          householdId: ctx.actor.household.id, actorMemberId: ctx.actor.member.id,
          action: 'event.create', entity: 'event', entityId: saved.id, after: { title, domain },
        });
        return saved;
      });

      return created(event);
    }));

  r.delete('/api/households/:householdId/events/:eventId',
    guard(env, {
      permission: 'event.delete.own',
      resource: async (ctx) => {
        const event = await repo.getEvent(ctx.env.db, ctx.actor.household.id, ctx.req.params['eventId']!);
        return event === null ? null : { householdId: event.householdId, createdBy: event.createdBy };
      },
    }, async (ctx) => {
      const eventId = ctx.req.params['eventId']!;
      const scope = ctx.req.query.get('scope') === 'series' ? 'series' : 'occurrence';
      const occurrenceStart = ctx.req.query.get('occurrenceStart') ?? undefined;

      const done = await ctx.env.db.transaction(async (tx) => {
        const result = await repo.cancelEvent(tx, ctx.actor.household.id, eventId, scope, occurrenceStart);
        if (result) {
          await repo.writeAudit(tx, {
            householdId: ctx.actor.household.id, actorMemberId: ctx.actor.member.id,
            action: 'event.cancel', entity: 'event', entityId: eventId, after: { scope, occurrenceStart },
          });
        }
        return result;
      });
      return done ? noContent() : problem(404, 'not_found', 'No such event.');
    }));

  /* ---------------------------------------------------------- conflicts */

  r.get('/api/households/:householdId/conflicts', guard(env, { permission: 'event.read' },
    async (ctx) => {
      const conflicts = await conflictsFor(ctx, windowFromQuery(ctx));
      return ok({
        conflicts: conflicts.map((c) => ({ ...c, explanation: explainConflict(c) })),
      });
    }));

  /* -------------------------------------------------------- morning brief */

  r.get('/api/households/:householdId/brief', guard(env, { permission: 'event.read' },
    async (ctx) => {
      const window = defaultWindow(ctx.now, 9);
      const { occurrences } = await occurrencesFor(ctx, window);
      const conflicts = await conflictsFor(ctx, window);
      const reminders = await repo.listReminders(ctx.env.db, ctx.actor.household.id,
        { status: ['pending', 'sent', 'snoozed'] });
      const errands = await repo.listErrands(ctx.env.db, ctx.actor.household.id,
        { status: ['open', 'in_progress'] });
      const shoppingItems = await repo.listShoppingItems(ctx.env.db, ctx.actor.household.id,
        { status: ['needed'] });

      // Staffing warnings come from J1 rather than being recomputed here.
      let staffingWarnings: string[] = [];
      const business = await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id);
      if (business !== null && ctx.can('business.read')) {
        const shifts = await repo.listShifts(ctx.env.db, ctx.actor.household.id, business.id, window);
        const employees = await repo.listEmployees(ctx.env.db, ctx.actor.household.id, business.id);
        staffingWarnings = analyzeSchedule({
          businessId: business.id, employees, shifts, window,
          timezone: business.timezone,
        }).warnings.map((w) => w.message);
      }

      const brief = buildMorningBrief({
        householdId: ctx.actor.household.id,
        now: ctx.now,
        timezone: ctx.actor.household.timezone,
        memberName: ctx.actor.member.displayName,
        occurrences, conflicts, reminders, errands, shoppingItems, staffingWarnings,
      });
      return ok({ brief, summary: summarizeBrief(brief) });
    }));

  /* ------------------------------------------------------------ shopping */

  r.get('/api/households/:householdId/shopping', guard(env, { permission: 'event.read' },
    async (ctx) => {
      const items = await repo.listShoppingItems(ctx.env.db, ctx.actor.household.id);
      return ok({ items, byStore: groupByStore(items) });
    }));

  r.post('/api/households/:householdId/shopping', guard(env, { permission: 'event.create' },
    async (ctx) => {
      const name = str(ctx.req.body, 'name', 200);
      if (name === null) return problem(422, 'invalid', 'What do you need?');

      // Agent I decides; this route only persists what it returns.
      const result = addShoppingItem({
        id: 'pending', householdId: ctx.actor.household.id, actor: ctx.actor.member, name,
        ...(int(ctx.req.body, 'quantity') !== null ? { quantity: int(ctx.req.body, 'quantity')! } : {}),
        ...(optionalStr(ctx.req.body, 'store', 120) ? { store: optionalStr(ctx.req.body, 'store', 120)! } : {}),
        ...(optionalStr(ctx.req.body, 'category', 60) ? { category: optionalStr(ctx.req.body, 'category', 60)! } : {}),
        ...(optionalStr(ctx.req.body, 'listName', 80) ? { listName: optionalStr(ctx.req.body, 'listName', 80)! } : {}),
      });
      if (!result.ok) return fromIssues(result.issues);

      const { id: _discard, ...withoutId } = result.value;
      const saved = await ctx.env.db.transaction((tx) => repo.insertShoppingItem(tx, withoutId));
      return created(saved);
    }));

  r.patch('/api/households/:householdId/shopping/:itemId', guard(env, { permission: 'event.create' },
    async (ctx) => {
      const item = await repo.getShoppingItem(ctx.env.db, ctx.actor.household.id, ctx.req.params['itemId']!);
      if (item === null) return problem(404, 'not_found', 'No such item.');

      const status = str(ctx.req.body, 'status', 20) as ShoppingStatus | null;
      if (status === null) return problem(422, 'invalid', 'A status is required.');

      const result = setShoppingStatus(item, status, ctx.actor.member);
      if (!result.ok) return fromIssues(result.issues);
      return ok(await ctx.env.db.transaction((tx) => repo.saveShoppingItem(tx, result.value)));
    }));

  /* ------------------------------------------------------------- errands */

  r.get('/api/households/:householdId/errands', guard(env, { permission: 'event.read' },
    async (ctx) => {
      const errands = await repo.listErrands(ctx.env.db, ctx.actor.household.id);
      return ok({ errands, clusters: clusterErrandsByLocation(errands) });
    }));

  r.post('/api/households/:householdId/errands', guard(env, { permission: 'event.create' },
    async (ctx) => {
      const title = str(ctx.req.body, 'title', 200);
      if (title === null) return problem(422, 'invalid', 'An errand needs a title.');
      const dueAt = instantField(ctx.req.body, 'dueAt', ctx.actor.household.timezone);

      const result = createErrand({
        id: 'pending', householdId: ctx.actor.household.id, actor: ctx.actor.member, title,
        ...(dueAt !== null ? { dueAt } : {}),
        ...(optionalStr(ctx.req.body, 'location', 200) ? { location: optionalStr(ctx.req.body, 'location', 200)! } : {}),
        ...(optionalStr(ctx.req.body, 'assignedTo', 64) ? { assignedTo: optionalStr(ctx.req.body, 'assignedTo', 64)! } : {}),
      });
      if (!result.ok) return fromIssues(result.issues);

      const { id: _discard, ...withoutId } = result.value;
      return created(await ctx.env.db.transaction((tx) => repo.insertErrand(tx, withoutId)));
    }));

  r.patch('/api/households/:householdId/errands/:errandId', guard(env, {}, async (ctx) => {
    const errand = await repo.getErrand(ctx.env.db, ctx.actor.household.id, ctx.req.params['errandId']!);
    if (errand === null) return problem(404, 'not_found', 'No such errand.');

    const status = str(ctx.req.body, 'status', 20) as ErrandStatus | null;
    if (status === null) return problem(422, 'invalid', 'A status is required.');

    // Agent I calls the kernel itself, with `assignedTo` for the `.own` test.
    const result = setErrandStatus(errand, status, ctx.actor.member);
    if (!result.ok) return fromIssues(result.issues);
    return ok(await ctx.env.db.transaction((tx) => repo.saveErrand(tx, result.value)));
  }));

  /* ----------------------------------------------------------- reminders */

  r.get('/api/households/:householdId/reminders', guard(env, { permission: 'event.read' },
    async (ctx) => {
      const reminders = await repo.listReminders(ctx.env.db, ctx.actor.household.id);
      return ok({ reminders, due: dueReminders(reminders, ctx.now) });
    }));

  r.post('/api/households/:householdId/reminders', guard(env, { permission: 'event.create' },
    async (ctx) => {
      const title = str(ctx.req.body, 'title', 200);
      const dueAt = instantField(ctx.req.body, 'dueAt', ctx.actor.household.timezone);
      if (title === null || dueAt === null) {
        return problem(422, 'invalid', 'A reminder needs a title and a time.');
      }

      const result = createReminder({
        id: 'pending', householdId: ctx.actor.household.id, actor: ctx.actor.member, title, dueAt,
        ...(optionalStr(ctx.req.body, 'assignedTo', 64) ? { assignedTo: optionalStr(ctx.req.body, 'assignedTo', 64)! } : {}),
      });
      if (!result.ok) return fromIssues(result.issues);

      const { id: _discard, ...withoutId } = result.value;
      return created(await ctx.env.db.transaction((tx) => repo.insertReminder(tx, withoutId)));
    }));

  r.post('/api/households/:householdId/reminders/:reminderId/complete', guard(env, {}, async (ctx) => {
    const reminder = await repo.getReminder(ctx.env.db, ctx.actor.household.id, ctx.req.params['reminderId']!);
    if (reminder === null) return problem(404, 'not_found', 'No such reminder.');

    // A recurring reminder needs an id for its successor; the domain module
    // refuses to invent one, so the caller mints it here at the edge.
    const nextId = crypto.randomUUID();
    const result = completeReminder(reminder, ctx.actor.member, { now: ctx.now, nextId });
    if (!result.ok) return fromIssues(result.issues);

    return ok(await ctx.env.db.transaction(async (tx) => {
      const saved = await repo.saveReminder(tx, result.value.reminder);
      let next = null;
      if (result.value.next !== null) {
        const { id: _drop, ...rest } = result.value.next;
        next = await repo.insertReminder(tx, rest);
      }
      return { reminder: saved, next };
    }));
  }));

  r.post('/api/households/:householdId/reminders/:reminderId/snooze', guard(env, {}, async (ctx) => {
    const reminder = await repo.getReminder(ctx.env.db, ctx.actor.household.id, ctx.req.params['reminderId']!);
    if (reminder === null) return problem(404, 'not_found', 'No such reminder.');

    const until = instantField(ctx.req.body, 'until', ctx.actor.household.timezone)
      ?? new Date(Date.parse(ctx.now) + 3600_000).toISOString();
    const result = snoozeReminder(reminder, ctx.actor.member, { until, now: ctx.now });
    if (!result.ok) return fromIssues(result.issues);
    return ok(await ctx.env.db.transaction((tx) => repo.saveReminder(tx, result.value)));
  }));

  r.post('/api/households/:householdId/reminders/:reminderId/dismiss', guard(env, {}, async (ctx) => {
    const reminder = await repo.getReminder(ctx.env.db, ctx.actor.household.id, ctx.req.params['reminderId']!);
    if (reminder === null) return problem(404, 'not_found', 'No such reminder.');
    const result = dismissReminder(reminder, ctx.actor.member);
    if (!result.ok) return fromIssues(result.issues);
    return ok(await ctx.env.db.transaction((tx) => repo.saveReminder(tx, result.value)));
  }));

  /* --------------------------------------------------------------- inbox */

  r.get('/api/households/:householdId/inbox', guard(env, { permission: 'event.read' },
    async (ctx) => ok({ items: await repo.listInboxItems(ctx.env.db, ctx.actor.household.id) })));

  /**
   * Capture and classify. The classification is RECORDED, never acted on:
   * ARCHITECTURE.md §3 ends at "user confirmation when required", and the
   * confirm step is a separate request a person makes.
   */
  r.post('/api/households/:householdId/inbox', guard(env, { permission: 'event.create' },
    async (ctx) => {
      const rawText = str(ctx.req.body, 'text', 4000);
      if (rawText === null) return problem(422, 'invalid', 'Type something to file.');

      const members = await repo.listMembers(ctx.env.db, ctx.actor.household.id);
      const business = await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id);
      const employees = business === null
        ? []
        : await repo.listEmployees(ctx.env.db, ctx.actor.household.id, business.id);

      return created(await ctx.env.db.transaction(async (tx) => {
        const item = await repo.insertInboxItem(tx, {
          householdId: ctx.actor.household.id, rawText, capturedBy: ctx.actor.member.id,
        });

        const classification = classifyInboxItem(item, {
          householdId: ctx.actor.household.id,
          now: ctx.now,
          timezone: ctx.actor.household.timezone,
          members: members.map((m) => ({ id: m.id, displayName: m.displayName })),
          employees: employees.map((e) => ({ id: e.id, displayName: e.displayName })),
        });

        // The proposal still meets the validator, so a confirmation screen can
        // show what would actually happen rather than what was merely guessed.
        const verdict = validateAction(classification.proposal, {
          householdId: ctx.actor.household.id,
          actorMemberId: ctx.actor.member.id,
          now: ctx.now,
          can: ctx.can,
        });

        await repo.classifyInboxItemRow(tx, ctx.actor.household.id, item.id,
          classification.domain, { proposal: classification.proposal, verdict: verdict.decision });
        await repo.recordAiAction(tx, {
          householdId: ctx.actor.household.id, actorMemberId: ctx.actor.member.id,
          proposal: classification.proposal, verdict: verdict.decision,
        });

        return {
          item: { ...item, suggestedDomain: classification.domain, status: 'classified' },
          classification: {
            domain: classification.domain,
            confidence: classification.confidence,
            signals: classification.signals,
            when: classification.when,
          },
          verdict: {
            decision: verdict.decision,
            errors: verdict.errors,
            requiresConfirmationBecause: verdict.requiresConfirmationBecause ?? [],
          },
        };
      }));
    }));

  /* -------------------------------------------------------------- search */

  r.get('/api/households/:householdId/search', guard(env, { permission: 'event.read' },
    async (ctx) => {
      const query = ctx.req.query.get('q') ?? '';
      // The entity list is DERIVED from the actor's permissions. A client that
      // could name its own list could name `expense`.
      const entities = SEARCHABLE.filter((s) => ctx.can(s.permission)).map((s) => s.entity);
      const business = await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id);

      const hits = await repo.searchDocuments(ctx.env.db, ctx.actor.household.id, query, entities, {
        limit: 25, ...(business !== null ? { businessId: business.id } : {}),
      });
      return ok({ query, hits });
    }));

  /* ------------------------------------------------------- notifications */

  r.get('/api/households/:householdId/notifications', guard(env, {}, async (ctx) =>
    ok({
      notifications: await repo.listNotifications(
        ctx.env.db, ctx.actor.household.id, ctx.actor.member.id, ctx.now,
      ),
    })));

  r.post('/api/households/:householdId/notifications/:id/read', guard(env, {}, async (ctx) => {
    const marked = await ctx.env.db.transaction((tx) =>
      repo.markNotificationRead(tx, ctx.actor.household.id, ctx.actor.member.id,
        ctx.req.params['id']!, ctx.now));
    return marked ? noContent() : problem(404, 'not_found', 'No such notification.');
  }));

  /**
   * Regenerate notifications from current facts.
   *
   * Idempotent by construction: every draft carries a dedupe key derived only
   * from the facts, and the unique index turns a repeat into a no-op. Safe to
   * call on every page load, which is what makes it usable without a scheduler.
   */
  r.post('/api/households/:householdId/notifications/refresh', guard(env, { permission: 'event.read' },
    async (ctx) => {
      const window = defaultWindow(ctx.now, 9);
      const conflicts = await conflictsFor(ctx, window);
      const reminders = await repo.listReminders(ctx.env.db, ctx.actor.household.id,
        { status: ['pending', 'sent'] });

      const drafts = [
        ...remindersDue(reminders, ctx.actor.household.id, ctx.now),
        ...conflictsDetected(conflicts, ctx.actor.household.id, ctx.now),
      ];

      const business = await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id);
      if (business !== null && ctx.can('business.read')) {
        const products = await repo.listProducts(ctx.env.db, ctx.actor.household.id, business.id);
        drafts.push(...lowStock(lowStockAlerts(business.id, products), ctx.actor.household.id, ctx.now));
      }

      const createdCount = await ctx.env.db.transaction((tx) =>
        repo.upsertNotifications(tx, drafts.map((d) => materializeNotification('unused', d))));
      return ok({ created: createdCount, considered: drafts.length });
    }));

  /* ------------------------------------------------------------ business */

  r.post('/api/households/:householdId/business', guard(env, { permission: 'household.manage' },
    async (ctx) => {
      const existing = await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id);
      if (existing !== null) return problem(409, 'exists', 'This household already has a business.');
      const name = str(ctx.req.body, 'name', 120);
      if (name === null) return problem(422, 'invalid', 'The business needs a name.');
      const rateRaw = ctx.req.body?.['taxSetAsideRate'];
      const rate = typeof rateRaw === 'string' ? Number(rateRaw) : typeof rateRaw === 'number' ? rateRaw : 0;
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        return problem(422, 'invalid', 'The set-aside rate must be between 0 and 1.');
      }
      return created(await ctx.env.db.transaction((tx) =>
        repo.createBusiness(tx, {
          householdId: ctx.actor.household.id, name,
          timezone: optionalStr(ctx.req.body, 'timezone', 64) ?? ctx.actor.household.timezone,
          taxSetAsideRate: rate,
        })));
    }));

  r.get('/api/households/:householdId/business', guard(env, { permission: 'business.read' },
    async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;
      const { business } = found;
      const window = windowFromQuery(ctx);

      const employees = await repo.listEmployees(ctx.env.db, ctx.actor.household.id, business.id);
      const shifts = await repo.listShifts(ctx.env.db, ctx.actor.household.id, business.id, window);
      const products = await repo.listProducts(ctx.env.db, ctx.actor.household.id, business.id);
      const analysis = analyzeSchedule({
        businessId: business.id, employees, shifts, window, timezone: business.timezone,
        availability: await repo.listAvailability(ctx.env.db, ctx.actor.household.id, business.id),
        timeOff: await repo.listTimeOff(ctx.env.db, ctx.actor.household.id, business.id),
      });

      return ok({
        business, employees, shifts, products,
        warnings: analysis.warnings,
        hoursByEmployee: analysis.hoursByEmployee,
        lowStock: lowStockAlerts(business.id, products),
      });
    }));

  r.post('/api/households/:householdId/business/employees',
    guard(env, { permission: 'business.manage' }, async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;
      const displayName = str(ctx.req.body, 'displayName', 120);
      if (displayName === null) return problem(422, 'invalid', 'The employee needs a name.');
      const rate = int(ctx.req.body, 'hourlyRateCents');

      return created(await ctx.env.db.transaction((tx) =>
        repo.insertEmployee(tx, ctx.actor.household.id, {
          businessId: found.business.id, displayName,
          ...(rate !== null && rate >= 0 ? { hourlyRateCents: rate } : {}),
        })));
    }));

  r.post('/api/households/:householdId/business/shifts',
    guard(env, { permission: 'employee.schedule' }, async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;
      const { business } = found;

      const startsAt = instantField(ctx.req.body, 'startsAt', business.timezone);
      const endsAt = instantField(ctx.req.body, 'endsAt', business.timezone);
      if (startsAt === null || endsAt === null) {
        return problem(422, 'invalid', 'A shift needs a start and an end.');
      }

      const employeeId = optionalStr(ctx.req.body, 'employeeId', 64);
      const created_ = await ctx.env.db.transaction((tx) =>
        repo.insertShift(tx, ctx.actor.household.id, {
          businessId: business.id, startsAt, endsAt,
          ...(employeeId ? { employeeId } : {}),
          ...(optionalStr(ctx.req.body, 'role', 60) ? { role: optionalStr(ctx.req.body, 'role', 60)! } : {}),
        }));
      if (created_ === null) return problem(404, 'not_found', 'No such business.');

      // If an employee was named, run the real assignment rules over it.
      if (employeeId !== undefined) {
        const employees = await repo.listEmployees(ctx.env.db, ctx.actor.household.id, business.id);
        const employee = employees.find((e) => e.id === employeeId);
        if (employee === undefined) return problem(422, 'invalid', 'No such employee.');

        const assignment = assignShift({
          shift: created_, employee, actor: ctx.actor.member,
          householdId: ctx.actor.household.id, businessId: business.id,
          timezone: business.timezone,
          existingShifts: await repo.listShifts(ctx.env.db, ctx.actor.household.id, business.id, {
            from: new Date(Date.parse(startsAt) - 7 * 24 * 3600_000).toISOString(),
            to: new Date(Date.parse(endsAt) + 7 * 24 * 3600_000).toISOString(),
          }),
          availability: await repo.listAvailability(ctx.env.db, ctx.actor.household.id, business.id),
          timeOff: await repo.listTimeOff(ctx.env.db, ctx.actor.household.id, business.id),
        });
        if (!assignment.ok) return fromIssues(assignment.issues);

        const saved = await ctx.env.db.transaction((tx) =>
          repo.saveShift(tx, ctx.actor.household.id, assignment.value.shift));
        return created({ shift: saved, warnings: assignment.value.warnings });
      }

      return created({ shift: created_, warnings: [] });
    }));

  r.post('/api/households/:householdId/business/publish',
    guard(env, { permission: 'employee.schedule' }, async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;
      const { business } = found;
      const window = windowFromQuery(ctx);

      const result = publishSchedule({
        businessId: business.id,
        employees: await repo.listEmployees(ctx.env.db, ctx.actor.household.id, business.id),
        shifts: await repo.listShifts(ctx.env.db, ctx.actor.household.id, business.id, window),
        availability: await repo.listAvailability(ctx.env.db, ctx.actor.household.id, business.id),
        timeOff: await repo.listTimeOff(ctx.env.db, ctx.actor.household.id, business.id),
        window, timezone: business.timezone,
        actor: ctx.actor.member, householdId: ctx.actor.household.id,
        force: ctx.req.body?.['force'] === true || ctx.req.body?.['force'] === 'on',
      });
      if (!result.ok) return fromIssues(result.issues);

      await ctx.env.db.transaction(async (tx) => {
        for (const shift of result.value.shifts) {
          await repo.saveShift(tx, ctx.actor.household.id, shift);
        }
      });
      return ok({ published: result.value.shifts.length, warnings: result.value.warnings });
    }));

  /* ----------------------------------------------------------- inventory */

  r.post('/api/households/:householdId/business/products',
    guard(env, { permission: 'business.manage' }, async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;
      const sku = str(ctx.req.body, 'sku', 60);
      const name = str(ctx.req.body, 'name', 200);
      if (sku === null || name === null) return problem(422, 'invalid', 'A SKU and a name are required.');

      return created(await ctx.env.db.transaction((tx) =>
        repo.insertProduct(tx, ctx.actor.household.id, {
          businessId: found.business.id, sku, name,
          quantityOnHand: int(ctx.req.body, 'quantityOnHand') ?? 0,
          reorderPoint: Math.max(0, int(ctx.req.body, 'reorderPoint') ?? 0),
          unitCost: Math.max(0, int(ctx.req.body, 'unitCostCents') ?? 0),
          unitPrice: Math.max(0, int(ctx.req.body, 'unitPriceCents') ?? 0),
        })));
    }));

  r.post('/api/households/:householdId/business/inventory',
    guard(env, { permission: 'business.manage' }, async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;

      const productId = str(ctx.req.body, 'productId', 64);
      const kind = str(ctx.req.body, 'kind', 20);
      const delta = int(ctx.req.body, 'quantityDelta');
      if (productId === null || kind === null || delta === null) {
        return problem(422, 'invalid', 'A product, a movement kind and a quantity are required.');
      }

      const products = await repo.listProducts(ctx.env.db, ctx.actor.household.id, found.business.id);
      const product = products.find((p) => p.id === productId);
      if (product === undefined) return problem(404, 'not_found', 'No such product.');

      const result = recordMovement({
        id: 'pending', businessId: found.business.id, product, actor: ctx.actor.member,
        householdId: ctx.actor.household.id, kind: kind as never, quantityDelta: delta, at: ctx.now,
      });
      if (!result.ok) return fromIssues(result.issues);

      return created(await ctx.env.db.transaction(async (tx) => {
        const { id: _drop, ...movement } = result.value.movement;
        await repo.insertMovement(tx, ctx.actor.household.id, movement);
        const saved = await repo.saveProduct(tx, ctx.actor.household.id, result.value.product);
        return { product: saved };
      }));
    }));

  r.get('/api/households/:householdId/business/inventory', guard(env, { permission: 'business.read' },
    async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;
      const products = await repo.listProducts(ctx.env.db, ctx.actor.household.id, found.business.id);
      const movements = await repo.listMovements(ctx.env.db, ctx.actor.household.id, found.business.id);
      return ok({
        products,
        lowStock: lowStockAlerts(found.business.id, products),
        drift: reconcileInventory(found.business.id, products, movements),
      });
    }));

  /* ------------------------------------------------------ sales/expenses */

  r.post('/api/households/:householdId/business/sales', guard(env, { permission: 'finance.manage' },
    async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;

      const rawItems = ctx.req.body?.['items'];
      const items = Array.isArray(rawItems)
        ? rawItems.map((i) => {
            const line = i as Record<string, unknown>;
            return {
              productId: String(line['productId'] ?? ''),
              quantity: Number(line['quantity'] ?? 0),
              unitPriceCents: Number(line['unitPriceCents'] ?? 0),
            };
          })
        : [];

      const result = recordSale({
        id: 'pending', businessId: found.business.id, actor: ctx.actor.member,
        householdId: ctx.actor.household.id, at: ctx.now, items,
        ...(int(ctx.req.body, 'taxCollectedCents') !== null
          ? { taxCollectedCents: int(ctx.req.body, 'taxCollectedCents')! } : {}),
      });
      if (!result.ok) return fromIssues(result.issues);

      return created(await ctx.env.db.transaction(async (tx) => {
        const { id: _drop, ...sale } = result.value.sale;
        const saved = await repo.insertSale(tx, ctx.actor.household.id, sale);
        // The stock movements the sale implies, applied in the same transaction.
        for (const movement of result.value.movements) {
          await repo.insertMovement(tx, ctx.actor.household.id, movement);
        }
        const products = await repo.listProducts(tx, ctx.actor.household.id, found.business.id);
        for (const line of result.value.sale.items) {
          const product = products.find((p) => p.id === line.productId);
          if (product !== undefined) {
            await repo.saveProduct(tx, ctx.actor.household.id, {
              ...product, quantityOnHand: product.quantityOnHand - line.quantity,
            });
          }
        }
        return { sale: saved, totalCents: result.value.totalCents };
      }));
    }));

  r.post('/api/households/:householdId/business/expenses', guard(env, { permission: 'finance.manage' },
    async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;

      const vendor = str(ctx.req.body, 'vendor', 200);
      const category = str(ctx.req.body, 'category', 80);
      const amountCents = int(ctx.req.body, 'amountCents');
      if (vendor === null || category === null || amountCents === null) {
        return problem(422, 'invalid', 'A vendor, category and amount are required.');
      }

      const result = recordExpense({
        id: 'pending', businessId: found.business.id, actor: ctx.actor.member,
        householdId: ctx.actor.household.id, at: ctx.now, vendor, category, amountCents,
        ...(optionalStr(ctx.req.body, 'description') ? { description: optionalStr(ctx.req.body, 'description')! } : {}),
      });
      if (!result.ok) return fromIssues(result.issues);

      const { id: _drop, ...expense } = result.value;
      return created(await ctx.env.db.transaction((tx) =>
        repo.insertExpense(tx, ctx.actor.household.id, expense)));
    }));

  r.get('/api/households/:householdId/business/finance', guard(env, { permission: 'finance.read' },
    async (ctx) => {
      const found = await requireBusiness(ctx);
      if (!found.ok) return found.reply;
      const { business } = found;

      const sales = await repo.listSales(ctx.env.db, ctx.actor.household.id, business.id);
      const expenses = await repo.listExpenses(ctx.env.db, ctx.actor.household.id, business.id);
      const reservedCents = await repo.totalReserved(ctx.env.db, ctx.actor.household.id, business.id);

      const period = (ctx.req.query.get('period') ?? 'day') as 'day' | 'week' | 'month';
      const taxes = estimateTaxSetAside({
        business, sales, actor: ctx.actor.member, householdId: ctx.actor.household.id, reservedCents,
      });

      return ok({
        sales: summarizeSales({
          businessId: business.id, sales,
          period: ['day', 'week', 'month'].includes(period) ? period : 'day',
          timezone: business.timezone,
        }),
        expenses: summarizeExpenses({ businessId: business.id, expenses }),
        // The label and its disclaimer travel WITH the number, by contract.
        taxSetAside: taxes.ok ? taxes.value : null,
      });
    }));

  return r;
}

/* ---------------------------------------------------------------- helpers */

/** Build a `RecurrenceRule` from form fields, or undefined when not recurring. */
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
type Weekday_ = (typeof WEEKDAYS)[number];

const isWeekday = (value: unknown): value is Weekday_ =>
  typeof value === 'string' && (WEEKDAYS as readonly string[]).includes(value);

/**
 * Read a recurrence rule from a request body, in either of the two shapes a
 * client legitimately has.
 *
 * An HTML form cannot post a nested object, so it sends flat fields
 * (`recurrenceFreq`, `recurrenceByWeekday`, ...). A fetch() sending JSON has no
 * reason not to send the contract's own `RecurrenceRule`. Both are accepted.
 *
 * The third outcome is the important one. An earlier version read only the flat
 * fields and returned `undefined` for anything else, which meant a client
 * posting `{ recurrence: { freq: 'WEEKLY', ... } }` — the shape the contract
 * defines — got a single non-repeating event and a 201 saying it had worked.
 * Silently discarding a field the caller clearly meant is worse than refusing
 * it, so an unusable `recurrence` is now `'invalid'` and the route answers 422.
 */
function parseRecurrence(body: Record<string, unknown> | null): RecurrenceRule | undefined | 'invalid' {
  const nested = body?.['recurrence'];
  if (nested !== undefined && nested !== null) {
    if (typeof nested !== 'object' || Array.isArray(nested)) return 'invalid';
    return fromRule(nested as Record<string, unknown>);
  }

  const freq = body?.['recurrenceFreq'];
  if (freq === undefined || freq === null || freq === '') return undefined;

  return fromRule({
    freq,
    interval: body?.['recurrenceInterval'],
    byWeekday: body?.['recurrenceByWeekday'],
    until: body?.['recurrenceUntil'],
    count: body?.['recurrenceCount'],
  });
}

function fromRule(raw: Record<string, unknown>): RecurrenceRule | 'invalid' {
  // `frequency` is not the contract's name for this, but it is what a person
  // writing a client guesses first; accepting it costs nothing and saves a
  // confusing 422.
  const rawFreq = raw['freq'] ?? raw['frequency'];
  const freq = typeof rawFreq === 'string' ? rawFreq.toUpperCase() : undefined;
  // No YEARLY: the contract's `Frequency` does not have it and the expansion
  // engine cannot produce it, so accepting the word would be a promise the
  // calendar does not keep.
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return 'invalid';

  const rawInterval = raw['interval'];
  const interval = rawInterval === undefined || rawInterval === null || rawInterval === ''
    ? 1
    : Number(rawInterval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return 'invalid';

  const rawDays = raw['byWeekday'];
  const dayList = Array.isArray(rawDays) ? rawDays : rawDays === undefined || rawDays === null || rawDays === '' ? [] : [rawDays];
  const days = dayList.map((d) => (typeof d === 'string' ? d.toUpperCase() : d));
  if (!days.every(isWeekday)) return 'invalid';

  const rawMonthDays = raw['byMonthDay'];
  const monthDayList = Array.isArray(rawMonthDays) ? rawMonthDays : rawMonthDays === undefined || rawMonthDays === null || rawMonthDays === '' ? [] : [rawMonthDays];
  const monthDays = monthDayList.map(Number);
  if (!monthDays.every((d) => Number.isInteger(d) && d >= 1 && d <= 31)) return 'invalid';

  const until = raw['until'];
  if (until !== undefined && until !== null && until !== '' &&
      !(typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until))) {
    return 'invalid';
  }

  const rawCount = raw['count'];
  const count = rawCount === undefined || rawCount === null || rawCount === '' ? undefined : Number(rawCount);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 1000)) return 'invalid';

  const weekStart = raw['weekStart'];
  const normalisedWeekStart = typeof weekStart === 'string' ? weekStart.toUpperCase() : weekStart;
  if (normalisedWeekStart !== undefined && normalisedWeekStart !== null && normalisedWeekStart !== '' &&
      !isWeekday(normalisedWeekStart)) {
    return 'invalid';
  }

  return {
    freq,
    interval,
    ...(days.length > 0 ? { byWeekday: days as Weekday_[] } : {}),
    ...(monthDays.length > 0 ? { byMonthDay: monthDays } : {}),
    ...(typeof until === 'string' && until !== '' ? { until } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(isWeekday(normalisedWeekStart) ? { weekStart: normalisedWeekStart } : {}),
  };
}

/**
 * Is this a timezone this machine's ICU data actually knows?
 *
 * Checked because an unknown zone is stored once and then breaks every render
 * of every date in that household — far from where the typo was made. `Intl`
 * throws on an invalid identifier, which is the cheapest reliable test there is.
 */
function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
