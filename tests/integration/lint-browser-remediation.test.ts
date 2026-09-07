// Cross-module behavior parity, including HTTP/database and browser-module exports.
// These Node tests do not claim real-browser execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAction } from '../../domains/ai/validator.ts';
import { pad } from '../../tools/swarm/ui.ts';
import { call, registerOwner, startHarness } from '../http/harness.ts';

test('text validation preserves the exact original control-character boundary for every UTF-16 code unit', () => {
  // Enumerate the original rejection set independently; TAB/LF/CR and C1 stay unchanged.
  const rejected = new Set([...Array.from({ length: 9 }, (_, n) => n), 11, 12,
    ...Array.from({ length: 18 }, (_, n) => n + 14), 127]);
  for (let code = 0; code <= 65535; code += 1) {
    const name = 'before' + String.fromCharCode(code) + 'after';
    const verdict = validateAction({ type: 'add_shopping_item', confidence: 0.99,
      rationale: 'synthetic regression', payload: { name, quantity: 1 } }, {
      householdId: 'hh_test', actorMemberId: 'member_test', now: '2026-09-07T12:00:00.000Z',
      can: () => true,
    });
    const controlError = verdict.errors.some(e => e.path === 'payload.name' && e.message === 'Must not contain control characters.');
    assert.equal(controlError, rejected.has(code), 'UTF-16 code unit ' + code);
    if (!rejected.has(code)) assert.notEqual(verdict.decision, 'reject', 'allowed code unit ' + code);
  }
});

test('terminal padding strips only ESC plus single numeric SGR and preserves unsupported sequences', () => {
  const escape = String.fromCharCode(27);
  for (let code = 0; code <= 255; code += 1) {
    const value = String.fromCharCode(code) + '[31mtext';
    const visibleLength = code === 27 ? 4 : value.length;
    assert.equal(pad(value, 20), value + ' '.repeat(20 - visibleLength));
  }
  const cases: Array<[string, number]> = [
    [escape + '[31mtext' + escape + '[0m', 4],
    [escape + '[000m' + escape + '[9mx', 1],
    [escape + escape + '[31mx', 2],
    [escape + '[mx', 4],
    [escape + '[1;31mx', 8],
    [escape + '[31x', 5],
    ['[31mtext', 8],
    [escape + '[31m[32mx', 5],
    ['plain', 5],
    ['', 0],
  ];
  for (const [value, visibleLength] of cases) {
    assert.equal(pad(value, 25), value + ' '.repeat(25 - visibleLength));
    assert.equal(pad(value, 0), value);
  }
});

test('the actual browser API module preserves network, auth and successful-response semantics', async (t) => {
  const { api } = await import(new URL('../../public/lib/api.js', import.meta.url).href);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic network failure'); });
  await assert.rejects(api.get('/synthetic'), { name: 'ApiError', status: 0, code: 'offline' });
  fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'Sign in' } }), { status: 401 }));
  await assert.rejects(api.get('/synthetic'), { name: 'ApiError', status: 401, code: 'unauthenticated' });
  fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ value: 'retained' }), { status: 200 }));
  assert.deepEqual(await api.get('/synthetic'), { value: 'retained' });
});

test('domain create routes still generate database IDs and preserve payload fields after omission', async (t) => {
  const h = await startHarness(); t.after(() => h.close());
  const owner = await registerOwner(h);
  const cases = [
    { route: 'shopping', body: { name: 'Synthetic milk', quantity: 3, store: 'Fixture store', listName: 'Fixture list' } },
    { route: 'errands', body: { title: 'Synthetic errand', location: 'Fixture location' } },
    { route: 'reminders', body: { title: 'Synthetic reminder', dueAt: '2026-09-08T12:00:00.000Z' } },
  ];
  for (const fixture of cases) {
    const response = await call<Record<string, unknown>>(h, '/api/households/' + owner.householdId + '/' + fixture.route,
      { method: 'POST', token: owner.token, body: { ...fixture.body, id: 'caller-must-not-choose-id' } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.match(String(response.body.id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(response.body.householdId, owner.householdId);
    for (const [key, value] of Object.entries(fixture.body)) assert.deepEqual(response.body[key], value, key);
  }
});
