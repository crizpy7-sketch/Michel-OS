import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, joinHousehold, registerOwner, startHarness, type Agent, type Harness } from './harness.ts';

let h: Harness;
let owner: Agent;
let originalKey: string | undefined;

before(async () => {
  originalKey = process.env['OPENAI_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  h = await startHarness({ now: '2026-08-26T17:00:00.000Z' });
  owner = await registerOwner(h, { timezone: 'America/Chicago' });
});

after(async () => {
  if (originalKey === undefined) delete process.env['OPENAI_API_KEY'];
  else process.env['OPENAI_API_KEY'] = originalKey;
  await h.close();
});

test('Assistant falls back locally, confirms, executes once, and cannot replay', async () => {
  const proposal = await call<{
    actionId: string;
    provider: string;
    executed: boolean;
    proposal: { type: string; payload: Record<string, unknown> };
    verdict: { decision: string };
  }>(h, `/api/households/${owner.householdId}/assistant/propose`, {
    method: 'POST', token: owner.token, body: { text: 'we need milk' },
  });

  assert.equal(proposal.status, 201);
  assert.equal(proposal.body.provider, 'local');
  assert.equal(proposal.body.proposal.type, 'add_shopping_item');
  assert.equal(proposal.body.executed, false);
  assert.equal(proposal.body.verdict.decision, 'confirm');
  assert.ok(proposal.body.actionId.length > 10);

  const beforeExecution = await call<{ items: Array<{ name: string }> }>(
    h, `/api/households/${owner.householdId}/shopping`, { token: owner.token },
  );
  assert.equal(beforeExecution.body.items.length, 0);

  const execution = await call<{ executed: boolean }>(
    h, `/api/households/${owner.householdId}/assistant/actions/${proposal.body.actionId}/execute`, {
      method: 'POST', token: owner.token, body: {},
    },
  );
  assert.equal(execution.status, 200);
  assert.equal(execution.body.executed, true);

  const afterExecution = await call<{ items: Array<{ name: string }> }>(
    h, `/api/households/${owner.householdId}/shopping`, { token: owner.token },
  );
  assert.equal(afterExecution.body.items.length, 1);
  assert.match(afterExecution.body.items[0]?.name ?? '', /milk/i);

  const replay = await call(h, `/api/households/${owner.householdId}/assistant/actions/${proposal.body.actionId}/execute`, {
    method: 'POST', token: owner.token, body: {},
  });
  assert.equal(replay.status, 409);

  const finalList = await call<{ items: Array<{ name: string }> }>(
    h, `/api/households/${owner.householdId}/shopping`, { token: owner.token },
  );
  assert.equal(finalList.body.items.length, 1, 'replay must not duplicate the mutation');
});

test('a viewer cannot ask the Assistant to mutate the household', async () => {
  const viewer = await joinHousehold(h, owner, 'viewer');
  const denied = await call(h, `/api/households/${owner.householdId}/assistant/propose`, {
    method: 'POST', token: viewer.token, body: { text: 'add eggs to shopping' },
  });
  assert.equal(denied.status, 403);
});
