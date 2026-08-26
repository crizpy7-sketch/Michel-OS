/**
 * Auth tests (Agent E), against real Postgres.
 *
 * ADR-001 accepted that self-hosting means owning authentication, on condition
 * that it stays small and gets attacked rather than merely exercised. This file
 * is the attacking half. It is written from the position of someone trying to
 * get in, not someone confirming the happy path works:
 *
 *   - enumerate which emails have accounts, by message or by timing;
 *   - forge or replay a session cookie;
 *   - keep a session alive past its expiry;
 *   - reuse an invitation, or use somebody else's;
 *   - reach a household by changing an id after logging in legitimately.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb, type Db } from '../../server/db/client.ts';
import {
  acceptInvitation, changePassword, createInvitation, endAllSessions, endSession,
  login, normaliseEmail, previewInvitation, purgeExpiredSessions, register,
  resolveActor, resolveSession, SESSION_TTL_MS, INVITATION_TTL_MS,
} from '../../server/auth/sessions.ts';
import {
  checkPasswordStrength, hashPassword, needsRehash, verifyPassword,
} from '../../server/auth/passwords.ts';
import * as repo from '../../server/db/repositories.ts';

const NOW = '2026-09-07T12:00:00.000Z';
const later = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const db = await createTestDb();
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

function ok<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

function reason(result: { ok: boolean; reason?: string }): string {
  assert.equal(result.ok, false, 'expected a failure');
  return String((result as { reason: string }).reason);
}

const founder = {
  email: 'elena@example.com',
  password: 'a quiet horse in the yard',
  displayName: 'Elena',
  household: { create: { name: 'Michel', timezone: 'America/Chicago' } },
  now: NOW,
} as const;

/* ------------------------------------------------------------ passwords */

test('the same password hashes differently every time, and both verify', async () => {
  const a = await hashPassword('a quiet horse in the yard');
  const b = await hashPassword('a quiet horse in the yard');
  assert.notEqual(a, b, 'a missing per-hash salt makes the whole table rainbow-tableable');
  assert.equal(await verifyPassword('a quiet horse in the yard', a), true);
  assert.equal(await verifyPassword('a quiet horse in the yard', b), true);
  assert.equal(await verifyPassword('a quiet horse in the barn', a), false);
});

test('a corrupt, truncated or hostile hash returns false rather than throwing', async () => {
  for (const stored of [
    '', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$65536$8$1$c2FsdA$a2V5',
    'scrypt$65536$8$1$$', 'scrypt$abc$8$1$c2FsdA$a2V5',
    // An absurd work factor would turn one login attempt into a self-inflicted
    // denial of service if it were honoured.
    'scrypt$99999999$8$1$c2FsdA$a2V5',
  ]) {
    assert.equal(await verifyPassword('anything', stored), false, `should have failed closed: ${stored}`);
  }
});

test('password strength rejects the short and the notorious, not the unusual', async () => {
  assert.equal(checkPasswordStrength('short')?.code, 'too_short');
  assert.equal(checkPasswordStrength('password1')?.code, 'too_common');
  assert.equal(checkPasswordStrength('x'.repeat(500))?.code, 'too_long');
  assert.equal(checkPasswordStrength('a quiet horse in the yard'), null, 'a passphrase is a good password');
  assert.equal(checkPasswordStrength('~~~~~~~~~~~~'), null, 'no complexity theatre');
});

test('needsRehash spots a hash made with weaker parameters', async () => {
  assert.equal(needsRehash(await hashPassword('a quiet horse in the yard')), false);
  assert.equal(needsRehash('scrypt$16384$8$1$c2FsdA$a2V5'), true, 'an older, cheaper hash');
  assert.equal(needsRehash('garbage'), true);
});

test('unicode-equivalent passwords are treated as the same password', async () => {
  // The same string in NFC and NFD. Without normalisation, a person whose
  // keyboard changes composition can be locked out of their own account.
  const composed = 'café passphrase 42';
  const decomposed = 'café passphrase 42';
  assert.notEqual(composed, decomposed);
  assert.equal(await verifyPassword(decomposed, await hashPassword(composed)), true);
});

/* -------------------------------------------------------------- email */

test('email normalisation is permissive but rejects the genuinely malformed', () => {
  assert.equal(normaliseEmail('  Elena@Example.com '), 'Elena@Example.com');
  assert.equal(normaliseEmail('weird!#$%name@example.com'), 'weird!#$%name@example.com');
  for (const bad of ['', 'no-at-sign', '@example.com', 'elena@', 'a@b@c', 'has space@x.com', null, 42]) {
    assert.equal(normaliseEmail(bad as string), null, `should reject ${JSON.stringify(bad)}`);
  }
});

/* ----------------------------------------------------------- registration */

test('registering founds a household and makes the founder its owner', async () => {
  await withDb(async (db) => {
    const result = ok(await register(db, founder));
    assert.equal(result.user.email, 'elena@example.com');
    assert.equal(result.household.name, 'Michel');
    assert.equal(result.member.role, 'owner', 'a household with no owner is unadministrable forever');
    assert.match(result.token, /^[0-9a-f-]{36}\./);
    assert.equal(await repo.countActiveOwners(db, result.household.id), 1);
  });
});

test('the same email cannot register twice, in any casing', async () => {
  await withDb(async (db) => {
    ok(await register(db, founder));
    assert.equal(reason(await register(db, founder)), 'email_taken');
    assert.equal(
      reason(await register(db, { ...founder, email: 'ELENA@EXAMPLE.COM' })),
      'email_taken',
    );
  });
});

test('a weak password is refused before any row is written', async () => {
  await withDb(async (db) => {
    assert.equal(reason(await register(db, { ...founder, password: 'password1' })), 'weak_password');
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from app_user`);
    assert.equal(Number(rows[0]!.n), 0, 'a rejected registration must leave nothing behind');
  });
});

/* ---------------------------------------------------------------- login */

test('login succeeds with the right password and fails with the wrong one', async () => {
  await withDb(async (db) => {
    ok(await register(db, founder));
    ok(await login(db, { email: founder.email, password: founder.password, now: NOW }));
    assert.equal(
      reason(await login(db, { email: founder.email, password: 'wrong password here', now: NOW })),
      'invalid_credentials',
    );
  });
});

test('an unknown email and a wrong password are indistinguishable', async () => {
  await withDb(async (db) => {
    ok(await register(db, founder));

    const unknown = await login(db, { email: 'nobody@example.com', password: founder.password, now: NOW });
    const wrong = await login(db, { email: founder.email, password: 'wrong password here', now: NOW });

    // Same reason: the message must not reveal which half was wrong.
    assert.equal(reason(unknown), 'invalid_credentials');
    assert.equal(reason(wrong), 'invalid_credentials');
  });
});

test('an unknown email still burns hashing time, so accounts cannot be enumerated by clock', async () => {
  await withDb(async (db) => {
    ok(await register(db, founder));

    const time = async (email: string): Promise<number> => {
      const started = performance.now();
      await login(db, { email, password: 'some wrong password', now: NOW });
      return performance.now() - started;
    };

    // Warm up, then measure: the point is orders of magnitude, not precision.
    await time(founder.email);
    const known = await time(founder.email);
    const unknown = await time('nobody@example.com');

    assert.ok(
      unknown > known / 4,
      `an unknown email returned far too fast (${unknown.toFixed(1)}ms vs ${known.toFixed(1)}ms) — ` +
        'that difference is an account-enumeration oracle',
    );
  });
});

/* -------------------------------------------------------------- sessions */

test('a session cookie resolves to its user, and a forged one does not', async () => {
  await withDb(async (db) => {
    const { token, user } = ok(await register(db, founder));

    const resolved = await resolveSession(db, token, NOW);
    assert.equal(resolved?.user.id, user.id);

    const [id, secret] = token.split('.') as [string, string];
    for (const forged of [
      `${id}.${secret.slice(0, -1)}x`,            // right session, wrong secret
      `${id}.`,                                    // no secret at all
      id,                                          // id alone
      `00000000-0000-4000-8000-000000000000.${secret}`, // right secret, wrong session
      'not-a-uuid.whatever',
      '',
    ]) {
      assert.equal(await resolveSession(db, forged, NOW), null, `forged cookie accepted: ${forged}`);
    }
  });
});

test('the database stores only a hash of the session secret', async () => {
  await withDb(async (db) => {
    const { token } = ok(await register(db, founder));
    const secret = token.slice(token.indexOf('.') + 1);

    const { rows } = await db.query<{ token_hash: string }>(`select token_hash from session`);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.token_hash, secret, 'a stolen backup must not be a stack of live sessions');
    assert.equal(rows[0]!.token_hash.includes(secret), false);
  });
});

test('an expired session stops working and is cleaned up on sight', async () => {
  await withDb(async (db) => {
    const { token } = ok(await register(db, founder));

    assert.ok(await resolveSession(db, token, later(SESSION_TTL_MS - 1000)));
    assert.equal(await resolveSession(db, token, later(SESSION_TTL_MS + 1000)), null);

    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from session`);
    assert.equal(Number(rows[0]!.n), 0, 'an expired session should not linger in the table');
  });
});

test('signing out invalidates that cookie immediately', async () => {
  await withDb(async (db) => {
    const { token } = ok(await register(db, founder));
    const session = (await resolveSession(db, token, NOW))!;
    await endSession(db, session.sessionId);
    assert.equal(await resolveSession(db, token, NOW), null);
  });
});

test('signing out everywhere kills every session but leaves the account', async () => {
  await withDb(async (db) => {
    const { user } = ok(await register(db, founder));
    const a = ok(await login(db, { email: founder.email, password: founder.password, now: NOW }));
    const b = ok(await login(db, { email: founder.email, password: founder.password, now: NOW }));

    assert.equal(await endAllSessions(db, user.id), 3, 'registration opened one too');
    assert.equal(await resolveSession(db, a.token, NOW), null);
    assert.equal(await resolveSession(db, b.token, NOW), null);

    // The account still exists and can log back in.
    ok(await login(db, { email: founder.email, password: founder.password, now: NOW }));
  });
});

test('purging expired sessions leaves live ones alone', async () => {
  await withDb(async (db) => {
    const { token } = ok(await register(db, founder));
    assert.equal(await purgeExpiredSessions(db, NOW), 0);
    assert.ok(await resolveSession(db, token, NOW));
    assert.equal(await purgeExpiredSessions(db, later(SESSION_TTL_MS + 1)), 1);
  });
});

/* ---------------------------------------------------------------- actor */

test('a logged-in user cannot reach a household by changing the id', async () => {
  await withDb(async (db) => {
    const mine = ok(await register(db, founder));
    const theirs = ok(await register(db, {
      ...founder, email: 'other@example.com', displayName: 'Other',
      household: { create: { name: 'Other House', timezone: 'UTC' } },
    }));

    const session = (await resolveSession(db, mine.token, NOW))!;
    assert.ok(await resolveActor(db, session, mine.household.id));
    assert.equal(
      await resolveActor(db, session, theirs.household.id),
      null,
      'membership, not the URL, decides which household you are in',
    );
    assert.equal(
      await resolveActor(db, session, '00000000-0000-4000-8000-000000000000'),
      null,
    );
  });
});

test('a deactivated member cannot act, even with a valid session', async () => {
  await withDb(async (db) => {
    const { token, household, member } = ok(await register(db, founder));
    const session = (await resolveSession(db, token, NOW))!;
    assert.ok(await resolveActor(db, session, household.id));

    await db.transaction((tx) => repo.updateMember(tx, household.id, member.id, { active: false }));
    assert.equal(await resolveActor(db, session, household.id), null);
  });
});

/* ---------------------------------------------------------- invitations */

test('an invitation lets somebody join with the role it was minted for', async () => {
  await withDb(async (db) => {
    const owner = ok(await register(db, founder));
    const { token } = await createInvitation(db, {
      householdId: owner.household.id, createdBy: owner.member.id, role: 'teen', now: NOW,
    });

    const preview = ok(await previewInvitation(db, token, NOW));
    assert.equal(preview.householdName, 'Michel');
    assert.equal(preview.role, 'teen');

    const joined = ok(await register(db, {
      email: 'ana@example.com', password: 'another good passphrase', displayName: 'Ana',
      household: { joinToken: token }, now: NOW,
    }));
    assert.equal(joined.household.id, owner.household.id);
    assert.equal(joined.member.role, 'teen', 'the invitation decides the role, not the joiner');
  });
});

test('an invitation cannot be used twice', async () => {
  await withDb(async (db) => {
    const owner = ok(await register(db, founder));
    const { token } = await createInvitation(db, {
      householdId: owner.household.id, createdBy: owner.member.id, role: 'adult', now: NOW,
    });

    ok(await register(db, {
      email: 'first@example.com', password: 'another good passphrase', displayName: 'First',
      household: { joinToken: token }, now: NOW,
    }));
    assert.equal(
      reason(await register(db, {
        email: 'second@example.com', password: 'another good passphrase', displayName: 'Second',
        household: { joinToken: token }, now: NOW,
      })),
      'invitation_used',
    );
  });
});

test('an expired or invented invitation is refused', async () => {
  await withDb(async (db) => {
    const owner = ok(await register(db, founder));
    const { token } = await createInvitation(db, {
      householdId: owner.household.id, createdBy: owner.member.id, role: 'adult', now: NOW,
    });

    assert.equal(
      reason(await previewInvitation(db, token, later(INVITATION_TTL_MS + 1000))),
      'invitation_expired',
    );
    assert.equal(reason(await previewInvitation(db, 'invented-token', NOW)), 'invitation_invalid');
    assert.equal(reason(await previewInvitation(db, '', NOW)), 'invitation_invalid');
  });
});

test('the database stores only a hash of the invitation token', async () => {
  await withDb(async (db) => {
    const owner = ok(await register(db, founder));
    const { token } = await createInvitation(db, {
      householdId: owner.household.id, createdBy: owner.member.id, role: 'adult', now: NOW,
    });
    const { rows } = await db.query<{ token_hash: string }>(`select token_hash from invitation`);
    assert.notEqual(rows[0]!.token_hash, token, 'a leaked backup must not be a set of working invites');
  });
});

test('accepting an invitation you already have membership for does not duplicate you', async () => {
  await withDb(async (db) => {
    const owner = ok(await register(db, founder));
    const { token } = await createInvitation(db, {
      householdId: owner.household.id, createdBy: owner.member.id, role: 'adult', now: NOW,
    });

    const result = ok(await acceptInvitation(db, { token, user: owner.user, now: NOW }));
    assert.equal(result.member.id, owner.member.id, 'should return the existing membership');
    assert.equal(result.member.role, 'owner', 'and must not demote an owner to the invited role');

    const members = await repo.listMembers(db, owner.household.id);
    assert.equal(members.length, 1);
  });
});

/* ------------------------------------------------------- password change */

test('changing a password ends every other session but keeps the current one', async () => {
  await withDb(async (db) => {
    const registered = ok(await register(db, founder));
    const other = ok(await login(db, { email: founder.email, password: founder.password, now: NOW }));
    const current = (await resolveSession(db, registered.token, NOW))!;

    const result = ok(await changePassword(db, {
      userId: registered.user.id,
      currentPassword: founder.password,
      newPassword: 'a different quiet horse',
      keepSessionId: current.sessionId,
    }));
    assert.ok(result.sessionsEnded >= 1);

    assert.equal(await resolveSession(db, other.token, NOW), null, 'the other device is signed out');
    assert.ok(await resolveSession(db, registered.token, NOW), 'the device in use stays signed in');

    assert.equal(
      reason(await login(db, { email: founder.email, password: founder.password, now: NOW })),
      'invalid_credentials',
    );
    ok(await login(db, { email: founder.email, password: 'a different quiet horse', now: NOW }));
  });
});

test('a password change with the wrong current password changes nothing', async () => {
  await withDb(async (db) => {
    const registered = ok(await register(db, founder));
    assert.equal(
      reason(await changePassword(db, {
        userId: registered.user.id,
        currentPassword: 'not the current password',
        newPassword: 'a different quiet horse',
      })),
      'invalid_credentials',
    );
    ok(await login(db, { email: founder.email, password: founder.password, now: NOW }));
  });
});

test('a password change to a weak password is refused', async () => {
  await withDb(async (db) => {
    const registered = ok(await register(db, founder));
    assert.equal(
      reason(await changePassword(db, {
        userId: registered.user.id, currentPassword: founder.password, newPassword: 'password1',
      })),
      'weak_password',
    );
  });
});
