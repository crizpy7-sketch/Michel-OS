/**
 * The API tier, over a real socket (Agent B3).
 *
 * These are the tests that would catch the failures that actually matter in a
 * family calendar: someone seeing another household's data, a child editing the
 * schedule, a page on the internet posting to the app, a household locking
 * itself out by demoting its last owner. The happy paths are covered too, but
 * they are not why this file is long.
 *
 * Every case goes through `fetch` against a listening server, so `dispatch`,
 * the CSRF check, the cookie round-trip and the security headers are all in the
 * path — see `harness.ts` for why that is worth the seconds it costs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { call, joinHousehold, registerOwner, startHarness, tokenFrom, type Harness } from './harness.ts';

const NOW = '2026-09-07T12:00:00.000Z';

/* ================================================================ session */

test('a request with no session is refused before anything is read', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const response = await call(h, `/api/households/${owner.householdId}`);
  assert.equal(response.status, 401);
});

test('a forged session cookie is refused', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  // The cookie is `<id>.<secret>`; the id is real, the secret is not. This is
  // the shape an attacker who saw a session id in a log would try.
  const [id] = owner.token.split('.');
  const response = await call(h, `/api/households/${owner.householdId}`, {
    token: `${id}.not-the-real-secret`,
  });
  assert.equal(response.status, 401);
});

test('logging out invalidates the cookie the client still holds', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  assert.equal((await call(h, '/api/me', { token: owner.token })).status, 200);
  assert.equal((await call(h, '/api/auth/logout', { method: 'POST', token: owner.token })).status, 200);
  // The client keeps sending the old cookie; the server must not honour it.
  assert.equal((await call(h, '/api/me', { token: owner.token })).status, 401);
});

test('a session past its expiry stops working without anyone deleting it', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  assert.equal((await call(h, '/api/me', { token: owner.token })).status, 200);
  h.setNow('2026-12-31T00:00:00.000Z');
  assert.equal((await call(h, '/api/me', { token: owner.token })).status, 401);
});

test('login is not an account oracle', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h, { email: 'real@example.com' });

  const wrongPassword = await call<{ error: { message: string } }>(h, '/api/auth/login', {
    method: 'POST', body: { email: owner.email, password: 'not-the-password' },
  });
  const noSuchUser = await call<{ error: { message: string } }>(h, '/api/auth/login', {
    method: 'POST', body: { email: 'nobody@example.com', password: 'not-the-password' },
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  // Identical, so the response cannot be used to enumerate who has an account.
  assert.deepEqual(wrongPassword.body, noSuchUser.body);
});

/* ================================================================ tenancy */

test('a household you are not in is 404, not 403', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const mine = await registerOwner(h, { householdName: 'Michel' });
  const theirs = await registerOwner(h, { householdName: 'Someone Else' });

  const response = await call(h, `/api/households/${theirs.householdId}`, { token: mine.token });
  // 403 would confirm the id names a real household, which turns the URL into
  // an oracle for guessing them.
  assert.equal(response.status, 404);
});

test('every household-scoped route rejects a foreign household id', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const mine = await registerOwner(h);
  const theirs = await registerOwner(h);

  const paths = [
    'occurrences', 'conflicts', 'brief', 'members', 'shopping', 'errands',
    'reminders', 'inbox', 'notifications', 'search?q=x', 'business',
  ];
  for (const path of paths) {
    const response = await call(h, `/api/households/${theirs.householdId}/${path}`, { token: mine.token });
    assert.equal(response.status, 404, `GET ${path} leaked across households`);
  }

  const created = await call(h, `/api/households/${theirs.householdId}/events`, {
    method: 'POST', token: mine.token,
    body: { title: 'Injected', domain: 'general', startsAt: '2026-09-09T10:00', endsAt: '2026-09-09T11:00' },
  });
  assert.equal(created.status, 404);
});

test("an event created in one household is invisible from the other", async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const mine = await registerOwner(h);
  const theirs = await registerOwner(h);

  await call(h, `/api/households/${mine.householdId}/events`, {
    method: 'POST', token: mine.token,
    body: { title: 'Dentist', domain: 'appointments', startsAt: '2026-09-09T10:00', endsAt: '2026-09-09T11:00' },
  });

  const search = await call<{ hits: unknown[] }>(
    h, `/api/households/${theirs.householdId}/search?q=Dentist`, { token: theirs.token },
  );
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.hits, []);
});

/* ============================================================ permissions */

test('a child may read the calendar and may not write to it', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const owner = await registerOwner(h);
  const child = await joinHousehold(h, owner, 'child');

  assert.equal((await call(h, `/api/households/${owner.householdId}/occurrences`, { token: child.token })).status, 200);

  const attempt = await call(h, `/api/households/${owner.householdId}/events`, {
    method: 'POST', token: child.token,
    body: { title: 'Bedtime abolished', domain: 'general', startsAt: '2026-09-09T22:00', endsAt: '2026-09-09T23:00' },
  });
  assert.equal(attempt.status, 403);
});

test('a teen cannot read the business ledger', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const owner = await registerOwner(h);
  const teen = await joinHousehold(h, owner, 'teen');

  await call(h, `/api/households/${owner.householdId}/business`, {
    method: 'POST', token: owner.token, body: { name: 'Shia Baby' },
  });

  assert.equal((await call(h, `/api/households/${owner.householdId}/business/finance`, { token: teen.token })).status, 403);
  assert.equal((await call(h, `/api/households/${owner.householdId}/business/finance`, { token: owner.token })).status, 200);
});

test('search returns only the entities the searcher is allowed to see', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const owner = await registerOwner(h);
  const teen = await joinHousehold(h, owner, 'teen');

  await call(h, `/api/households/${owner.householdId}/business`, {
    method: 'POST', token: owner.token, body: { name: 'Shia Baby' },
  });
  await call(h, `/api/households/${owner.householdId}/business/expenses`, {
    method: 'POST', token: owner.token,
    body: { vendor: 'Sprinkles Wholesale', category: 'supplies', amountCents: 4200 },
  });

  const asOwner = await call<{ hits: Array<{ entity: string }> }>(
    h, `/api/households/${owner.householdId}/search?q=Sprinkles`, { token: owner.token },
  );
  const asTeen = await call<{ hits: Array<{ entity: string }> }>(
    h, `/api/households/${owner.householdId}/search?q=Sprinkles`, { token: teen.token },
  );

  assert.ok(asOwner.body.hits.some((hit) => hit.entity === 'expense'),
    'an owner should find the expense');
  // The teen is in the same household and the row is in the same index. The
  // only thing keeping it out of this result is the permission filter.
  assert.equal(asTeen.body.hits.filter((hit) => hit.entity === 'expense').length, 0);
});

/* ========================================================== last owner */

test('a household refuses to demote its only owner', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const owner = await registerOwner(h);
  const demote = await call<{ error: { code: string } }>(
    h, `/api/households/${owner.householdId}/members/${owner.memberId}`,
    { method: 'PATCH', token: owner.token, body: { role: 'adult' } },
  );

  assert.equal(demote.status, 409);
  assert.equal(demote.body.error.code, 'last_owner');
});

test('demotion is allowed once a second owner exists', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const owner = await registerOwner(h);
  await joinHousehold(h, owner, 'owner');

  const demote = await call(
    h, `/api/households/${owner.householdId}/members/${owner.memberId}`,
    { method: 'PATCH', token: owner.token, body: { role: 'adult' } },
  );
  assert.equal(demote.status, 200);
});

test('an adult with member.manage still cannot mint an owner', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const owner = await registerOwner(h);
  const adult = await joinHousehold(h, owner, 'adult');

  // `member.manage` is enough to invite people; it must not be a path to
  // granting yourself a peer who can then remove you.
  const invite = await call(h, `/api/households/${owner.householdId}/invitations`, {
    method: 'POST', token: adult.token, body: { role: 'owner' },
  });
  assert.equal(invite.status, 403);

  const promote = await call(h, `/api/households/${owner.householdId}/members/${adult.memberId}`, {
    method: 'PATCH', token: adult.token, body: { role: 'owner' },
  });
  assert.equal(promote.status, 403);
});

/* ================================================================== CSRF */

test('a cross-site POST is refused even with a valid session cookie', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const response = await call(h, `/api/households/${owner.householdId}/events`, {
    method: 'POST', token: owner.token,
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { title: 'From evil.example', domain: 'general', startsAt: '2026-09-09T10:00', endsAt: '2026-09-09T11:00' },
  });
  assert.equal(response.status, 403);
});

test('a POST with a foreign Origin and no Sec-Fetch-Site is refused', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const response = await call(h, `/api/households/${owner.householdId}/events`, {
    method: 'POST', token: owner.token, origin: 'https://evil.example',
    headers: { 'sec-fetch-site': '' },
    body: { title: 'x', domain: 'general', startsAt: '2026-09-09T10:00', endsAt: '2026-09-09T11:00' },
  });
  assert.equal(response.status, 403);
});

test('a GET is never refused for CSRF', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const response = await call(h, `/api/households/${owner.householdId}/occurrences`, {
    token: owner.token, noOrigin: true, headers: { 'sec-fetch-site': '' },
  });
  assert.equal(response.status, 200);
});

/* ============================================================== calendar */

test('a wall-clock time is stored as the right instant for the household zone', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h, { timezone: 'America/New_York' });

  const created = await call<{ startsAt: string }>(h, `/api/households/${owner.householdId}/events`, {
    method: 'POST', token: owner.token,
    body: { title: 'Recital', domain: 'practice', startsAt: '2026-09-08T16:00', endsAt: '2026-09-08T17:00' },
  });

  assert.equal(created.status, 201);
  // 16:00 in New York in September is EDT, UTC-4.
  assert.equal(created.body.startsAt, '2026-09-08T20:00:00.000Z');
});

test('a recurring event expands into the window without being stored per occurrence', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  await call(h, `/api/households/${owner.householdId}/events`, {
    method: 'POST', token: owner.token,
    body: {
      title: 'Piano', domain: 'practice',
      startsAt: '2026-09-08T16:00', endsAt: '2026-09-08T17:00',
      recurrence: { frequency: 'weekly', interval: 1, byWeekday: ['TU'] },
    },
  });

  const response = await call<{ occurrences: Array<{ title: string }> }>(
    h, `/api/households/${owner.householdId}/occurrences?from=2026-09-07T00:00:00Z&to=2026-10-06T00:00:00Z`,
    { token: owner.token },
  );

  assert.equal(response.status, 200);
  const piano = response.body.occurrences.filter((o) => o.title === 'Piano');
  // Four Tuesdays: 8, 15, 22, 29 September.
  assert.equal(piano.length, 4);
});

test('the contract\'s own recurrence shape is accepted, not silently dropped', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  // A form posts flat fields; a fetch() posts the contract's RecurrenceRule.
  // Both have to work, and an earlier version accepted only the first — the
  // second got a 201 and a single non-repeating event.
  const nested = await call(h, `/api/households/${owner.householdId}/events`, {
    method: 'POST', token: owner.token,
    body: {
      title: 'Nested', domain: 'practice',
      startsAt: '2026-09-08T16:00', endsAt: '2026-09-08T17:00',
      recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: ['TU'] },
    },
  });
  assert.equal(nested.status, 201);

  const flat = await call(h, `/api/households/${owner.householdId}/events`, {
    method: 'POST', token: owner.token,
    body: {
      title: 'Flat', domain: 'practice',
      startsAt: '2026-09-09T16:00', endsAt: '2026-09-09T17:00',
      recurrenceFreq: 'WEEKLY', recurrenceInterval: '1', recurrenceByWeekday: 'WE',
    },
  });
  assert.equal(flat.status, 201);

  const response = await call<{ occurrences: Array<{ title: string }> }>(
    h, `/api/households/${owner.householdId}/occurrences?from=2026-09-07T00:00:00Z&to=2026-10-06T00:00:00Z`,
    { token: owner.token },
  );
  assert.equal(response.body.occurrences.filter((o) => o.title === 'Nested').length, 4);
  assert.equal(response.body.occurrences.filter((o) => o.title === 'Flat').length, 4);
});

test('an unusable repeat rule is refused rather than quietly ignored', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const cases: unknown[] = [
    { freq: 'FORTNIGHTLY', interval: 1 },
    { freq: 'YEARLY', interval: 1 },          // the engine cannot expand it
    { freq: 'WEEKLY', interval: 0 },
    { freq: 'WEEKLY', interval: 1, byWeekday: ['FUNDAY'] },
    { freq: 'WEEKLY', interval: 1, until: 'next summer' },
    'weekly please',
  ];

  for (const recurrence of cases) {
    const response = await call(h, `/api/households/${owner.householdId}/events`, {
      method: 'POST', token: owner.token,
      body: {
        title: 'Bad rule', domain: 'general',
        startsAt: '2026-09-08T16:00', endsAt: '2026-09-08T17:00',
        recurrence,
      },
    });
    assert.equal(response.status, 422, `accepted ${JSON.stringify(recurrence)}`);
  }
});

test('an absurd window is clamped instead of expanding a million occurrences', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const response = await call<{ window: { from: string; to: string } }>(
    h, `/api/households/${owner.householdId}/occurrences?from=2000-01-01T00:00:00Z&to=2200-01-01T00:00:00Z`,
    { token: owner.token },
  );

  assert.equal(response.status, 200);
  const span = Date.parse(response.body.window.to) - Date.parse(response.body.window.from);
  assert.ok(span <= 400 * 24 * 3600_000, `window was ${span}ms`);
});

test('two events on one person in the same hour are reported as a conflict', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  for (const title of ['Dentist', 'Soccer']) {
    const response = await call(h, `/api/households/${owner.householdId}/events`, {
      method: 'POST', token: owner.token,
      body: {
        title, domain: 'appointments',
        startsAt: '2026-09-09T10:00', endsAt: '2026-09-09T11:00',
        participantIds: [owner.memberId],
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  const conflicts = await call<{ conflicts: Array<{ kind: string }> }>(
    h, `/api/households/${owner.householdId}/conflicts?from=2026-09-08T00:00:00Z&to=2026-09-11T00:00:00Z`,
    { token: owner.token },
  );

  assert.equal(conflicts.status, 200);
  assert.ok(conflicts.body.conflicts.length > 0, 'the engine should have seen the double-booking');
});

/* ================================================================= lists */

test('a shopping item moves through its states and refuses an impossible one', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const created = await call<{ id: string; status: string }>(
    h, `/api/households/${owner.householdId}/shopping`,
    { method: 'POST', token: owner.token, body: { name: 'Flour', store: 'Costco', quantity: 2 } },
  );
  assert.equal(created.status, 201);

  const bought = await call<{ status: string }>(
    h, `/api/households/${owner.householdId}/shopping/${created.body.id}`,
    { method: 'PATCH', token: owner.token, body: { status: 'purchased' } },
  );
  assert.equal(bought.status, 200);
  assert.equal(bought.body.status, 'purchased');

  const nonsense = await call(
    h, `/api/households/${owner.householdId}/shopping/${created.body.id}`,
    { method: 'PATCH', token: owner.token, body: { status: 'not-a-status' } },
  );
  assert.ok(nonsense.status >= 400, 'an invented status must not be accepted');
});

/* ================================================================= inbox */

test('the inbox classifies without acting', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const response = await call<{ item: { status: string }; proposal: unknown }>(
    h, `/api/households/${owner.householdId}/inbox`,
    {
      method: 'POST', token: owner.token,
      body: { text: 'Soccer practice Tuesday 4pm at the middle school field' },
    },
  );
  assert.equal(response.status, 201);

  // Whatever it proposed, nothing may have been created behind the user's back.
  const occurrences = await call<{ occurrences: unknown[] }>(
    h, `/api/households/${owner.householdId}/occurrences`, { token: owner.token },
  );
  assert.deepEqual(occurrences.body.occurrences, [],
    'classifying an inbox item must not create the event it describes');
});

/* ========================================================= notifications */

test('refreshing notifications twice does not produce two of the same one', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  for (const title of ['Dentist', 'Soccer']) {
    await call(h, `/api/households/${owner.householdId}/events`, {
      method: 'POST', token: owner.token,
      body: {
        title, domain: 'appointments',
        startsAt: '2026-09-08T10:00', endsAt: '2026-09-08T11:00',
        participantIds: [owner.memberId],
      },
    });
  }

  const path = `/api/households/${owner.householdId}/notifications`;
  await call(h, `${path}/refresh`, { method: 'POST', token: owner.token });
  const afterFirst = await call<{ notifications: unknown[] }>(h, path, { token: owner.token });
  await call(h, `${path}/refresh`, { method: 'POST', token: owner.token });
  const afterSecond = await call<{ notifications: unknown[] }>(h, path, { token: owner.token });

  assert.ok(afterFirst.body.notifications.length > 0, 'the conflict should have produced a notification');
  // The refresh runs on every page load. If it were not idempotent the family
  // would be nagged once per navigation, which is exactly how people learn to
  // ignore notifications.
  assert.equal(afterSecond.body.notifications.length, afterFirst.body.notifications.length);
});

/* ============================================================== business */

test('the ledger is in integer cents from end to end', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  await call(h, `/api/households/${owner.householdId}/business`, {
    method: 'POST', token: owner.token, body: { name: 'Shia Baby' },
  });

  const product = await call<{ id: string }>(h, `/api/households/${owner.householdId}/business/products`, {
    method: 'POST', token: owner.token,
    body: { sku: 'CAKE-CHOC', name: 'Chocolate cake', unitPriceCents: 3599, quantityOnHand: 20, reorderPoint: 3 },
  });
  assert.equal(product.status, 201);

  const sale = await call<{ sale: { items: unknown[] }; totalCents: number }>(
    h, `/api/households/${owner.householdId}/business/sales`,
    {
      method: 'POST', token: owner.token,
      body: { items: [{ productId: product.body.id, quantity: 3, unitPriceCents: 3599 }] },
    },
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  // 3 × 3599 exactly. A float pipeline would have produced 10796.999999999998.
  // The total is returned alongside the sale rather than stored on it: the line
  // items are the truth, and a persisted total is a number that can drift away
  // from them after an edit.
  assert.equal(sale.body.totalCents, 10_797);

  // The sale moved stock in the same transaction, so the shelf agrees with the
  // till without a nightly job to reconcile them.
  const inventory = await call<{ products: Array<{ sku: string; quantityOnHand: number }> }>(
    h, `/api/households/${owner.householdId}/business/inventory`, { token: owner.token },
  );
  const cake = inventory.body.products.find((p) => p.sku === 'CAKE-CHOC');
  assert.equal(cake?.quantityOnHand, 17);
});

test('a household with no business gets a clear 404 rather than an empty page', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());
  const owner = await registerOwner(h);

  const response = await call<{ error: { code: string } }>(
    h, `/api/households/${owner.householdId}/business/finance`, { token: owner.token },
  );
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'no_business');
});

/* ================================================================ router */

test('an unknown API path is JSON, not the app shell', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const response = await call<{ error: { code: string } }>(h, '/api/nope');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.body.error.code, 'not_found');
});

test('a known path under the wrong method answers 405 and says what is allowed', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const response = await call(h, '/api/auth/login');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
});

test('the app shell answers a deep link but never shadows the API', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  // A bookmarked or shared client-side route must load the app, not 404.
  const deep = await fetch(`${h.base}/business/inventory`);
  assert.equal(deep.status, 200);
  assert.match(deep.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await deep.text(), /app\.js/);

  // But the same fallback must not swallow an unknown API path, or a fetch()
  // gets a page of markup and a JSON parse error instead of a 404. This has
  // regressed twice — once from an `/api/*` catch-all, once from a `/*` shell
  // route — which is why both halves are pinned here.
  const unknown = await fetch(`${h.base}/api/nope`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('a POST to an unknown path is a 404, not the app shell', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  // The fallback is for browsers asking for a page. A POST is not that.
  const response = await call(h, '/not/a/thing', { method: 'POST', body: {} });
  assert.equal(response.status, 404);
});

test('every response carries the security headers', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const response = await call(h, '/api/health');
  assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('the session cookie is HttpOnly and SameSite', async (t) => {
  const h = await startHarness({ now: NOW });
  t.after(() => h.close());

  const response = await call(h, '/api/auth/register', {
    method: 'POST',
    body: {
      email: 'cookie@example.com', password: 'a-long-enough-passphrase-42',
      displayName: 'Cookie', householdName: 'Cookies', timezone: 'UTC',
    },
  });

  const cookie = response.setCookie ?? '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.ok(tokenFrom(cookie) !== undefined);
});

/* ============================================================ regressions */

test('a body larger than the limit is refused without being buffered', async (t) => {
  const h: Harness = await startHarness({ now: NOW });
  t.after(() => h.close());

  const response = await fetch(`${h.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.equal(response.status, 413);
});
