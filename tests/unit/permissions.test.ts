/**
 * Michel-OS — authorization kernel tests.
 *
 * The matrix below is deliberately restated independently of the
 * implementation: if `ROLE_MATRIX` drifts, these tests fail rather than
 * agreeing with themselves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLES,
  PERMISSIONS,
  type Role,
  type Permission,
  type Member,
  type UUID,
} from '../../lib/contracts/index.ts';

import {
  ROLE_MATRIX,
  can,
  authorize,
  permissionOracle,
} from '../../domains/household/permissions.ts';

/* ------------------------------------------------------------- fixtures */

const H1: UUID = '11111111-1111-4111-8111-111111111111';
const H2: UUID = '22222222-2222-4222-8222-222222222222';

const M_OWNER: UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const M_ADULT: UUID = 'aaaaaaaa-0000-4000-8000-000000000002';
const M_TEEN: UUID = 'aaaaaaaa-0000-4000-8000-000000000003';
const M_CHILD: UUID = 'aaaaaaaa-0000-4000-8000-000000000004';
const M_EMPLOYEE: UUID = 'aaaaaaaa-0000-4000-8000-000000000005';
const M_VIEWER: UUID = 'aaaaaaaa-0000-4000-8000-000000000006';
const M_OTHER: UUID = 'aaaaaaaa-0000-4000-8000-00000000ffff';

function member(overrides: Partial<Member> & { id: UUID; role: Role }): Member {
  return {
    id: overrides.id,
    householdId: overrides.householdId ?? H1,
    userId: overrides.userId ?? null,
    displayName: overrides.displayName ?? 'Test Member',
    role: overrides.role,
    color: overrides.color ?? 'slate',
    active: overrides.active ?? true,
  };
}

const owner = member({ id: M_OWNER, role: 'owner' });
const adult = member({ id: M_ADULT, role: 'adult' });
const teen = member({ id: M_TEEN, role: 'teen' });
const child = member({ id: M_CHILD, role: 'child' });
const employee = member({ id: M_EMPLOYEE, role: 'employee' });
const viewer = member({ id: M_VIEWER, role: 'viewer' });

const ALL: readonly Member[] = [owner, adult, teen, child, employee, viewer];

/** Independent restatement of the expected role -> permission grants. */
const EXPECTED: Record<Role, readonly Permission[]> = {
  owner: [
    'event.read', 'event.create', 'event.update.own', 'event.update.any', 'event.delete',
    'member.manage', 'household.manage',
    'business.read', 'business.manage', 'employee.schedule',
    'finance.read', 'finance.manage',
    'ai.propose', 'ai.execute.autonomous',
  ],
  adult: [
    'event.read', 'event.create', 'event.update.own', 'event.update.any', 'event.delete',
    'member.manage', 'business.read', 'finance.read', 'ai.propose',
  ],
  teen: ['event.read', 'event.create', 'event.update.own', 'ai.propose'],
  child: ['event.read', 'event.update.own'],
  employee: ['business.read', 'employee.schedule', 'ai.propose'],
  viewer: ['event.read'],
};

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/* --------------------------------------------------- matrix completeness */

test('ROLE_MATRIX has an entry for every role in ROLES', () => {
  for (const role of ROLES) {
    const entry: readonly Permission[] | undefined = ROLE_MATRIX[role];
    assert.ok(Array.isArray(entry), `missing ROLE_MATRIX entry for role "${role}"`);
  }
  assert.equal(Object.keys(ROLE_MATRIX).length, ROLES.length, 'no extra roles in ROLE_MATRIX');
});

test('every permission listed in ROLE_MATRIX is a real contract permission', () => {
  const known = new Set<string>(PERMISSIONS);
  for (const role of ROLES) {
    for (const permission of ROLE_MATRIX[role]) {
      assert.ok(
        known.has(permission),
        `role "${role}" lists unknown permission "${permission}" (typo = silent permanent deny)`,
      );
    }
  }
});

test('no role lists a duplicate permission', () => {
  for (const role of ROLES) {
    const list = ROLE_MATRIX[role];
    assert.equal(new Set(list).size, list.length, `role "${role}" has duplicate entries`);
  }
});

test('ROLE_MATRIX matches the independently declared expectation', () => {
  for (const role of ROLES) {
    assert.deepEqual(sorted(ROLE_MATRIX[role]), sorted(EXPECTED[role]), `role "${role}"`);
  }
});

/* -------------------------------------------------- table-driven can() sweep */

test('can() matches the expected matrix for every role x permission', () => {
  for (const m of ALL) {
    const expected = new Set<string>(EXPECTED[m.role]);
    for (const permission of PERMISSIONS) {
      assert.equal(
        can(m, permission),
        expected.has(permission),
        `can(${m.role}, ${permission})`,
      );
    }
  }
});

test('can() denies an unknown permission string', () => {
  const bogus = 'event.nuke' as unknown as Permission;
  for (const m of ALL) {
    assert.equal(can(m, bogus), false, `${m.role} must not hold a made-up permission`);
  }
});

test('can() denies everything for an unknown (client-supplied) role', () => {
  const impostor = member({ id: M_OTHER, role: 'superuser' as unknown as Role });
  for (const permission of PERMISSIONS) {
    assert.equal(can(impostor, permission), false, `bogus role granted ${permission}`);
  }
});

/* ------------------------------------------------------- tenant isolation */

test('cross-tenant request is denied for an OWNER', () => {
  const result = authorize({ member: owner, permission: 'event.read', householdId: H2 });
  assert.equal(result.allowed, false);
  assert.equal(result.allowed === false && result.code, 'tenant');
});

test('cross-tenant owner is denied even for permissions the owner fully holds', () => {
  for (const permission of PERMISSIONS) {
    const result = authorize({ member: owner, permission, householdId: H2 });
    assert.equal(result.allowed, false, `owner leaked ${permission} across tenants`);
    assert.equal(result.allowed === false && result.code, 'tenant');
  }
});

test('tenancy outranks permission: identical denial whether or not the permission would pass', () => {
  const wouldPass = authorize({ member: viewer, permission: 'event.read', householdId: H2 });
  const wouldFail = authorize({ member: viewer, permission: 'household.manage', householdId: H2 });
  assert.equal(wouldPass.allowed, false);
  assert.equal(wouldFail.allowed, false);
  assert.equal(wouldPass.allowed === false && wouldPass.code, 'tenant');
  assert.equal(wouldFail.allowed === false && wouldFail.code, 'tenant');
  assert.deepEqual(wouldPass, wouldFail, 'cross-tenant probes must be indistinguishable');
});

test('resource belonging to another household is denied even inside the right tenant', () => {
  const result = authorize({
    member: owner,
    permission: 'event.update.any',
    householdId: H1,
    resource: { householdId: H2, createdBy: M_OWNER },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.allowed === false && result.code, 'tenant');
});

test('a matching resource household is allowed', () => {
  const result = authorize({
    member: adult,
    permission: 'event.delete',
    householdId: H1,
    resource: { householdId: H1, createdBy: M_TEEN },
  });
  assert.deepEqual(result, { allowed: true });
});

test('empty or missing household ids fail closed as tenant denials', () => {
  const blank = authorize({ member: owner, permission: 'event.read', householdId: '' });
  assert.equal(blank.allowed === false && blank.code, 'tenant');

  const homeless = member({ id: M_OTHER, role: 'owner', householdId: '' });
  const result = authorize({ member: homeless, permission: 'event.read', householdId: '' });
  assert.equal(result.allowed === false && result.code, 'tenant');

  const blankResource = authorize({
    member: owner,
    permission: 'event.read',
    householdId: H1,
    resource: { householdId: '' },
  });
  assert.equal(blankResource.allowed === false && blankResource.code, 'tenant');
});

/* -------------------------------------------------------- inactive members */

test('an inactive owner is denied everything', () => {
  const suspended = member({ id: M_OWNER, role: 'owner', active: false });
  for (const permission of PERMISSIONS) {
    const result = authorize({ member: suspended, permission, householdId: H1 });
    assert.equal(result.allowed, false, `inactive owner allowed ${permission}`);
    assert.equal(result.allowed === false && result.code, 'inactive');
  }
  assert.equal(can(suspended, 'event.read'), false);
});

test('inactive + cross-tenant reports tenant: tenancy is checked first', () => {
  const suspended = member({ id: M_OWNER, role: 'owner', active: false });
  const result = authorize({ member: suspended, permission: 'event.read', householdId: H2 });
  assert.equal(result.allowed === false && result.code, 'tenant');
});

/* ------------------------------------------------------------ own vs any */

test('a .own-only member may update a record they created', () => {
  const result = authorize({
    member: teen,
    permission: 'event.update.own',
    householdId: H1,
    resource: { householdId: H1, createdBy: M_TEEN },
  });
  assert.deepEqual(result, { allowed: true });
});

test('a .own-only member may NOT update someone else’s record', () => {
  const result = authorize({
    member: teen,
    permission: 'event.update.own',
    householdId: H1,
    resource: { householdId: H1, createdBy: M_ADULT },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.allowed === false && result.code, 'permission');
});

test('a .own-only member is denied when ownership cannot be established', () => {
  const noResource = authorize({ member: teen, permission: 'event.update.own', householdId: H1 });
  assert.equal(noResource.allowed === false && noResource.code, 'permission');

  const noCreator = authorize({
    member: teen,
    permission: 'event.update.own',
    householdId: H1,
    resource: { householdId: H1 },
  });
  assert.equal(noCreator.allowed === false && noCreator.code, 'permission');
});

test('a .own-only member is denied event.update.any outright', () => {
  const result = authorize({
    member: teen,
    permission: 'event.update.any',
    householdId: H1,
    resource: { householdId: H1, createdBy: M_TEEN },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.allowed === false && result.code, 'permission');
});

test('a .any holder may update any record, own or not', () => {
  const others = authorize({
    member: adult,
    permission: 'event.update.any',
    householdId: H1,
    resource: { householdId: H1, createdBy: M_TEEN },
  });
  assert.deepEqual(others, { allowed: true });

  const ownViaAny = authorize({
    member: adult,
    permission: 'event.update.own',
    householdId: H1,
    resource: { householdId: H1, createdBy: M_TEEN },
  });
  assert.deepEqual(ownViaAny, { allowed: true }, '.any subsumes .own');
});

test('a child may act on their own record but not on a sibling’s', () => {
  const ownRecord = authorize({
    member: child,
    permission: 'event.update.own',
    householdId: H1,
    resource: { householdId: H1, createdBy: M_CHILD },
  });
  assert.deepEqual(ownRecord, { allowed: true });

  const siblingRecord = authorize({
    member: child,
    permission: 'event.update.own',
    householdId: H1,
    resource: { householdId: H1, createdBy: M_TEEN },
  });
  assert.equal(siblingRecord.allowed, false);
  assert.equal(siblingRecord.allowed === false && siblingRecord.code, 'permission');
});

/* ------------------------------------------------- employee privacy boundary */

test('an employee cannot read the family calendar', () => {
  const result = authorize({ member: employee, permission: 'event.read', householdId: H1 });
  assert.equal(result.allowed, false, 'employee must never see family events');
  assert.equal(result.allowed === false && result.code, 'permission');
  assert.equal(can(employee, 'event.read'), false);
});

test('an employee can still be scheduled and read business data', () => {
  assert.deepEqual(
    authorize({ member: employee, permission: 'employee.schedule', householdId: H1 }),
    { allowed: true },
  );
  assert.deepEqual(
    authorize({ member: employee, permission: 'business.read', householdId: H1 }),
    { allowed: true },
  );
});

test('an employee is locked out of family scheduling, finance and management', () => {
  const forbidden: readonly Permission[] = [
    'event.read', 'event.create', 'event.update.own', 'event.update.any', 'event.delete',
    'member.manage', 'household.manage', 'business.manage',
    'finance.read', 'finance.manage', 'ai.execute.autonomous',
  ];
  for (const permission of forbidden) {
    const result = authorize({
      member: employee,
      permission,
      householdId: H1,
      resource: { householdId: H1, createdBy: M_EMPLOYEE },
    });
    assert.equal(result.allowed, false, `employee escalated to ${permission}`);
  }
});

/* ------------------------------------------------------------------- ai */

test('ai.execute.autonomous is owner-only', () => {
  assert.deepEqual(
    authorize({ member: owner, permission: 'ai.execute.autonomous', householdId: H1 }),
    { allowed: true },
  );
  for (const m of [adult, teen, child, employee, viewer]) {
    const result = authorize({ member: m, permission: 'ai.execute.autonomous', householdId: H1 });
    assert.equal(result.allowed, false, `${m.role} must not run the AI autonomously`);
    assert.equal(result.allowed === false && result.code, 'permission');
  }
});

test('child and viewer cannot propose AI actions; everyone else can', () => {
  for (const m of [child, viewer]) {
    const result = authorize({ member: m, permission: 'ai.propose', householdId: H1 });
    assert.equal(result.allowed, false, `${m.role} must not propose AI actions`);
  }
  for (const m of [owner, adult, teen, employee]) {
    assert.deepEqual(
      authorize({ member: m, permission: 'ai.propose', householdId: H1 }),
      { allowed: true },
      `${m.role} should be able to propose`,
    );
  }
});

/* ------------------------------------------------- household / finance shape */

test('only the owner may manage the household or finances', () => {
  for (const permission of ['household.manage', 'finance.manage', 'business.manage'] as const) {
    assert.deepEqual(authorize({ member: owner, permission, householdId: H1 }), { allowed: true });
    for (const m of [adult, teen, child, employee, viewer]) {
      const result = authorize({ member: m, permission, householdId: H1 });
      assert.equal(result.allowed, false, `${m.role} allowed ${permission}`);
    }
  }
});

test('an adult manages members and reads finance but cannot delete the household', () => {
  assert.deepEqual(
    authorize({ member: adult, permission: 'member.manage', householdId: H1 }),
    { allowed: true },
  );
  assert.deepEqual(
    authorize({ member: adult, permission: 'finance.read', householdId: H1 }),
    { allowed: true },
  );
  const denied = authorize({ member: adult, permission: 'household.manage', householdId: H1 });
  assert.equal(denied.allowed === false && denied.code, 'permission');
});

test('a teen has no finance access and no member management', () => {
  for (const permission of ['finance.read', 'finance.manage', 'member.manage', 'event.delete'] as const) {
    const result = authorize({ member: teen, permission, householdId: H1 });
    assert.equal(result.allowed, false, `teen allowed ${permission}`);
  }
});

test('a viewer is read-only', () => {
  assert.deepEqual(
    authorize({ member: viewer, permission: 'event.read', householdId: H1 }),
    { allowed: true },
  );
  for (const permission of PERMISSIONS) {
    if (permission === 'event.read') continue;
    const result = authorize({
      member: viewer,
      permission,
      householdId: H1,
      resource: { householdId: H1, createdBy: M_VIEWER },
    });
    assert.equal(result.allowed, false, `viewer allowed ${permission}`);
  }
});

/* ---------------------------------------------------- runtime immutability */

test('ROLE_MATRIX and its inner arrays are frozen', () => {
  assert.equal(Object.isFrozen(ROLE_MATRIX), true);
  for (const role of ROLES) {
    assert.equal(Object.isFrozen(ROLE_MATRIX[role]), true, `role "${role}" array not frozen`);
  }
});

test('pushing onto a role array cannot grant a permission', () => {
  assert.throws(() => {
    (ROLE_MATRIX.viewer as Permission[]).push('household.manage');
  }, TypeError);
  assert.equal(can(viewer, 'household.manage'), false);
  const result = authorize({ member: viewer, permission: 'household.manage', householdId: H1 });
  assert.equal(result.allowed, false, 'array mutation escalated a viewer');
  assert.equal(ROLE_MATRIX.viewer.length, 1);
});

test('replacing a role entry cannot grant a permission', () => {
  assert.throws(() => {
    (ROLE_MATRIX as unknown as Record<Role, Permission[]>).viewer = [...PERMISSIONS];
  }, TypeError);
  assert.equal(can(viewer, 'ai.execute.autonomous'), false);
  assert.deepEqual(sorted(ROLE_MATRIX.viewer), sorted(EXPECTED.viewer));
});

/* ------------------------------------------------------------- input purity */

test('authorize does not mutate its inputs', () => {
  const snapshot = JSON.stringify(teen);
  const resource = { householdId: H1, createdBy: M_ADULT };
  const resourceSnapshot = JSON.stringify(resource);
  authorize({ member: teen, permission: 'event.update.own', householdId: H1, resource });
  assert.equal(JSON.stringify(teen), snapshot);
  assert.equal(JSON.stringify(resource), resourceSnapshot);
});

/* --------------------------------------------------------- permissionOracle */

test('permissionOracle agrees with authorize for the same member and tenant', () => {
  for (const m of ALL) {
    const oracle = permissionOracle(m, H1);
    for (const permission of PERMISSIONS) {
      assert.equal(
        oracle(permission),
        authorize({ member: m, permission, householdId: H1 }).allowed,
        `oracle disagreed for ${m.role} / ${permission}`,
      );
    }
  }
});

test('permissionOracle denies everything across a tenant boundary', () => {
  const oracle = permissionOracle(owner, H2);
  for (const permission of PERMISSIONS) {
    assert.equal(oracle(permission), false, `oracle leaked ${permission} across tenants`);
  }
});

test('permissionOracle denies everything for an inactive member', () => {
  const oracle = permissionOracle(member({ id: M_OWNER, role: 'owner', active: false }), H1);
  for (const permission of PERMISSIONS) {
    assert.equal(oracle(permission), false, `inactive oracle allowed ${permission}`);
  }
});

test('permissionOracle is resource-blind: .own resolves only via .any', () => {
  assert.equal(permissionOracle(adult, H1)('event.update.own'), true);
  assert.equal(permissionOracle(teen, H1)('event.update.own'), false);
});
