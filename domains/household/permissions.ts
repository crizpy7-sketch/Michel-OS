/**
 * Michel-OS — Authorization kernel (Household / Auth domain).
 *
 * ARCHITECTURE.md §8: tenant/household isolation, business isolation,
 * server-side permission checks, never trust client-provided roles.
 *
 * Every server-side mutation in every other domain funnels its access decision
 * through `authorize()`. This module is deliberately boring:
 *
 *   - Deny by default. A permission that is not listed for a role is denied.
 *     There is no wildcard and no "owner bypasses everything" shortcut; the
 *     owner's permissions are enumerated one by one in ROLE_MATRIX like
 *     everybody else's.
 *   - Tenant isolation outranks permission. A cross-household request is
 *     rejected before any permission is even looked up, with a constant reason
 *     string, so a probe cannot distinguish "wrong household" from "insufficient
 *     permission" by message content or by work performed.
 *   - Pure. No I/O, no clock, no globals, no mutation of inputs.
 *
 * This file imports ROLES / PERMISSIONS from the FROZEN contracts and never
 * redefines them.
 */

import {
  ROLES,
  PERMISSIONS,
  type Role,
  type Permission,
  type Member,
  type UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------ role matrix */

/**
 * Complete, explicit role -> permission matrix. Every role in `ROLES` appears,
 * and every permission a role holds is written out literally.
 *
 * Shape rationale:
 *   owner    full household + business + finance; the only role that may let
 *            the AI act autonomously.
 *   adult    full family scheduling and member management, business/finance
 *            READ only, no household-level destruction (no `household.manage`).
 *   teen     read the family calendar, create events, edit only what they
 *            created. No finance, no member management, no deletion.
 *   child    read only. `event.update.own` is present solely so a child can
 *            complete/act on records they own (e.g. their own reminders);
 *            the `.own` gate in `authorize` means it can never touch another
 *            member's row. See KNOWN LIMITATIONS in the module docs below.
 *   employee Shia Baby business/shift scope ONLY. Deliberately has NO
 *            `event.read`: an employee of the business must never be able to
 *            see the family calendar (medical appointments, school, etc.).
 *            This is a privacy boundary, not an oversight.
 *   viewer   read-only observer (e.g. a grandparent). No AI at all — neither
 *            proposing nor executing.
 *
 * Frozen at every level: the object and each inner array. A caller cannot
 * escalate by pushing onto one of these arrays (it throws in strict mode), and
 * even if it could, `can()` reads from an immutable snapshot built below.
 */
export const ROLE_MATRIX: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: Object.freeze([
    'event.read',
    'event.create',
    'event.update.own',
    'event.update.any',
    'event.delete',
    'member.manage',
    'household.manage',
    'business.read',
    'business.manage',
    'employee.schedule',
    'finance.read',
    'finance.manage',
    'ai.propose',
    'ai.execute.autonomous',
  ] as const),

  adult: Object.freeze([
    'event.read',
    'event.create',
    'event.update.own',
    'event.update.any',
    'event.delete',
    'member.manage',
    'business.read',
    'finance.read',
    'ai.propose',
  ] as const),

  teen: Object.freeze([
    'event.read',
    'event.create',
    'event.update.own',
    'ai.propose',
  ] as const),

  child: Object.freeze([
    'event.read',
    'event.update.own',
  ] as const),

  employee: Object.freeze([
    'business.read',
    'employee.schedule',
    'ai.propose',
  ] as const),

  viewer: Object.freeze([
    'event.read',
  ] as const),
});

/* ------------------------------------------------------- internal indexes */

/** Permissions the frozen contract actually defines. Anything else is denied. */
const KNOWN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(PERMISSIONS);

/** Immutable snapshot of the matrix, keyed by role, for O(1) lookup. */
const ROLE_PERMISSION_INDEX: ReadonlyMap<Role, ReadonlySet<Permission>> = new Map(
  ROLES.map((role): readonly [Role, ReadonlySet<Permission>] => [
    role,
    new Set<Permission>(ROLE_MATRIX[role]),
  ]),
);

/** Returned for any role we do not recognise: deny everything. */
const NO_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>();

/**
 * Never trust a client-provided role: an unrecognised role resolves to the
 * empty permission set rather than throwing or falling through to a default.
 */
function grantedTo(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSION_INDEX.get(role) ?? NO_PERMISSIONS;
}

function isNonEmptyId(value: unknown): value is UUID {
  return typeof value === 'string' && value.length > 0;
}

/**
 * One constant string for every tenant rejection. It must not vary with the
 * permission requested or with whether that permission would have passed —
 * that is the whole point of checking tenancy first.
 */
const TENANT_DENIED = 'Cross-household access denied.';

/* -------------------------------------------------------------- public api */

export type DenyCode = 'permission' | 'tenant' | 'inactive';

export interface AuthorizeInput {
  member: Member;
  /** The tenant the request targets. */
  householdId: UUID;
  permission: Permission;
  /** The row being touched, when there is one. */
  resource?: { householdId?: UUID; createdBy?: UUID };
}

export type AuthorizeResult =
  | { allowed: true }
  | { allowed: false; reason: string; code: DenyCode };

/**
 * Role capability check: does this member's role hold this permission?
 *
 * NOTE: this is NOT a security boundary on its own — it knows nothing about
 * which household the request targets or which row is being touched. Use it for
 * UI affordances and use `authorize()` for every server-side decision.
 */
export function can(member: Member, permission: Permission): boolean {
  if (member.active !== true) return false;
  return grantedTo(member.role).has(permission);
}

/**
 * Tenant gate: the single chokepoint every server mutation must pass.
 *
 * Evaluation order is fixed and load-bearing:
 *   1. tenancy  (member's household, then the resource's household)
 *   2. active   (a deactivated member can do nothing in their own household)
 *   3. permission
 *   4. ownership, for the `event.update.own` / `event.update.any` split
 *
 * Tenancy is first so that a cross-household probe always yields the identical
 * `code: 'tenant'` + constant reason, for an owner as much as for a viewer, and
 * regardless of whether the permission would otherwise have passed.
 */
export function authorize(input: AuthorizeInput): AuthorizeResult {
  const { member, permission, householdId, resource } = input;

  /* 1. tenancy — before anything else, and before any permission lookup. */
  if (!isNonEmptyId(householdId) || !isNonEmptyId(member.householdId)) {
    return { allowed: false, reason: TENANT_DENIED, code: 'tenant' };
  }
  if (member.householdId !== householdId) {
    return { allowed: false, reason: TENANT_DENIED, code: 'tenant' };
  }
  const resourceHouseholdId: unknown = resource?.householdId;
  if (resourceHouseholdId !== undefined) {
    if (!isNonEmptyId(resourceHouseholdId) || resourceHouseholdId !== householdId) {
      return { allowed: false, reason: TENANT_DENIED, code: 'tenant' };
    }
  }

  /* 2. active */
  if (member.active !== true) {
    return {
      allowed: false,
      reason: 'Member is not active in this household.',
      code: 'inactive',
    };
  }

  /* 3. permission */
  if (!KNOWN_PERMISSIONS.has(permission)) {
    return {
      allowed: false,
      reason: `Unknown permission "${String(permission)}".`,
      code: 'permission',
    };
  }

  const granted = grantedTo(member.role);

  /* 4. own vs any, for the event update split. */
  if (permission === 'event.update.own') {
    // `.any` is strictly broader than `.own`; a holder of `.any` may act on any
    // row. Both are listed explicitly in ROLE_MATRIX for the roles that get
    // them — this is a widening for a superset permission, not a bypass.
    if (granted.has('event.update.any')) {
      return { allowed: true };
    }
    if (!granted.has('event.update.own')) {
      return {
        allowed: false,
        reason: `Role "${String(member.role)}" lacks permission "event.update.own".`,
        code: 'permission',
      };
    }
    // Ownership must be proven by the row itself. No row, no proof, no access.
    const createdBy: unknown = resource?.createdBy;
    if (!isNonEmptyId(member.id) || !isNonEmptyId(createdBy)) {
      return {
        allowed: false,
        reason: 'Ownership of the target record could not be established.',
        code: 'permission',
      };
    }
    if (createdBy !== member.id) {
      return {
        allowed: false,
        reason: 'Only the member who created this record may update it.',
        code: 'permission',
      };
    }
    return { allowed: true };
  }

  if (!granted.has(permission)) {
    return {
      allowed: false,
      reason: `Role "${String(member.role)}" lacks permission "${String(permission)}".`,
      code: 'permission',
    };
  }

  return { allowed: true };
}

/**
 * Convenience oracle for the AI validator: `authorize` bound to one member and
 * one tenant. Returns a pure predicate; a cross-tenant or inactive member
 * simply yields `false` for every permission.
 *
 * Resource-scoped decisions (the `event.update.own` ownership check) cannot be
 * answered by the oracle — it has no row — so `event.update.own` reports true
 * only for members who also hold `event.update.any`. Call `authorize()` with
 * the resource for the real decision.
 */
export function permissionOracle(
  member: Member,
  householdId: UUID,
): (permission: Permission) => boolean {
  return (permission: Permission): boolean =>
    authorize({ member, permission, householdId }).allowed;
}
