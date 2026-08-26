/**
 * Sessions, accounts, households and invitations (Agent E).
 *
 * The shape of a session here:
 *
 *   - The cookie carries `<id>.<secret>`. The database stores the id in the
 *     clear and a **hash** of the secret. A stolen database backup is therefore
 *     not a stack of working sessions, which is the same reason invitation
 *     tokens are hashed.
 *   - Lookup is by id (indexed), then constant-time compare of the secret. Not
 *     a scan, and not a plain `where token = $1` that would leak through timing.
 *   - Sessions are rows, so "sign out everywhere" is a DELETE and a stolen
 *     cookie can actually be revoked. A stateless JWT cannot do either, which
 *     is why this is worth a table.
 *
 * Everything takes an injected `now`. The domain tier refuses to read the clock
 * and so does this: an expiry computed from a hidden clock cannot be tested at
 * its boundary, and the boundary is the only part that matters.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Db, Queryable } from '../db/client.ts';
import * as repo from '../db/repositories.ts';
import { burnVerificationTime, hashPassword, needsRehash, verifyPassword } from './passwords.ts';
import type { Household, Member, Role, UUID } from '../../lib/contracts/index.ts';

/* ---------------------------------------------------------------- config */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** How stale `last_seen_at` may get before we bother writing it again. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual requires equal lengths, and the length check itself must
  // not short-circuit informatively — comparing digests of equal size avoids
  // the problem entirely.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ types */

export interface AuthUser {
  id: UUID;
  email: string;
  displayName: string;
}

export interface SessionContext {
  user: AuthUser;
  sessionId: UUID;
}

/** What the API tier needs to authorise a request: who, and in which household. */
export interface RequestActor {
  user: AuthUser;
  sessionId: UUID;
  household: Household;
  member: Member;
}

export type AuthFailure =
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'weak_password'; message: string }
  | { ok: false; reason: 'email_taken' }
  | { ok: false; reason: 'invalid_email' }
  | { ok: false; reason: 'invitation_invalid' }
  | { ok: false; reason: 'invitation_expired' }
  | { ok: false; reason: 'invitation_used' };

export type AuthResult<T> = { ok: true; value: T } | AuthFailure;

const fail = (reason: AuthFailure['reason'], message?: string): AuthFailure =>
  ({ ok: false, reason, ...(message === undefined ? {} : { message }) }) as AuthFailure;

/* ----------------------------------------------------------------- email */

/**
 * Deliberately permissive. Email validation by regex is a well-known way to
 * reject somebody's perfectly legal address; the only thing worth checking is
 * that it has one `@` with something either side and no whitespace. Deliverability
 * is proven by sending mail, not by a pattern.
 */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  if (email.length === 0 || email.length > 320) return null;
  if (/\s/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}

/* -------------------------------------------------------------- accounts */

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  /** Creating a household outright, or joining one by invitation. */
  household: { create: { name: string; timezone: string } } | { joinToken: string };
  now: string;
}

/**
 * Create an account. Either founds a household (the founder is its owner) or
 * consumes an invitation and joins an existing one.
 *
 * All of it in one transaction: a login with no membership is an account that
 * can sign in and see nothing, which is a confusing dead end to leave behind.
 */
export async function register(
  db: Db,
  input: RegisterInput,
): Promise<AuthResult<{ user: AuthUser; household: Household; member: Member; token: string }>> {
  const email = normaliseEmail(input.email);
  if (email === null) return fail('invalid_email');

  const weak = (await import('./passwords.ts')).checkPasswordStrength(input.password);
  if (weak !== null) return fail('weak_password', weak.message);

  const displayName = String(input.displayName ?? '').trim();
  if (displayName.length === 0) return fail('invalid_email');

  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `select id from app_user where lower(email) = lower($1)`, [email],
      );
      if (existing.rows.length > 0) return fail('email_taken');

      const created = await tx.query<{ id: string; email: string; display_name: string }>(
        `insert into app_user (email, display_name, password_hash) values ($1,$2,$3)
         returning id, email, display_name`,
        [email, displayName, passwordHash],
      );
      const user: AuthUser = {
        id: created.rows[0]!.id,
        email: created.rows[0]!.email,
        displayName: created.rows[0]!.display_name,
      };

      let household: Household;
      let role: Role;
      let invitationId: string | null = null;

      if ('joinToken' in input.household) {
        const invitation = await findInvitation(tx, input.household.joinToken, input.now);
        if (!invitation.ok) return invitation;
        household = invitation.value.household;
        role = invitation.value.role;
        invitationId = invitation.value.id;
      } else {
        household = await repo.createHousehold(tx, input.household.create);
        // The founder is the owner. A household created with no owner would be
        // unadministrable by anyone, forever.
        role = 'owner';
      }

      const member = await repo.createMember(tx, {
        householdId: household.id, userId: user.id, displayName, role,
      });

      if (invitationId !== null) {
        await tx.query(
          `update invitation set accepted_at = $2, accepted_by = $3 where id = $1`,
          [invitationId, input.now, member.id],
        );
      }

      const token = await issueSession(tx, user.id, input.now);
      await repo.writeAudit(tx, {
        householdId: household.id, actorMemberId: member.id, action: 'account.register',
        entity: 'member', entityId: member.id, after: { role, viaInvitation: invitationId !== null },
      });

      return { ok: true as const, value: { user, household, member, token } };
    });
  } catch (error) {
    // The unique index is the real guard against two simultaneous registrations
    // of the same address; the SELECT above is only a nicer error most of the
    // time. Losing that race is `email_taken`, not a 500.
    if (String(error).includes('app_user_email_key')) return fail('email_taken');
    throw error;
  }
}

export interface LoginInput {
  email: string;
  password: string;
  now: string;
  userAgent?: string;
}

/**
 * Authenticate and open a session.
 *
 * Every failure returns the same `invalid_credentials`, and an unknown email
 * still burns scrypt time. Together those mean an attacker cannot use this
 * endpoint to discover which addresses have accounts — not from the message,
 * and not from the clock.
 */
export async function login(
  db: Db,
  input: LoginInput,
): Promise<AuthResult<{ user: AuthUser; token: string }>> {
  const email = normaliseEmail(input.email);
  if (email === null) {
    await burnVerificationTime();
    return fail('invalid_credentials');
  }

  const found = await db.query<{ id: string; email: string; display_name: string; password_hash: string }>(
    `select id, email, display_name, password_hash from app_user where lower(email) = lower($1)`,
    [email],
  );

  if (found.rows.length === 0) {
    await burnVerificationTime();
    return fail('invalid_credentials');
  }

  const row = found.rows[0]!;
  if (!(await verifyPassword(input.password, row.password_hash))) {
    return fail('invalid_credentials');
  }

  // Upgrade the stored hash opportunistically if the cost has since risen.
  if (needsRehash(row.password_hash)) {
    const upgraded = await hashPassword(input.password);
    await db.query(`update app_user set password_hash = $2 where id = $1`, [row.id, upgraded]);
  }

  const token = await db.transaction((tx) => issueSession(tx, row.id, input.now, input.userAgent));
  return {
    ok: true,
    value: {
      user: { id: row.id, email: row.email, displayName: row.display_name },
      token,
    },
  };
}

/* -------------------------------------------------------------- sessions */

async function issueSession(
  tx: Queryable,
  userId: UUID,
  now: string,
  userAgent?: string,
): Promise<string> {
  const secret = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.parse(now) + SESSION_TTL_MS).toISOString();
  const { rows } = await tx.query<{ id: string }>(
    `insert into session (user_id, token_hash, created_at, expires_at, last_seen_at, user_agent)
     values ($1,$2,$3,$4,$3,$5) returning id`,
    [userId, hashToken(secret), now, expiresAt, userAgent ?? null],
  );
  return `${rows[0]!.id}.${secret}`;
}

/**
 * Resolve a cookie value to a session, or null.
 *
 * Expired sessions are deleted on sight rather than merely rejected, so the
 * table does not grow forever and a leaked-but-expired cookie leaves nothing
 * to find.
 */
export async function resolveSession(
  db: Db,
  cookieValue: string | undefined,
  now: string,
): Promise<SessionContext | null> {
  if (typeof cookieValue !== 'string' || cookieValue.length === 0) return null;

  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return null;
  const id = cookieValue.slice(0, dot);
  const secret = cookieValue.slice(dot + 1);
  if (secret.length === 0) return null;

  // A malformed id is not a database error; uuid parsing would throw on the
  // query and produce a 500 for what is really just a bad cookie.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

  const { rows } = await db.query<{
    id: string; user_id: string; token_hash: string; expires_at: Date | string;
    last_seen_at: Date | string; email: string; display_name: string;
  }>(
    `select s.id, s.user_id, s.token_hash, s.expires_at, s.last_seen_at,
            u.email, u.display_name
       from session s join app_user u on u.id = s.user_id
      where s.id = $1`,
    [id],
  );
  if (rows.length === 0) return null;

  const row = rows[0]!;
  if (!constantTimeEquals(hashToken(secret), row.token_hash)) return null;

  const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row.expires_at));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now)) {
    await db.query(`delete from session where id = $1`, [id]);
    return null;
  }

  const lastSeen = row.last_seen_at instanceof Date
    ? row.last_seen_at.getTime()
    : Date.parse(String(row.last_seen_at));
  if (Date.parse(now) - lastSeen > TOUCH_INTERVAL_MS) {
    await db.query(`update session set last_seen_at = $2 where id = $1`, [id, now]);
  }

  return {
    sessionId: row.id,
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
  };
}

export async function endSession(db: Db, sessionId: UUID): Promise<void> {
  await db.query(`delete from session where id = $1`, [sessionId]);
}

/** Sign out everywhere — the reason sessions are rows at all. */
export async function endAllSessions(db: Db, userId: UUID): Promise<number> {
  const { rowCount } = await db.query(`delete from session where user_id = $1`, [userId]);
  return rowCount;
}

export async function purgeExpiredSessions(db: Db, now: string): Promise<number> {
  const { rowCount } = await db.query(`delete from session where expires_at <= $1`, [now]);
  return rowCount;
}

/**
 * Turn a session into a full actor for one household.
 *
 * Returns null when the user is not a member of that household, or is
 * deactivated — which is what makes "log in, then just change the household id
 * in the URL" a dead end rather than a vulnerability.
 */
export async function resolveActor(
  db: Db,
  session: SessionContext,
  householdId: UUID,
): Promise<RequestActor | null> {
  const household = await repo.getHousehold(db, householdId);
  if (household === null) return null;

  const member = await repo.findMemberForUser(db, householdId, session.user.id);
  if (member === null || !member.active) return null;

  return { user: session.user, sessionId: session.sessionId, household, member };
}

/* ----------------------------------------------------------- invitations */

export interface CreateInvitationInput {
  householdId: UUID;
  createdBy: UUID;
  role: Role;
  email?: string;
  now: string;
}

/**
 * Mint an invitation. Returns the token ONCE — only its hash is stored, so it
 * cannot be recovered later and has to be re-issued if lost.
 */
export async function createInvitation(
  db: Db,
  input: CreateInvitationInput,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.parse(input.now) + INVITATION_TTL_MS).toISOString();
  await db.query(
    `insert into invitation (household_id, token_hash, role, email, created_by, created_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [input.householdId, hashToken(token), input.role, input.email ?? null, input.createdBy,
     input.now, expiresAt],
  );
  return { token, expiresAt };
}

interface FoundInvitation {
  id: string;
  household: Household;
  role: Role;
}

async function findInvitation(
  tx: Queryable,
  token: string,
  now: string,
): Promise<AuthResult<FoundInvitation>> {
  if (typeof token !== 'string' || token.length === 0) return fail('invitation_invalid');

  const { rows } = await tx.query<{
    id: string; household_id: string; role: string;
    expires_at: Date | string; accepted_at: Date | string | null;
  }>(
    `select id, household_id, role, expires_at, accepted_at
       from invitation where token_hash = $1`,
    [hashToken(token)],
  );
  if (rows.length === 0) return fail('invitation_invalid');

  const row = rows[0]!;
  if (row.accepted_at !== null) return fail('invitation_used');

  const expiresAt = row.expires_at instanceof Date
    ? row.expires_at.getTime()
    : Date.parse(String(row.expires_at));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now)) return fail('invitation_expired');

  const household = await repo.getHousehold(tx, row.household_id);
  if (household === null) return fail('invitation_invalid');

  return { ok: true, value: { id: row.id, household, role: row.role as Role } };
}

/** What an invitation is for, before anyone commits to accepting it. */
export async function previewInvitation(
  db: Db,
  token: string,
  now: string,
): Promise<AuthResult<{ householdName: string; role: Role }>> {
  const found = await findInvitation(db, token, now);
  if (!found.ok) return found;
  return { ok: true, value: { householdName: found.value.household.name, role: found.value.role } };
}

/** Accept an invitation as an already-registered user. */
export async function acceptInvitation(
  db: Db,
  input: { token: string; user: AuthUser; now: string },
): Promise<AuthResult<{ household: Household; member: Member }>> {
  return db.transaction(async (tx) => {
    const found = await findInvitation(tx, input.token, input.now);
    if (!found.ok) return found;

    const already = await repo.findMemberForUser(tx, found.value.household.id, input.user.id);
    if (already !== null) {
      // Already a member: consume the invitation so it cannot be reused, and
      // hand back the existing membership rather than creating a duplicate.
      await tx.query(`update invitation set accepted_at = $2, accepted_by = $3 where id = $1`, [
        found.value.id, input.now, already.id,
      ]);
      return { ok: true as const, value: { household: found.value.household, member: already } };
    }

    const member = await repo.createMember(tx, {
      householdId: found.value.household.id,
      userId: input.user.id,
      displayName: input.user.displayName,
      role: found.value.role,
    });
    await tx.query(`update invitation set accepted_at = $2, accepted_by = $3 where id = $1`, [
      found.value.id, input.now, member.id,
    ]);
    await repo.writeAudit(tx, {
      householdId: found.value.household.id, actorMemberId: member.id,
      action: 'invitation.accept', entity: 'member', entityId: member.id,
      after: { role: found.value.role },
    });

    return { ok: true as const, value: { household: found.value.household, member } };
  });
}

/* ------------------------------------------------------------- passwords */

export async function changePassword(
  db: Db,
  input: { userId: UUID; currentPassword: string; newPassword: string; keepSessionId?: UUID },
): Promise<AuthResult<{ sessionsEnded: number }>> {
  const { rows } = await db.query<{ password_hash: string }>(
    `select password_hash from app_user where id = $1`, [input.userId],
  );
  if (rows.length === 0) return fail('invalid_credentials');
  if (!(await verifyPassword(input.currentPassword, rows[0]!.password_hash))) {
    return fail('invalid_credentials');
  }

  const weak = (await import('./passwords.ts')).checkPasswordStrength(input.newPassword);
  if (weak !== null) return fail('weak_password', weak.message);

  const hash = await hashPassword(input.newPassword);
  return db.transaction(async (tx) => {
    await tx.query(`update app_user set password_hash = $2 where id = $1`, [input.userId, hash]);
    // Changing a password is how somebody responds to "I think someone else is
    // in my account", so every OTHER session dies. Keeping the current one
    // avoids logging the person out of the device they just used.
    const { rowCount } = await tx.query(
      `delete from session where user_id = $1 and ($2::uuid is null or id <> $2)`,
      [input.userId, input.keepSessionId ?? null],
    );
    return { ok: true as const, value: { sessionsEnded: rowCount } };
  });
}
