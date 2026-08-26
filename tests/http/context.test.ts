/**
 * The request context: field parsing and the local-time conversion (Agent B3).
 *
 * `guard()` — the authorization chokepoint this file also holds — is covered
 * end-to-end in `api.test.ts`, where it is exercised through real sessions and
 * real roles rather than a hand-built context; that is the only way to test it
 * honestly, since its whole job is to combine three lookups.
 *
 * What is tested here is everything else: the field readers, which decide what
 * a form is allowed to say, and `localToInstant`, which is the one piece of
 * arithmetic in the codebase that is easy to get subtly, seasonally wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fromIssues, instantField, int, localToInstant, optionalStr, str,
} from '../../server/api/context.ts';

/* --------------------------------------------------------------- fields */

test('str trims, and treats blank as absent', () => {
  assert.equal(str({ name: '  Piano  ' }, 'name'), 'Piano');
  assert.equal(str({ name: '   ' }, 'name'), null);
  assert.equal(str({ name: '' }, 'name'), null);
  assert.equal(str({}, 'name'), null);
  assert.equal(str(null, 'name'), null);
});

test('str refuses a non-string rather than coercing it', () => {
  // `String(value)` here would turn `{}` into "[object Object]" and store it as
  // somebody's event title.
  assert.equal(str({ name: 42 }, 'name'), null);
  assert.equal(str({ name: ['a'] }, 'name'), null);
  assert.equal(str({ name: { toString: () => 'x' } }, 'name'), null);
  assert.equal(str({ name: true }, 'name'), null);
});

test('str enforces a maximum length', () => {
  assert.equal(str({ name: 'x'.repeat(40) }, 'name', 40), 'x'.repeat(40));
  assert.equal(str({ name: 'x'.repeat(41) }, 'name', 40), null);
});

test('optionalStr is undefined rather than null, so it can be spread away', () => {
  // The difference matters: an optional key must be OMITTED, not set to
  // undefined, or `deepStrictEqual` against a contract shape stops holding.
  assert.equal(optionalStr({ notes: '' }, 'notes'), undefined);
  assert.equal(optionalStr({ notes: 'hello' }, 'notes'), 'hello');
  assert.ok(!('notes' in { ...(optionalStr({}, 'notes') ? { notes: 'x' } : {}) }));
});

test('int accepts a numeric string, because that is what a form sends', () => {
  assert.equal(int({ qty: '3' }, 'qty'), 3);
  assert.equal(int({ qty: 3 }, 'qty'), 3);
  assert.equal(int({ qty: -2 }, 'qty'), -2);
  assert.equal(int({ qty: 0 }, 'qty'), 0);
});

test('int refuses anything that is not a whole number', () => {
  for (const value of ['3.5', 3.5, 'three', '', ' ', null, undefined, NaN, Infinity, '1e400', {}, []]) {
    assert.equal(int({ qty: value }, 'qty'), null, `accepted ${JSON.stringify(value)}`);
  }
});

test('an empty form field is absent, not zero', () => {
  // `Number('')` is 0. Reading a blank input as a real value meant an untouched
  // quantity box arrived as a movement of zero units instead of a 422.
  assert.equal(int({ qty: '' }, 'qty'), null);
  assert.equal(int({ qty: '   ' }, 'qty'), null);
  assert.equal(int({ qty: '\n' }, 'qty'), null);
  // A typed zero is still a zero.
  assert.equal(int({ qty: '0' }, 'qty'), 0);
});

/* ------------------------------------------------------------ local time */

test('a wall-clock time becomes the right instant in a summer zone', () => {
  // 16:00 in New York in September is EDT, UTC-4.
  assert.equal(
    localToInstant({ year: 2026, month: 9, day: 8, hour: 16, minute: 0 }, 'America/New_York'),
    '2026-09-08T20:00:00.000Z',
  );
});

test('the same wall-clock time becomes a different instant in winter', () => {
  // 16:00 in January is EST, UTC-5. A conversion that used a fixed offset — or
  // the server's own zone — would put this an hour out for half the year.
  assert.equal(
    localToInstant({ year: 2026, month: 1, day: 8, hour: 16, minute: 0 }, 'America/New_York'),
    '2026-01-08T21:00:00.000Z',
  );
});

test('a time on the spring-forward boundary lands correctly', () => {
  // 2026-03-08, US DST starts at 02:00 local. 03:00 exists; the first
  // correction pass can itself cross the jump, which is why there are two.
  assert.equal(
    localToInstant({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, 'America/New_York'),
    '2026-03-08T07:00:00.000Z',
  );
});

test('a time in the autumn repeated hour resolves to one of the two, deterministically', () => {
  // 2026-11-01 01:30 happens twice in New York. There is no right answer, but
  // there must be a stable one — an ambiguous time that flipped between calls
  // would move an appointment by an hour at random.
  const first = localToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  const second = localToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  assert.equal(first, second);
  assert.ok(first === '2026-11-01T05:30:00.000Z' || first === '2026-11-01T06:30:00.000Z');
});

test('out-of-range fields are refused instead of rolling over', () => {
  // Date.UTC(2026, 12, 45, ...) is a real instant in February 2027. Accepting
  // it put an event eight months from where the person meant it, with a 201.
  const bad = [
    { year: 2026, month: 13, day: 1, hour: 0, minute: 0 },
    { year: 2026, month: 0, day: 1, hour: 0, minute: 0 },
    { year: 2026, month: 9, day: 31, hour: 0, minute: 0 },   // September has 30
    { year: 2026, month: 2, day: 29, hour: 0, minute: 0 },   // 2026 is not a leap year
    { year: 2026, month: 9, day: 0, hour: 0, minute: 0 },
    { year: 2026, month: 9, day: 8, hour: 24, minute: 0 },
    { year: 2026, month: 9, day: 8, hour: 0, minute: 60 },
    { year: 20260, month: 9, day: 8, hour: 0, minute: 0 },
  ];
  for (const fields of bad) {
    assert.equal(localToInstant(fields, 'UTC'), null, `accepted ${JSON.stringify(fields)}`);
  }
});

test('a real leap day is still accepted', () => {
  assert.equal(
    localToInstant({ year: 2028, month: 2, day: 29, hour: 12, minute: 0 }, 'UTC'),
    '2028-02-29T12:00:00.000Z',
  );
});

test('UTC is a no-op', () => {
  assert.equal(
    localToInstant({ year: 2026, month: 9, day: 8, hour: 16, minute: 0 }, 'UTC'),
    '2026-09-08T16:00:00.000Z',
  );
});

test('an unknown zone is null rather than a silent fallback to the server zone', () => {
  assert.equal(localToInstant({ year: 2026, month: 9, day: 8, hour: 16, minute: 0 }, 'Mars/Olympus'), null);
});

/* ---------------------------------------------------------- instantField */

test('instantField accepts what a datetime-local input sends', () => {
  assert.equal(
    instantField({ startsAt: '2026-09-08T16:00' }, 'startsAt', 'America/New_York'),
    '2026-09-08T20:00:00.000Z',
  );
});

test('instantField passes an explicit offset through unchanged', () => {
  // Already an instant: the household zone is irrelevant and must not be
  // applied a second time.
  assert.equal(
    instantField({ startsAt: '2026-09-08T20:00:00Z' }, 'startsAt', 'America/New_York'),
    '2026-09-08T20:00:00.000Z',
  );
  assert.equal(
    instantField({ startsAt: '2026-09-08T16:00:00-04:00' }, 'startsAt', 'America/New_York'),
    '2026-09-08T20:00:00.000Z',
  );
});

test('instantField refuses what it cannot understand', () => {
  for (const value of ['next tuesday', '', '   ', '2026-13-45T99:99', 42, null, undefined, {}]) {
    assert.equal(
      instantField({ startsAt: value }, 'startsAt', 'UTC'), null,
      `accepted ${JSON.stringify(value)}`,
    );
  }
});

/* ----------------------------------------------------------- fromIssues */

test('a permission issue becomes 403 and a tenant issue becomes 404', () => {
  assert.equal(fromIssues([{ code: 'permission', path: 'x', message: 'no' }]).status, 403);
  // 404, not 403: a cross-household denial must not confirm the row exists.
  assert.equal(fromIssues([{ code: 'tenant', path: 'x', message: 'no' }]).status, 404);
});

test('tenant wins over permission when both are present', () => {
  assert.equal(
    fromIssues([
      { code: 'permission', path: 'x', message: 'no' },
      { code: 'tenant', path: 'y', message: 'no' },
    ]).status,
    404,
  );
});

test('validation issues come back all at once', () => {
  const reply = fromIssues([
    { code: 'invalid', path: 'title', message: 'A title is required.' },
    { code: 'invalid', path: 'endsAt', message: 'The end must be after the start.' },
  ]);
  assert.equal(reply.status, 422);

  const body = JSON.parse(String(reply.body)) as { error: { issues: unknown[] } };
  // A form that reports its problems one per submit is a form people abandon.
  assert.equal(body.error.issues.length, 2);
});
