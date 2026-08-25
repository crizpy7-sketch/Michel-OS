/**
 * Michel-OS — deterministic conflict engine.
 * Owner: Conflict Engine Agent (Agent G). SWARM_ORCHESTRATION.md §G.
 *
 * Consumes already-expanded `Occurrence[]` (produced elsewhere by the recurrence
 * engine) and emits a stable, sorted `Conflict[]`.
 *
 * DETERMINISM CONTRACT (lib/contracts/index.ts: "id: deterministic hash"):
 *   - Ids are sha256 over a canonical payload: household + kind + sorted memberIds
 *     + sorted occurrence refs + window. Same facts => same id, forever.
 *   - Output order is a total order (window start, then kind, then id), so two runs
 *     over the same facts are byte-identical even if the input arrays are shuffled.
 *   - Nothing here reads the clock, Math.random, locale defaults, the ambient
 *     timezone, or object-insertion order. Every tie is broken on data.
 *
 * INTERVAL SEMANTICS: every interval is half-open [start, end). Touching endpoints
 * (A ends exactly when B starts) never overlap — they are a `travel` candidate.
 *
 * COMPLEXITY: no global O(n^2) scan. Occurrences are bucketed by member
 * (O(N + P)), each bucket is sorted (O(n_m log n_m)) and swept with an active-set
 * line sweep that is output-sensitive: each item is pushed and dropped exactly once,
 * and work beyond that is one step per pair actually reported. Total:
 * O(N log N + S log S + K) where K is the number of conflicts found.
 */

import { createHash } from 'node:crypto';
import type {
  Conflict,
  ConflictKind,
  Instant,
  Occurrence,
  ParticipantRole,
  Severity,
  Shift,
  ShiftStatus,
  TimeZone,
  UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------------ config */

/** Minimum breathing room between two back-to-back commitments. */
export const DEFAULT_TRAVEL_GAP_MINUTES = 15;

const MINUTE_MS = 60_000;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, blocking: 2 };
const ROLE_RANK: Record<ParticipantRole, number> = { optional: 0, attendee: 1, responsible: 2 };

/** Shift states that can never collide with anything. */
const INERT_SHIFT_STATUS: ReadonlyArray<ShiftStatus> = ['cancelled', 'swapped'];

/* ------------------------------------------------------------------- input */

export interface ConflictParticipantRow {
  eventId: UUID;
  memberId: UUID;
  role: ParticipantRole;
}

export interface DetectConflictsInput {
  householdId: UUID;
  occurrences: Occurrence[];
  participants: ConflictParticipantRow[];
  shifts?: Shift[];
  /** employeeId -> memberId */
  employeeMemberIds?: Record<UUID, UUID>;
  /** members who must never be left unsupervised */
  minorMemberIds?: UUID[];
  /** Optional. Tightness threshold for `travel`. Defaults to 15 minutes. */
  travelGapMinutes?: number;
  /** Optional. IANA zone used to render explanations. Defaults to UTC. */
  timezone?: TimeZone;
  /** Optional. memberId -> display name, so explanations read like a human wrote them. */
  memberNames?: Record<UUID, string>;
}

/* --------------------------------------------------------- internal shapes */

interface OccurrenceRef {
  eventId: UUID;
  occurrenceStart: Instant;
}

interface Node {
  start: number;
  end: number;
  /** stable tie-break key; never depends on array position */
  sortKey: string;
  ref: OccurrenceRef;
  label: string;
}

interface OccNode extends Node {
  nodeKind: 'occurrence';
  role: ParticipantRole;
}

interface ShiftNode extends Node {
  nodeKind: 'shift';
  status: ShiftStatus;
  shiftRole: string | null;
}

type AnyNode = OccNode | ShiftNode;

/* ------------------------------------------------------------- time format */

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

interface Stamp {
  /** "4:00" */
  time: string;
  /** "AM" | "PM" */
  period: string;
  /** "Monday, August 24" */
  day: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    formatterCache.set(timezone, dtf);
    return dtf;
  } catch {
    return null;
  }
}

/** Deterministic: the zone is always explicit, never the machine's local zone. */
function stampOf(ms: number, timezone: string): Stamp {
  const dtf = formatterFor(timezone);
  if (dtf) {
    const bag: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(ms))) bag[part.type] = part.value;
    const hour = bag['hour'];
    const minute = bag['minute'];
    const period = bag['dayPeriod'];
    const weekday = bag['weekday'];
    const month = bag['month'];
    const day = bag['day'];
    if (hour && minute && period && weekday && month && day) {
      return {
        time: `${hour}:${minute}`,
        period: period.toUpperCase().replace(/\./g, ''),
        day: `${weekday}, ${month} ${day}`,
      };
    }
  }
  // Fallback: hand-rolled UTC, so an unusable zone still yields a readable sentence.
  const d = new Date(ms);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const weekday = WEEKDAY_NAMES[d.getUTCDay()] ?? 'Day';
  const month = MONTH_NAMES[d.getUTCMonth()] ?? 'Month';
  return {
    time: `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    period: h24 < 12 ? 'AM' : 'PM',
    day: `${weekday}, ${month} ${d.getUTCDate()}`,
  };
}

/** "from 4:00 to 4:30 PM on Monday, August 24" */
function whenPhrase(startMs: number, endMs: number, timezone: string): string {
  const a = stampOf(startMs, timezone);
  const b = stampOf(endMs, timezone);
  if (a.day === b.day) {
    const left = a.period === b.period ? a.time : `${a.time} ${a.period}`;
    return `from ${left} to ${b.time} ${b.period} on ${a.day}`;
  }
  return `from ${a.time} ${a.period} on ${a.day} to ${b.time} ${b.period} on ${b.day}`;
}

/** "4:00 PM" or "4:00 PM on Monday, August 24" */
function atPhrase(ms: number, timezone: string, withDay: boolean): string {
  const s = stampOf(ms, timezone);
  return withDay ? `${s.time} ${s.period} on ${s.day}` : `${s.time} ${s.period}`;
}

function gapPhrase(gapMs: number): string {
  if (gapMs <= 0) return 'no gap at all';
  const minutes = Math.round(gapMs / MINUTE_MS);
  if (minutes <= 0) return 'less than a minute';
  return minutes === 1 ? 'only 1 minute' : `only ${minutes} minutes`;
}

function joinNames(names: string[]): string {
  if (names.length === 0) return 'someone in the family';
  const head = names[0] ?? 'someone in the family';
  if (names.length === 1) return head;
  const last = names[names.length - 1] ?? head;
  return `${names.slice(0, -1).join(', ')} and ${last}`;
}

/* ------------------------------------------------------------ small utils */

function parseInstant(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function compareNodes(a: Node, b: Node): number {
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return a.end - b.end;
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
}

function compareRefs(a: OccurrenceRef, b: OccurrenceRef): number {
  if (a.occurrenceStart !== b.occurrenceStart) return a.occurrenceStart < b.occurrenceStart ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/**
 * Active-set line sweep over half-open intervals.
 * Every item enters and leaves `active` exactly once; the only extra work is one
 * step per intersecting pair actually handed to `onPair`. Output-sensitive:
 * O(n log n + pairs), never a blanket O(n^2).
 */
function sweepIntersections<T extends Node>(items: T[], onPair: (earlier: T, later: T) => void): void {
  const sorted = [...items].sort(compareNodes);
  const active: T[] = [];
  for (const item of sorted) {
    let keep = 0;
    for (let i = 0; i < active.length; i += 1) {
      const open = active[i];
      if (open === undefined) continue;
      if (open.end > item.start) {
        active[keep] = open;
        keep += 1;
        // open.start <= item.start < open.end and item.start < item.end => real overlap.
        onPair(open, item);
      }
    }
    active.length = keep;
    active.push(item);
  }
}

/* ---------------------------------------------------------- conflict build */

interface DraftConflict {
  kind: ConflictKind;
  severity: Severity;
  memberIds: UUID[];
  refs: OccurrenceRef[];
  startMs: number;
  endMs: number;
  explanation: string;
}

function buildConflict(householdId: UUID, draft: DraftConflict): Conflict {
  const memberIds = [...new Set(draft.memberIds)].sort();
  const refs = [...draft.refs]
    .filter((ref, index, all) =>
      all.findIndex((o) => o.eventId === ref.eventId && o.occurrenceStart === ref.occurrenceStart) === index)
    .sort(compareRefs);
  const startsAt = new Date(draft.startMs).toISOString();
  const endsAt = new Date(draft.endMs).toISOString();

  // Canonical, order-independent id payload. Key order is fixed by this literal.
  const payload = JSON.stringify({
    v: 1,
    household: householdId,
    kind: draft.kind,
    members: memberIds,
    refs: refs.map((r) => `${r.eventId}@${r.occurrenceStart}`),
    window: [startsAt, endsAt],
  });
  const id = createHash('sha256').update(payload).digest('hex').slice(0, 32);

  return {
    id,
    householdId,
    kind: draft.kind,
    severity: draft.severity,
    memberIds,
    occurrenceRefs: refs,
    window: { startsAt, endsAt },
    explanation: draft.explanation,
  };
}

/** Order-independent preference when two drafts collapse to the same id. */
function preferred(a: Conflict, b: Conflict): Conflict {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity < 0 ? a : b;
  return a.explanation <= b.explanation ? a : b;
}

/* -------------------------------------------------------------- detection */

export function detectConflicts(input: {
  householdId: UUID;
  occurrences: Occurrence[];
  participants: Array<{ eventId: UUID; memberId: UUID; role: 'attendee' | 'responsible' | 'optional' }>;
  shifts?: Shift[];
  employeeMemberIds?: Record<UUID, UUID>;
  minorMemberIds?: UUID[];
  travelGapMinutes?: number;
  timezone?: TimeZone;
  memberNames?: Record<UUID, string>;
}): Conflict[] {
  const householdId = input.householdId;
  const timezone = input.timezone ?? 'UTC';
  const gapMs = Math.max(0, input.travelGapMinutes ?? DEFAULT_TRAVEL_GAP_MINUTES) * MINUTE_MS;
  const minors = new Set(input.minorMemberIds ?? []);
  const names = input.memberNames ?? {};

  const nameOf = (memberId: UUID): string => {
    const raw = names[memberId];
    return raw && raw.trim().length > 0 ? raw.trim() : 'A family member';
  };
  const lowerNameOf = (memberId: UUID): string => {
    const raw = names[memberId];
    return raw && raw.trim().length > 0 ? raw.trim() : 'this family member';
  };

  const drafts: DraftConflict[] = [];

  /* -- 1. roles per event: strongest role wins, so duplicate rows are harmless -- */
  const rolesByEvent = new Map<UUID, Map<UUID, ParticipantRole>>();
  for (const row of input.participants) {
    if (!row || typeof row.eventId !== 'string' || typeof row.memberId !== 'string') continue;
    let byMember = rolesByEvent.get(row.eventId);
    if (!byMember) {
      byMember = new Map<UUID, ParticipantRole>();
      rolesByEvent.set(row.eventId, byMember);
    }
    const current = byMember.get(row.memberId);
    if (current === undefined || ROLE_RANK[row.role] > ROLE_RANK[current]) {
      byMember.set(row.memberId, row.role);
    }
  }

  /* -- 2. bucket occurrences by member (attendee | responsible only) -------- */
  const occByMember = new Map<UUID, OccNode[]>();

  for (const occ of input.occurrences) {
    if (!occ || occ.status === 'cancelled') continue;
    const start = parseInstant(occ.occurrenceStart);
    const end = parseInstant(occ.occurrenceEnd);
    if (start === null || end === null) continue;

    const ref: OccurrenceRef = { eventId: occ.eventId, occurrenceStart: occ.occurrenceStart };
    const title = occ.title && occ.title.trim().length > 0 ? occ.title.trim() : 'an untitled event';

    // Effective roster: explicit participant rows, plus any bare participantIds
    // the caller only listed on the occurrence (those default to 'attendee').
    const effective = new Map<UUID, ParticipantRole>(rolesByEvent.get(occ.eventId) ?? []);
    for (const memberId of occ.participantIds ?? []) {
      if (typeof memberId === 'string' && !effective.has(memberId)) effective.set(memberId, 'attendee');
    }

    let hasResponsible = false;
    const involvedMinors: UUID[] = [];
    for (const [memberId, role] of effective) {
      if (role === 'responsible') hasResponsible = true;
      if (role === 'optional') continue;
      if (minors.has(memberId)) involvedMinors.push(memberId);
      if (end > start) {
        push(occByMember, memberId, {
          nodeKind: 'occurrence',
          start,
          end,
          sortKey: `${occ.occurrenceStart}|${occ.eventId}`,
          ref,
          label: title,
          role,
        });
      }
    }

    /* -- 3a. responsibility: an unsupervised minor is always blocking -------- */
    if (involvedMinors.length > 0 && !hasResponsible) {
      const who = joinNames([...involvedMinors].sort().map(lowerNameOf));
      drafts.push({
        kind: 'responsibility',
        severity: 'blocking',
        memberIds: involvedMinors,
        refs: [ref],
        startMs: start,
        endMs: Math.max(end, start),
        explanation:
          `No one is marked as responsible for ${who} during ${title}, ` +
          `${whenPhrase(start, Math.max(end, start), timezone)}.`,
      });
    }
  }

  /* -- 3b/3c. per-member sweep: overlap, responsibility double-book, travel -- */
  for (const [memberId, rawList] of occByMember) {
    const list = [...rawList].sort(compareNodes);
    const who = nameOf(memberId);

    sweepIntersections(list, (a, b) => {
      // Defensive: the same occurrence handed in twice is not a conflict with itself.
      if (a.ref.eventId === b.ref.eventId && a.ref.occurrenceStart === b.ref.occurrenceStart) return;
      const startMs = Math.max(a.start, b.start);
      const endMs = Math.min(a.end, b.end);
      const bothResponsible = a.role === 'responsible' && b.role === 'responsible';
      if (bothResponsible) {
        // Escalation rule: being on the hook for two overlapping things supersedes
        // (and replaces) the plain overlap for that same pair — never both.
        drafts.push({
          kind: 'responsibility',
          severity: 'blocking',
          memberIds: [memberId],
          refs: [a.ref, b.ref],
          startMs,
          endMs,
          explanation:
            `${who} is down as the person in charge of both ${a.label} and ${b.label}, ` +
            `and they overlap ${whenPhrase(startMs, endMs, timezone)}. Nobody can be in two places at once.`,
        });
      } else {
        drafts.push({
          kind: 'overlap',
          severity: 'warning',
          memberIds: [memberId],
          refs: [a.ref, b.ref],
          startMs,
          endMs,
          explanation:
            `${who} is double-booked: ${a.label} and ${b.label} overlap ` +
            `${whenPhrase(startMs, endMs, timezone)}.`,
        });
      }
    });

    // travel: the first commitment that starts at or after this one ends.
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        if (b === undefined) continue;
        if (b.start < a.end) continue; // overlapping — already reported by the sweep
        const gap = b.start - a.end;
        if (gap < gapMs) {
          const sameDay = stampOf(a.end, timezone).day === stampOf(b.start, timezone).day;
          drafts.push({
            kind: 'travel',
            severity: 'info',
            memberIds: [memberId],
            refs: [a.ref, b.ref],
            startMs: a.end,
            endMs: b.start,
            explanation:
              `${who} has ${gapPhrase(gap)} between ${a.label} and ${b.label}: ` +
              `${a.label} ends at ${atPhrase(a.end, timezone, !sameDay)} and ` +
              `${b.label} starts at ${atPhrase(b.start, timezone, true)}. ` +
              `That may not be enough time to get from one to the other.`,
          });
        }
        break; // only the immediate next commitment counts as a travel hop
      }
    }
  }

  /* -- 4. shifts: work (member vs shift) and employee (shift vs shift) ------ */
  const employeeMemberIds = input.employeeMemberIds ?? {};
  const shiftsByEmployee = new Map<UUID, ShiftNode[]>();
  const shiftsByMember = new Map<UUID, ShiftNode[]>();

  for (const shift of input.shifts ?? []) {
    if (!shift || shift.employeeId === null || typeof shift.employeeId !== 'string') continue;
    if (INERT_SHIFT_STATUS.includes(shift.status)) continue; // cancelled/swapped never conflict
    const start = parseInstant(shift.startsAt);
    const end = parseInstant(shift.endsAt);
    if (start === null || end === null || end <= start) continue;

    const node: ShiftNode = {
      nodeKind: 'shift',
      start,
      end,
      sortKey: `${shift.startsAt}|${shift.id}`,
      ref: { eventId: shift.id, occurrenceStart: shift.startsAt },
      label: shift.role && shift.role.trim().length > 0 ? `${shift.role.trim()} shift` : 'work shift',
      status: shift.status,
      shiftRole: shift.role && shift.role.trim().length > 0 ? shift.role.trim() : null,
    };
    push(shiftsByEmployee, shift.employeeId, node);
    const memberId = employeeMemberIds[shift.employeeId];
    if (typeof memberId === 'string' && memberId.length > 0) push(shiftsByMember, memberId, node);
  }

  // employee: one employee on two intersecting PUBLISHED shifts.
  for (const [employeeId, shiftNodes] of shiftsByEmployee) {
    const published = shiftNodes.filter((s) => s.status === 'published');
    if (published.length < 2) continue;
    const memberId = employeeMemberIds[employeeId];
    const who = typeof memberId === 'string' && memberId.length > 0 ? nameOf(memberId) : 'One employee';
    sweepIntersections(published, (a, b) => {
      if (a.ref.eventId === b.ref.eventId) return; // same shift listed twice
      const startMs = Math.max(a.start, b.start);
      const endMs = Math.min(a.end, b.end);
      drafts.push({
        kind: 'employee',
        severity: 'warning',
        memberIds: typeof memberId === 'string' && memberId.length > 0 ? [memberId] : [],
        refs: [a.ref, b.ref],
        startMs,
        endMs,
        explanation:
          `${who} is scheduled for two shifts at the same time, ` +
          `${whenPhrase(startMs, endMs, timezone)}. One of them needs to move.`,
      });
    });
  }

  // work: a member's occurrence intersecting a shift they are assigned to.
  for (const [memberId, shiftNodes] of shiftsByMember) {
    const occNodes = occByMember.get(memberId);
    if (!occNodes || occNodes.length === 0) continue;
    const who = nameOf(memberId);
    const merged: AnyNode[] = [...occNodes, ...shiftNodes];
    sweepIntersections(merged, (a, b) => {
      const occNode = a.nodeKind === 'occurrence' ? a : b.nodeKind === 'occurrence' ? b : null;
      const shiftNode = a.nodeKind === 'shift' ? a : b.nodeKind === 'shift' ? b : null;
      if (!occNode || !shiftNode) return; // occ/occ and shift/shift handled elsewhere
      const startMs = Math.max(a.start, b.start);
      const endMs = Math.min(a.end, b.end);
      const when = whenPhrase(startMs, endMs, timezone);
      const shiftLabel = shiftNode.shiftRole ? `a ${shiftNode.shiftRole} shift` : 'a work shift';
      drafts.push({
        kind: 'work',
        severity: shiftNode.status === 'published' ? 'warning' : 'info',
        memberIds: [memberId],
        refs: [occNode.ref, shiftNode.ref],
        startMs,
        endMs,
        explanation:
          shiftNode.status === 'published'
            ? `${who} is scheduled to work ${shiftLabel} that clashes with ${occNode.label}, ${when}.`
            : `${who} has ${shiftLabel} pencilled in that would clash with ${occNode.label}, ${when}, ` +
              `if that shift gets published.`,
      });
    });
  }

  /* -- 5. materialise, dedupe by id, sort into a total order ---------------- */
  const byId = new Map<string, Conflict>();
  for (const draft of drafts) {
    const conflict = buildConflict(householdId, draft);
    const existing = byId.get(conflict.id);
    byId.set(conflict.id, existing ? preferred(existing, conflict) : conflict);
  }

  return [...byId.values()].sort((a, b) => {
    const aStart = Date.parse(a.window.startsAt);
    const bStart = Date.parse(b.window.startsAt);
    if (aStart !== bStart) return aStart - bStart;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ------------------------------------------------------ resolution helpers */

const FALLBACK_EXPLANATION: Record<ConflictKind, string> = {
  overlap: 'Two things are booked at the same time.',
  responsibility: 'Nobody is lined up to be in charge.',
  work: 'A work shift lands on top of a family plan.',
  employee: 'Someone is scheduled for two shifts at once.',
  travel: 'There is barely any time to get from one place to the next.',
};

/** True once someone has marked the conflict sorted out. */
export function isResolved(c: Conflict): boolean {
  const r = c.resolution;
  if (!r) return false;
  return (
    typeof r.resolvedBy === 'string' &&
    r.resolvedBy.length > 0 &&
    typeof r.resolvedAt === 'string' &&
    r.resolvedAt.length > 0
  );
}

/** Plain language for a phone screen: no ids, no jargon, one readable sentence. */
export function explainConflict(c: Conflict): string {
  const base =
    typeof c.explanation === 'string' && c.explanation.trim().length > 0
      ? c.explanation.trim()
      : FALLBACK_EXPLANATION[c.kind];
  if (isResolved(c)) {
    const note = c.resolution?.note?.trim();
    return note ? `${base} Already sorted out: ${note}` : `${base} This one is already sorted out.`;
  }
  return base;
}
