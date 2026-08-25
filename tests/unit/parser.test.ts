import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, type ParseContext } from '../../domains/ai/parser.ts';

const ctx: ParseContext = {
  now: '2026-09-07T12:00:00.000Z', // a Monday
  members: [
    { id: 'mem-ana', displayName: 'Ana' },
    { id: 'mem-noor', displayName: 'Noor' },
    { id: 'mem-michel', displayName: 'Michel' },
  ],
  schedules: [
    { id: 'sch-practice', domain: 'practice' },
    { id: 'sch-appointments', domain: 'appointments' },
    { id: 'sch-general', domain: 'general' },
    { id: 'sch-games', domain: 'games' },
  ],
};

test('parses the spec example: recurring practice with days and a time range', () => {
  const { proposal, understood } = parseIntent('Ana has practice every Tuesday and Thursday from 6 to 8', ctx);

  assert.equal(proposal.type, 'create_recurring_schedule');
  const p = proposal.payload;
  assert.equal(p.domain, 'practice');
  assert.equal(p.scheduleId, 'sch-practice');
  assert.deepEqual(p.participantIds, ['mem-ana']);

  const rule = p.recurrence as { freq: string; byWeekday: string[]; interval: number };
  assert.equal(rule.freq, 'WEEKLY');
  assert.equal(rule.interval, 1);
  assert.deepEqual(rule.byWeekday.sort(), ['TH', 'TU']);

  // 6pm–8pm America/Chicago is 23:00–01:00 UTC.
  assert.match(String(p.startsAt), /T23:00:00/);
  assert.ok(understood.some((u) => u.startsWith('Who: Ana')));
});

test('bare hours in a family calendar resolve to the evening, and say so', () => {
  const { proposal, understood } = parseIntent('practice from 6 to 8', ctx);
  assert.match(String(proposal.payload.startsAt), /T23:00:00/);
  assert.ok(understood.some((u) => /Assumed evening/.test(u)), 'the guess must be surfaced, not silent');
});

test('an explicit meridiem is honoured over the evening heuristic', () => {
  const { proposal } = parseIntent('Ana has practice at 9am', ctx);
  assert.match(String(proposal.payload.startsAt), /T14:00:00/); // 9am CDT = 14:00Z
});

test('appointment phrasing routes to the appointments schedule', () => {
  const { proposal } = parseIntent('dentist for Noor Wednesday at 3:30pm', ctx);
  assert.equal(proposal.type, 'create_event');
  assert.equal(proposal.payload.domain, 'appointments');
  assert.equal(proposal.payload.scheduleId, 'sch-appointments');
  assert.deepEqual(proposal.payload.participantIds, ['mem-noor']);
  assert.match(String(proposal.payload.startsAt), /2026-09-09T20:30:00/);
});

test('"we need milk" becomes a shopping item, not an event', () => {
  const { proposal } = parseIntent('we need milk', ctx);
  assert.equal(proposal.type, 'add_shopping_item');
  assert.equal(proposal.payload.name, 'Milk');
  assert.equal(proposal.payload.listName, 'Groceries');
  assert.equal(proposal.payload.quantity, 1);
});

test('quantities and named lists are picked up', () => {
  const { proposal } = parseIntent('we need 24 hair bows', ctx);
  assert.equal(proposal.payload.quantity, 24);
  assert.equal(proposal.payload.listName, 'Business');
});

test('"remind me to..." creates a reminder with a resolved due date', () => {
  const { proposal } = parseIntent('remind me to call insurance Friday', ctx);
  assert.equal(proposal.type, 'create_reminder');
  assert.match(String(proposal.payload.title), /call insurance/i);
  assert.match(String(proposal.payload.dueAt), /2026-09-11/);
});

test('unrecognisable input goes to the Inbox rather than guessing', () => {
  const { proposal, understood } = parseIntent('the thing about the stuff', ctx);
  assert.equal(proposal.type, 'classify_inbox_item');
  assert.ok(proposal.confidence < 0.5, 'confidence must be low so nothing executes silently');
  assert.ok(understood.some((u) => /Inbox/.test(u)));
});

test('confidence drops when the time is guessed or the person is missing', () => {
  const explicit = parseIntent('Ana has practice at 6pm', ctx).proposal.confidence;
  const vague = parseIntent('practice sometime', ctx).proposal.confidence;
  assert.ok(explicit > vague, `explicit (${explicit}) should beat vague (${vague})`);
});

test('titles keep the human words and drop the machinery', () => {
  const { proposal } = parseIntent('Ana has practice every Tuesday and Thursday from 6 to 8', ctx);
  const title = String(proposal.payload.title);
  assert.doesNotMatch(title, /every|tuesday|thursday|from|\d/i);
  assert.match(title, /practice/i);
});

test('the parser is pure: same input twice yields an identical proposal', () => {
  const a = parseIntent('Ana has practice every Tuesday from 6 to 8', ctx);
  const b = parseIntent('Ana has practice every Tuesday from 6 to 8', ctx);
  assert.deepEqual(a, b);
});

test('empty input is handled without throwing', () => {
  const { proposal } = parseIntent('   ', ctx);
  assert.equal(proposal.confidence, 0);
});

test('a game phrase resolves to the games schedule', () => {
  const { proposal } = parseIntent('Ana has a game Saturday at 2pm', ctx);
  assert.equal(proposal.payload.domain, 'games');
  assert.equal(proposal.payload.scheduleId, 'sch-games');
});

test('every-N-weeks recurrence is understood', () => {
  const { proposal } = parseIntent('Ana has practice every 2 weeks on Tuesday at 6pm', ctx);
  const rule = proposal.payload.recurrence as { interval: number; byWeekday: string[] };
  assert.equal(rule.interval, 2);
  assert.deepEqual(rule.byWeekday, ['TU']);
});
