/**
 * Unit tests for inbox classification (Agent H, domains/ai/inbox.ts).
 *
 * Every proposal this module emits is fed through the real `validateAction`,
 * because a classifier that produces payloads the validator rejects has not
 * classified anything — it has produced work for a human.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyInboxItem } from '../../domains/ai/inbox.ts';
import { validateAction } from '../../domains/ai/validator.ts';
import type { InboxItem, Permission, UUID } from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- fixtures */

const HOUSEHOLD: UUID = 'hh-michel';
const ACTOR: UUID = 'm-mom';
const NOW = '2026-08-24T14:00:00.000Z'; // Monday, 09:00 in America/Chicago

const CTX = {
  householdId: HOUSEHOLD,
  now: NOW,
  timezone: 'America/Chicago',
  members: [
    { id: 'm-mateo', displayName: 'Mateo' },
    { id: 'm-leila', displayName: 'Leila' },
    { id: 'm-mom', displayName: 'Elena Michel' },
  ],
  employees: [{ id: 'e-maria', displayName: 'Maria Ruiz' }],
};

function item(rawText: string): InboxItem {
  return {
    id: 'inb-1',
    householdId: HOUSEHOLD,
    rawText,
    capturedBy: ACTOR,
    capturedAt: NOW,
    status: 'unclassified',
  };
}

const classify = (text: string) => classifyInboxItem(item(text), CTX);

/** An owner: every permission, so the validator's verdict is about the payload. */
const ALL_PERMISSIONS = (): ((permission: Permission) => boolean) => () => true;

function verdictFor(text: string) {
  return validateAction(classify(text).proposal, {
    householdId: HOUSEHOLD,
    actorMemberId: ACTOR,
    now: NOW,
    can: ALL_PERMISSIONS(),
  });
}

/* ------------------------------------------------------------- routing */

test('the four PRODUCT_SPEC §3 examples each route to their own mini-app', () => {
  assert.equal(classify('we need milk').domain, 'shopping');
  assert.equal(classify('Mateo plays Saturday at 4').domain, 'games');
  assert.equal(classify('remind me about this flyer').domain, 'reminders');
  assert.equal(classify('Maria cannot work Thursday').domain, 'shia-baby');
});

test('"we need milk" becomes an add_shopping_item the validator accepts', () => {
  const { proposal } = classify('we need milk');
  assert.equal(proposal.type, 'add_shopping_item');
  assert.equal(proposal.payload['name'], 'we need milk');

  const verdict = verdictFor('we need milk');
  assert.notEqual(verdict.decision, 'reject', JSON.stringify(verdict.errors));
});

test('"Mateo plays Saturday at 4" becomes a dated event with Mateo on it', () => {
  const result = classify('Mateo plays Saturday at 4');
  assert.equal(result.proposal.type, 'create_event');
  assert.deepEqual(result.participantIds, ['m-mateo']);
  // Saturday 2026-08-29, 4pm in America/Chicago (CDT, UTC−5).
  assert.equal(result.when?.startsAt, '2026-08-29T21:00:00.000Z');
  assert.deepEqual(result.proposal.payload['participantIds'], ['m-mateo']);

  const verdict = verdictFor('Mateo plays Saturday at 4');
  assert.notEqual(verdict.decision, 'reject', JSON.stringify(verdict.errors));
});

test('a recurring practice becomes a weekly rule on the days actually named', () => {
  const result = classify('Leila has practice every Tuesday and Thursday from 6 to 8');
  assert.equal(result.domain, 'practice');
  assert.equal(result.proposal.type, 'create_recurring_schedule');
  assert.deepEqual(result.recurrence, { freq: 'WEEKLY', interval: 1, byWeekday: ['TU', 'TH'] });
  assert.deepEqual(result.participantIds, ['m-leila']);

  // 6 to 8 in the evening, read in the household's zone.
  assert.equal(result.when?.startsAt, '2026-08-25T23:00:00.000Z');
  assert.equal(result.when?.endsAt, '2026-08-26T01:00:00.000Z');

  const verdict = verdictFor('Leila has practice every Tuesday and Thursday from 6 to 8');
  assert.notEqual(verdict.decision, 'reject', JSON.stringify(verdict.errors));
});

test('an errand routes to create_errand and keeps the family’s own words as the title', () => {
  const result = classify('return the package');
  assert.equal(result.domain, 'errands');
  assert.equal(result.proposal.type, 'create_errand');
  assert.equal(result.proposal.payload['title'], 'return the package');
});

test('"practice" must not fire on "practical" — the lexicon matches whole words', () => {
  assert.notEqual(classify('a practical solution for the garage').domain, 'practice');
});

test('a name matches whole, so "Ana" does not fire on "banana"', () => {
  const ctx = { ...CTX, members: [{ id: 'm-ana', displayName: 'Ana' }] };
  const bananas = classifyInboxItem(item('buy bananas'), ctx);
  assert.deepEqual(bananas.participantIds, [], 'a substring name match would tag the wrong child');

  const real = classifyInboxItem(item('Ana has a dentist appointment tomorrow at 9am'), ctx);
  assert.deepEqual(real.participantIds, ['m-ana']);
});

/* -------------------------------------------------- never invent a field */

test('a reminder with no time is parked for review rather than given a made-up due date', () => {
  const result = classify('remind me about the insurance renewal');
  assert.equal(result.domain, 'reminders');
  assert.equal(
    result.proposal.type,
    'classify_inbox_item',
    'a confidently wrong 9am reminder is worse than an item still in the inbox',
  );
  assert.equal(result.proposal.payload['inboxItemId'], 'inb-1');
  assert.equal(result.proposal.payload['domain'], 'reminders');
});

test('a reminder WITH a time becomes a real create_reminder', () => {
  const result = classify('remind me to call the insurance company tomorrow at 10am');
  assert.equal(result.proposal.type, 'create_reminder');
  assert.equal(result.proposal.payload['dueAt'], '2026-08-25T15:00:00.000Z');

  const verdict = verdictFor('remind me to call the insurance company tomorrow at 10am');
  assert.notEqual(verdict.decision, 'reject', JSON.stringify(verdict.errors));
});

test('an event-shaped item with no time is parked, because an event with no time is not an event', () => {
  const result = classify('Mateo has a dentist appointment');
  assert.equal(result.domain, 'appointments');
  assert.equal(result.proposal.type, 'classify_inbox_item');
});

test('text with no signal at all is parked as general with zero confidence', () => {
  const result = classify('the thing');
  assert.equal(result.domain, 'general');
  assert.equal(result.confidence, 0);
  assert.equal(result.proposal.type, 'classify_inbox_item');
});

test('empty text is parked rather than producing a titleless action', () => {
  assert.equal(classify('   ').proposal.type, 'classify_inbox_item');
});

/* ------------------------------------------------------------ confidence */

test('confidence rises with evidence and is never a constant', () => {
  const weak = classify('return the package');
  const strong = classify('Mateo plays Saturday at 4pm');
  assert.ok(strong.confidence > weak.confidence, `${strong.confidence} vs ${weak.confidence}`);
  assert.ok(weak.confidence > 0);
  assert.ok(strong.confidence <= 1);
});

test('a guessed meridiem costs confidence, an explicit one does not', () => {
  const guessed = classify('Mateo plays Saturday at 4');
  const explicit = classify('Mateo plays Saturday at 4pm');
  assert.ok(explicit.confidence > guessed.confidence, 'a guess should reach a human sooner');
  assert.ok(guessed.signals.some((s) => s.includes('inferred')), guessed.signals.join(' | '));
});

test('the signals explain the decision without repeating one keyword as evidence', () => {
  const result = classify('practice practice practice');
  const practiceSignals = result.signals.filter((s) => s.includes('(practice)'));
  assert.equal(practiceSignals.length, 1, 'repetition is not evidence');
});

/* ---------------------------------------------------------- determinism */

test('the same text always classifies identically', () => {
  const text = 'Leila has practice every Tuesday and Thursday from 6 to 8';
  assert.deepEqual(classify(text), classify(text));
});

test('classification does not depend on when it was run, only on the injected now', () => {
  const a = classifyInboxItem(item('Mateo plays Saturday at 4'), CTX);
  const b = classifyInboxItem(item('Mateo plays Saturday at 4'), { ...CTX, now: '2026-08-24T14:00:00.000Z' });
  assert.deepEqual(a, b);

  // A different injected now moves the weekend, as it must.
  const later = classifyInboxItem(item('Mateo plays Saturday at 4'), { ...CTX, now: '2026-08-31T14:00:00.000Z' });
  assert.notEqual(later.when?.startsAt, a.when?.startsAt);
});

test('a bare weekday means the next one that has not happened, including today', () => {
  // NOW is a Monday. "Monday" means today, not next week.
  const monday = classifyInboxItem(item('game Monday at 5pm'), CTX);
  assert.equal(monday.when?.startsAt, '2026-08-24T22:00:00.000Z');
});

test('the household timezone decides the instant, not the machine’s zone', () => {
  const chicago = classifyInboxItem(item('game tomorrow at 4pm'), CTX);
  const utc = classifyInboxItem(item('game tomorrow at 4pm'), { ...CTX, timezone: 'UTC' });
  assert.equal(chicago.when?.startsAt, '2026-08-25T21:00:00.000Z');
  assert.equal(utc.when?.startsAt, '2026-08-25T16:00:00.000Z');
});

/* --------------------------------------------------- the pipeline holds */

test('the classifier cannot smuggle a household id past the validator', () => {
  // Whatever the text says, the proposal carries no tenant field — the
  // validator's injected scope is the only household that exists.
  for (const text of ['we need milk', 'Mateo plays Saturday at 4', 'return the package']) {
    const { proposal } = classify(text);
    assert.equal(Object.hasOwn(proposal.payload, 'householdId'), false, text);
  }
});

test('a proposal from the inbox is still refused when the actor lacks the permission', () => {
  const verdict = validateAction(classify('Mateo plays Saturday at 4').proposal, {
    householdId: HOUSEHOLD,
    actorMemberId: ACTOR,
    now: NOW,
    can: () => false, // a viewer
  });
  assert.equal(verdict.decision, 'reject');
  assert.ok(verdict.errors.some((e) => e.code === 'permission'), JSON.stringify(verdict.errors));
});

test('every routed proposal type is one the frozen contract knows about', () => {
  const texts = [
    'we need milk',
    'Mateo plays Saturday at 4',
    'Leila has practice every Tuesday and Thursday from 6 to 8',
    'return the package',
    'remind me to call the school tomorrow at 10am',
    'the thing',
  ];
  for (const text of texts) {
    const verdict = verdictFor(text);
    assert.notEqual(
      verdict.decision,
      'reject',
      `"${text}" produced a rejected proposal: ${JSON.stringify(verdict.errors)}`,
    );
  }
});
