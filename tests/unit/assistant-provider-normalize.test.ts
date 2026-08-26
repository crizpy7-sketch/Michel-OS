import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeProviderProposal } from '../../server/api/assistant-provider.ts';
import type { AIActionProposal } from '../../lib/contracts/index.ts';

function proposal(type: AIActionProposal['type'], domain: string): AIActionProposal {
  return {
    type,
    payload: {
      title: 'Work schedule',
      domain,
      startsAt: '2026-08-27T11:30:00.000Z',
      endsAt: '2026-08-27T21:00:00.000Z',
      timezone: 'America/Chicago',
      recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'] },
    },
    confidence: 0.98,
    rationale: 'Recurring personal work schedule.',
  } as AIActionProposal;
}

test('OpenAI business synonym becomes work for a recurring calendar schedule', () => {
  const normalized = normalizeProviderProposal(proposal('create_recurring_schedule', 'business'));
  assert.equal(normalized.payload['domain'], 'work');
});

test('already-valid calendar domains are unchanged', () => {
  const input = proposal('create_recurring_schedule', 'work');
  assert.strictEqual(normalizeProviderProposal(input), input);
});

test('unknown domains are not silently repaired', () => {
  const input = proposal('create_recurring_schedule', 'corporate');
  assert.strictEqual(normalizeProviderProposal(input), input);
  assert.equal(input.payload['domain'], 'corporate');
});

test('domain normalization never changes a non-calendar action', () => {
  const input = {
    type: 'classify_inbox_item',
    payload: { inboxItemId: 'inb-1', domain: 'business', notes: 'something unsupported' },
    confidence: 0.4,
  } as AIActionProposal;

  assert.strictEqual(normalizeProviderProposal(input), input);
  assert.equal(input.payload['domain'], 'business');
});
