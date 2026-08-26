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
 *   teen     read the family calendar, create events, and edit or delete only
 *            what they created. No finance, no member management.
 *   child    read the calendar, and complete or snooze the reminders assigned
 *            to them — nothing else. Contract v1.1 gave reminders their own
 *            verbs (CR-001), so the child no longer holds `event.update.own`
 *            as a stand-in for reminder access; that grant was a lie about
 *            intent and it is gone.
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
    'event.delete.own',
    'event.delete.any',
    'reminder.complete.own',
    'reminder.snooze.own',
    'reminder.manage.any',
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
    'event.delete.own',
    'event.delete.any',
    'reminder.complete.own',
    'reminder.snooze.own',
    'reminder.manage.any',
    'member.manage',
    'business.read',
    'finance.read',
    'ai.propose',
  ] as const),

  teen: Object.freeze([
    'event.read',
    'event.create',
    'event.update.own',
    'event.delete.own',
    'reminder.complete.own',
    'reminder.snooze.own',
    'ai.propose',
  ] as const),

  child: Object.freeze([
    'event.read',
    'reminder.complete.own',
    'reminder.snooze.own',
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

/**
 * The row being touched, when there is one.
 *
 * `createdBy` proves authorship (events); `assignedTo` proves assignment
 * (reminders). CR-001: v1.0 had only `createdBy`, so the `.own` test could not
 * see reminder assignment at all and the reminders module had to layer its own
 * check on top — which is exactly the sort of second, divergent access rule
 * this kernel exists to prevent.
 */
export interface AuthorizeResource {
  householdId?: UUID;
  createdBy?: UUID;
  assignedTo?: UUID;
}

export interface AuthorizeInput {
  member: Member;
  /** The tenant the request targets. */
  householdId: UUID;
  permission: Permission;
  resource?: AuthorizeResource;
}

/**
 * The `.own` verbs and how each one is proven.
 *
 * `broader` is the permission that subsumes this one outright — a holder of it
 * needs no row-level proof. `provenBy` names the field on the resource that has
 * to equal the member's id. Both are data rather than branches so that adding a
 * verb in a later contract version cannot quietly skip the ownership test.
 */
const OWNERSHIP_RULES: Readonly<Record<string, { broader: Permission; provenBy: 'createdBy' | 'assignedTo'; noun: string }>> =
  Object.freeze({
    'event.update.own': { broader: 'event.update.any', provenBy: 'createdBy', noun: 'update' },
    'event.delete.own': { broader: 'event.delete.any', provenBy: 'createdBy', noun: 'delete' },
    'reminder.complete.own': { broader: 'reminder.manage.any', provenBy: 'assignedTo', noun: 'complete' },
    'reminder.snooze.own': { broader: 'reminder.manage.any', provenBy: 'assignedTo', noun: 'snooze' },
  });

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
 *   4. ownership, for every `.own` / broader-verb split (OWNERSHIP_RULES)
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

  /* 4. own vs any, for every `.own` verb in OWNERSHIP_RULES. */
  const rule = OWNERSHIP_RULES[permission];
  if (rule !== undefined) {
    // The broader permission is strictly a superset of the `.own` one; a holder
    // of it may act on any row. Both are listed explicitly in ROLE_MATRIX for
    // the roles that get them — this is a widening for a superset permission,
    // not a bypass.
    if (granted.has(rule.broader)) {
      return { allowed: true };
    }
    if (!granted.has(permission)) {
      return {
        allowed: false,
        reason: `Role "${String(member.role)}" lacks permission "${String(permission)}".`,
        code: 'permission',
      };
    }
    // Ownership must be proven by the row itself. No row, no proof, no access.
    const claimant: unknown = resource?.[rule.provenBy];
    if (!isNonEmptyId(member.id) || !isNonEmptyId(claimant)) {
      return {
        allowed: false,
        reason: 'Ownership of the target record could not be established.',
        code: 'permission',
      };
    }
    if (claimant !== member.id) {
      return {
        allowed: false,
        reason:
          rule.provenBy === 'createdBy'
            ? `Only the member who created this record may ${rule.noun} it.`
            : `Only the member this record is assigned to may ${rule.noun} it.`,
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
 * Resource-scoped decisions cannot be answered by the oracle — it has no row —
 * so every `.own` verb in OWNERSHIP_RULES reports true only for members who
 * also hold the broader verb that subsumes it. Call `authorize()` with the
 * resource for the real decision.
 */
export function permissionOracle(
  member: Member,
  householdId: UUID,
): (permission: Permission) => boolean {
  return (permission: Permission): boolean =>
    authorize({ member, permission, householdId }).allowed;
}
