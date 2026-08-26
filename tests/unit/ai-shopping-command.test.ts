import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyInboxItem } from '../../domains/ai/inbox.ts';
import type { InboxItem, UUID } from '../../lib/contracts/index.ts';

const HOUSEHOLD: UUID = 'hh-shopping-command';
const NOW = '2026-08-26T23:20:00.000Z';

function classify(rawText: string) {
  const item: InboxItem = {
    id: 'inb-shopping-command',
    householdId: HOUSEHOLD,
    rawText,
    capturedBy: 'm-owner',
    capturedAt: NOW,
    status: 'unclassified',
  };
  return classifyInboxItem(item, {
    householdId: HOUSEHOLD,
    now: NOW,
    timezone: 'America/Chicago',
  });
}

test('shopping commands save the item, not the whole instruction', () => {
  const add = classify('Add milk to the shopping list').proposal;
  assert.equal(add.type, 'add_shopping_item');
  assert.equal(add.payload['name'], 'milk');

  const put = classify('please put diapers on the grocery list').proposal;
  assert.equal(put.type, 'add_shopping_item');
  assert.equal(put.payload['name'], 'diapers');
});

test('non-command shopping text keeps the existing deterministic wording', () => {
  const proposal = classify('we need milk').proposal;
  assert.equal(proposal.type, 'add_shopping_item');
  assert.equal(proposal.payload['name'], 'we need milk');
});
