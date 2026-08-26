/**
 * Michel-OS — Notification centre (Agent K).
 *
 * ARCHITECTURE.md §9: V1 is the in-app centre plus scheduled reminder records;
 * push, email and SMS are adapters bolted onto the same record later. That
 * shape is what this module protects.
 *
 * The hard problem here is not delivery, it is **not nagging**. The same
 * conflict re-detected on every page load, the same low-stock product every
 * hour, the same reminder every time the scheduler ticks — each of those turns
 * the notification centre into noise that people learn to swipe away.
 *
 * So every notification carries a `dedupeKey` derived purely from the facts
 * that caused it. Regenerating from unchanged facts produces the identical key,
 * and `mergeNotifications` keeps the row that already exists — preserving its
 * `readAt`, so something the family has already seen never comes back marked
 * unread.
 *
 * Pure: `deliverAt` and every timestamp are supplied by the caller.
 */

import { createHash } from 'node:crypto';
import {
  type Conflict,
  type Instant,
  type Notification,
  type NotificationChannel,
  type NotificationKind,
  type Reminder,
  type UUID,
} from '../../lib/contracts/index.ts';

/**
 * The shape the ledger agent's low-stock alert satisfies.
 *
 * Declared structurally here rather than imported from `domains/shia-baby`:
 * Agents J2 and K build concurrently, and a direct import between two Phase C2
 * modules would make one wait for the other. This is the adapter boundary — if
 * the shapes ever diverge, the typecheck challenger says so at the call site.
 */
export interface LowStockLike {
  productId: UUID;
  sku: string;
  name: string;
  quantityOnHand: number;
  reorderPoint: number;
}

/* ---------------------------------------------------------------- helpers */

function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A stable key for "this notification, about these facts".
 *
 * Hashed rather than concatenated so a key never leaks a title or a note into
 * a column that gets logged, and so its length is bounded whatever the inputs.
 */
export function dedupeKey(kind: NotificationKind, householdId: UUID, ...facts: string[]): string {
  const payload = JSON.stringify({ v: 1, kind, householdId, facts });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------ generation */

export interface NotificationDraft {
  kind: NotificationKind;
  householdId: UUID;
  recipientMemberId: UUID | null;
  title: string;
  body: string;
  deliverAt: Instant;
  dedupeKey: string;
  subject?: { entity: string; id: string };
  channel?: NotificationChannel;
}

/**
 * Turn a draft into a persistable notification.
 *
 * The id is the caller's to mint, like everywhere else in this codebase — a
 * module that invents identity cannot be replayed.
 */
export function materializeNotification(id: UUID, draft: NotificationDraft): Notification {
  return {
    id,
    householdId: draft.householdId,
    recipientMemberId: draft.recipientMemberId,
    kind: draft.kind,
    channel: draft.channel ?? 'in_app',
    title: draft.title,
    body: draft.body,
    deliverAt: draft.deliverAt,
    dedupeKey: draft.dedupeKey,
    ...(draft.subject === undefined ? {} : { subject: draft.subject }),
  };
}

/**
 * One draft per reminder that has come due.
 *
 * The dedupe key includes the due instant, so a reminder that is rescheduled
 * legitimately notifies again — while the same reminder at the same time,
 * re-scanned a hundred times, produces one row.
 */
export function remindersDue(
  reminders: readonly Reminder[],
  householdId: UUID,
  now: Instant,
): NotificationDraft[] {
  const nowMs = parseInstant(now);
  if (nowMs === null) return [];

  const drafts: NotificationDraft[] = [];

  for (const reminder of reminders) {
    if (reminder.householdId !== householdId) continue;
    if (reminder.status !== 'pending' && reminder.status !== 'sent') continue;
    const dueMs = parseInstant(reminder.dueAt);
    if (dueMs === null || dueMs > nowMs) continue;

    drafts.push({
      kind: 'reminder_due',
      householdId,
      recipientMemberId: reminder.assignedTo ?? null,
      title: reminder.title,
      body: `This was due ${describeLateness(nowMs - dueMs)}.`,
      deliverAt: reminder.dueAt,
      dedupeKey: dedupeKey('reminder_due', householdId, reminder.id, reminder.dueAt),
      subject: { entity: 'reminder', id: reminder.id },
    });
  }

  return sortDrafts(drafts);
}

function describeLateness(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * One draft per conflict, addressed to everybody it implicates.
 *
 * `info` conflicts are deliberately not notified: a tight-but-doable gap is
 * worth showing on a screen somebody chose to open, not worth interrupting
 * them for. The conflict's own id is already a hash of its facts, so it makes
 * the dedupe key directly — a re-detected identical conflict cannot re-notify.
 */
export function conflictsDetected(
  conflicts: readonly Conflict[],
  householdId: UUID,
  deliverAt: Instant,
): NotificationDraft[] {
  const drafts: NotificationDraft[] = [];

  for (const conflict of conflicts) {
    if (conflict.householdId !== householdId) continue;
    if (conflict.severity === 'info') continue;
    if (conflict.resolution !== undefined) continue; // already dealt with

    const recipients: Array<UUID | null> = conflict.memberIds.length > 0 ? [...conflict.memberIds] : [null];
    for (const recipientMemberId of recipients) {
      drafts.push({
        kind: 'conflict_detected',
        householdId,
        recipientMemberId,
        title: conflict.severity === 'blocking' ? 'Scheduling conflict' : 'Possible scheduling conflict',
        body: conflict.explanation,
        deliverAt,
        dedupeKey: dedupeKey('conflict_detected', householdId, conflict.id, recipientMemberId ?? ''),
        subject: { entity: 'conflict', id: conflict.id },
      });
    }
  }

  return sortDrafts(drafts);
}

/**
 * Low-stock notices, addressed to the household rather than to a person.
 *
 * The key includes the quantity on hand, so falling further notifies again
 * (three left is a different fact from one left) while a rescan at the same
 * level does not.
 */
export function lowStock(
  alerts: readonly LowStockLike[],
  householdId: UUID,
  deliverAt: Instant,
): NotificationDraft[] {
  return sortDrafts(
    alerts.map((alert) => ({
      kind: 'low_stock' as const,
      householdId,
      recipientMemberId: null,
      title: `Low stock: ${alert.name}`,
      body:
        alert.quantityOnHand <= 0
          ? `${alert.name} (${alert.sku}) is out of stock.`
          : `${alert.name} (${alert.sku}) is down to ${alert.quantityOnHand}, at or below the reorder point of ${alert.reorderPoint}.`,
      deliverAt,
      dedupeKey: dedupeKey('low_stock', householdId, alert.productId, String(alert.quantityOnHand)),
      subject: { entity: 'product', id: alert.productId },
    })),
  );
}

function sortDrafts(drafts: NotificationDraft[]): NotificationDraft[] {
  return drafts.sort((a, b) => {
    if (a.deliverAt !== b.deliverAt) return a.deliverAt < b.deliverAt ? -1 : 1;
    return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
  });
}

/* ---------------------------------------------------------------- merging */

export interface MergeResult {
  /** Drafts with no existing counterpart. The caller mints ids and inserts these. */
  created: NotificationDraft[];
  /** Existing rows the drafts matched. Untouched — in particular `readAt` survives. */
  unchanged: Notification[];
  /**
   * Existing unread rows that no current draft justifies any more: the conflict
   * was resolved, the stock was replenished. The caller may retire them.
   */
  stale: Notification[];
}

/**
 * Reconcile freshly generated drafts against what the centre already holds.
 *
 * This is the anti-nagging step. Something already delivered — and possibly
 * already read — must not be re-created just because the generator ran again.
 */
export function mergeNotifications(
  existing: readonly Notification[],
  drafts: readonly NotificationDraft[],
): MergeResult {
  const byKey = new Map<string, Notification>();
  for (const notification of existing) {
    // First write wins, so a duplicate row in the store cannot make the result
    // depend on which copy the database happened to return first.
    if (!byKey.has(notification.dedupeKey)) byKey.set(notification.dedupeKey, notification);
  }

  const draftKeys = new Set<string>();
  const created: NotificationDraft[] = [];
  const unchanged: Notification[] = [];

  for (const draft of drafts) {
    if (draftKeys.has(draft.dedupeKey)) continue; // the generator emitted it twice
    draftKeys.add(draft.dedupeKey);

    const match = byKey.get(draft.dedupeKey);
    if (match === undefined) created.push(draft);
    else unchanged.push(match);
  }

  const stale = existing.filter((n) => !draftKeys.has(n.dedupeKey) && n.readAt === undefined);

  return { created, unchanged, stale };
}

/* ------------------------------------------------------------------ inbox */

/**
 * What one member should see right now: addressed to them (or to the whole
 * household), already deliverable, and not yet read.
 *
 * Newest first — a notification centre is read from the top, and the thing that
 * just happened is the thing being looked for.
 */
export function inboxFor(
  notifications: readonly Notification[],
  memberId: UUID,
  householdId: UUID,
  now: Instant,
): Notification[] {
  const nowMs = parseInstant(now);
  if (nowMs === null) return [];

  return notifications
    .filter((n) => {
      if (n.householdId !== householdId) return false;
      if (n.recipientMemberId !== null && n.recipientMemberId !== memberId) return false;
      if (n.readAt !== undefined) return false;
      const at = parseInstant(n.deliverAt);
      return at !== null && at <= nowMs;
    })
    .sort((a, b) => {
      if (a.deliverAt !== b.deliverAt) return a.deliverAt < b.deliverAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

export function markRead(notification: Notification, at: Instant): Notification {
  // Idempotent on purpose: opening the centre twice must not move the timestamp
  // that tells us when it was first seen.
  if (notification.readAt !== undefined) return notification;
  return { ...notification, readAt: at };
}

export function unreadCount(
  notifications: readonly Notification[],
  memberId: UUID,
  householdId: UUID,
  now: Instant,
): number {
  return inboxFor(notifications, memberId, householdId, now).length;
}
