'use server';

/**
 * THE ONLY WRITE PATH.
 *
 * ARCHITECTURE.md §3: user input -> structured action proposal -> schema
 * validation -> permission validation -> conflict analysis -> confirmation ->
 * deterministic command -> mutation -> audit.
 *
 * Every mutation in the product goes through `submitProposal`, whether it came
 * from a form or from the AI capture bar. A form is just a proposal with
 * confidence 1. That matters: it means the validator is not a special path the
 * AI takes, it is *the* path, so a screen cannot accidentally acquire a
 * shortcut around permission and tenant checks.
 *
 * The clock is read here, at the edge, and injected into the validator — the
 * domain layer stays pure and deterministic.
 */
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getRepository, HOUSEHOLD_ID, BUSINESS_ID } from './db/index.ts';
import { currentSession } from './session.ts';
import { validateAction } from '../domains/ai/validator.ts';
import { authorize } from '../domains/household/permissions.ts';
import type {
  AIActionProposal, AIActionType, EventParticipant, EventRecord, ValidationIssue,
} from './contracts/index.ts';

export interface ActionOutcome {
  decision: 'executed' | 'confirm' | 'reject';
  message: string;
  /** Present when decision === 'confirm': what the user is being asked about. */
  pending?: { type: AIActionType; payload: Record<string, unknown>; reasons: string[] };
  errors?: ValidationIssue[];
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const numOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * Validate a proposal and, if it survives, execute it deterministically.
 *
 * `confirmed: true` means the user has already seen a confirmation prompt and
 * agreed. It downgrades a `confirm` verdict to execution — it can never rescue
 * a `reject`, which is the whole point: confirmation is consent, not authority.
 */
export async function submitProposal(
  proposal: AIActionProposal,
  opts: { confirmed?: boolean } = {},
): Promise<ActionOutcome> {
  const session = await currentSession();
  const repo = getRepository();

  const verdict = validateAction(proposal, {
    householdId: session.householdId,
    actorMemberId: session.member.id,
    now: new Date().toISOString(),
    can: session.can,
  });

  if (verdict.decision === 'reject') {
    return {
      decision: 'reject',
      message: verdict.errors[0]?.message ?? 'That request was refused.',
      errors: verdict.errors,
    };
  }

  if (verdict.decision === 'confirm' && !opts.confirmed) {
    return {
      decision: 'confirm',
      message: 'This one needs your confirmation before it happens.',
      pending: {
        type: verdict.action.type,
        payload: verdict.command?.payload ?? {},
        reasons: verdict.requiresConfirmationBecause ?? [],
      },
    };
  }

  const command = verdict.command;
  if (!command) {
    return { decision: 'reject', message: 'The validator produced no executable command.' };
  }

  // Second gate. The validator already consulted the permission oracle, but the
  // oracle is resource-blind; `authorize` sees the tenant and the row. Two
  // independent checks on the write path is deliberate.
  const gate = authorize({
    member: session.member,
    permission: permissionFor(command.type),
    householdId: session.householdId,
  });
  if (!gate.allowed) {
    return { decision: 'reject', message: gate.reason, errors: [{ path: 'permission', message: gate.reason, code: gate.code === 'tenant' ? 'tenant' : 'permission' }] };
  }

  const payload = command.payload;
  const now = new Date().toISOString();
  let entity = 'unknown';
  let entityId = '';
  let message = 'Done.';

  switch (command.type) {
    case 'create_event':
    case 'create_recurring_schedule': {
      const event: EventRecord = {
        id: randomUUID(),
        householdId: session.householdId,
        scheduleId: str(payload.scheduleId, 'sch-general'),
        domain: (str(payload.domain, 'general') as EventRecord['domain']),
        title: str(payload.title, 'Untitled'),
        notes: typeof payload.notes === 'string' ? payload.notes : undefined,
        location: typeof payload.location === 'string' ? payload.location : undefined,
        startsAt: str(payload.startsAt),
        endsAt: str(payload.endsAt),
        allDay: payload.allDay === true,
        timezone: str(payload.timezone, 'America/Chicago'),
        status: 'confirmed',
        createdBy: session.member.id,
        recurrence: (payload.recurrence as EventRecord['recurrence']) ?? undefined,
      };
      const participantIds = Array.isArray(payload.participantIds)
        ? payload.participantIds.filter((v): v is string => typeof v === 'string')
        : [];
      const participants: EventParticipant[] = participantIds.map((memberId, i) => ({
        eventId: event.id,
        memberId,
        role: i === 0 ? 'responsible' : 'attendee',
      }));
      repo.insertEvent(session.householdId, event, participants);
      entity = 'event';
      entityId = event.id;
      message = `Added “${event.title}”.`;
      break;
    }

    case 'cancel_event': {
      const id = str(payload.eventId);
      const ok = repo.cancelEvent(session.householdId, id);
      if (!ok) return { decision: 'reject', message: 'That event does not exist in this household.' };
      entity = 'event';
      entityId = id;
      message = 'Event cancelled.';
      break;
    }

    case 'update_event': {
      const id = str(payload.eventId);
      const updated = repo.updateEvent(session.householdId, id, {
        title: typeof payload.title === 'string' ? payload.title : undefined,
        startsAt: typeof payload.startsAt === 'string' ? payload.startsAt : undefined,
        endsAt: typeof payload.endsAt === 'string' ? payload.endsAt : undefined,
        location: typeof payload.location === 'string' ? payload.location : undefined,
        notes: typeof payload.notes === 'string' ? payload.notes : undefined,
      });
      if (!updated) return { decision: 'reject', message: 'That event does not exist in this household.' };
      entity = 'event';
      entityId = id;
      message = 'Event updated.';
      break;
    }

    case 'create_reminder': {
      const id = randomUUID();
      repo.insertReminder(session.householdId, {
        id,
        householdId: session.householdId,
        title: str(payload.title, 'Reminder'),
        dueAt: str(payload.dueAt, now),
        assignedTo: typeof payload.assignedTo === 'string' ? payload.assignedTo : session.member.id,
        status: 'pending',
      });
      entity = 'reminder';
      entityId = id;
      message = 'Reminder set.';
      break;
    }

    case 'complete_reminder': {
      const id = str(payload.reminderId);
      if (!repo.updateReminderStatus(session.householdId, id, 'completed')) {
        return { decision: 'reject', message: 'That reminder does not exist in this household.' };
      }
      entity = 'reminder';
      entityId = id;
      message = 'Reminder completed.';
      break;
    }

    case 'add_shopping_item': {
      const id = randomUUID();
      repo.insertShoppingItem(session.householdId, {
        id,
        householdId: session.householdId,
        listName: str(payload.listName, 'Groceries'),
        name: str(payload.name, 'Item'),
        quantity: numOr(payload.quantity, 1),
        status: 'needed',
      });
      entity = 'shopping_item';
      entityId = id;
      message = `Added ${str(payload.name, 'item')} to ${str(payload.listName, 'Groceries')}.`;
      break;
    }

    case 'mark_shopping_item_purchased': {
      const id = str(payload.itemId);
      if (!repo.updateShoppingStatus(session.householdId, id, 'purchased')) {
        return { decision: 'reject', message: 'That item does not exist in this household.' };
      }
      entity = 'shopping_item';
      entityId = id;
      message = 'Marked purchased.';
      break;
    }

    case 'create_errand': {
      const id = randomUUID();
      repo.insertErrand(session.householdId, {
        id,
        householdId: session.householdId,
        title: str(payload.title, 'Errand'),
        assignedTo: typeof payload.assignedTo === 'string' ? payload.assignedTo : undefined,
        dueAt: typeof payload.dueAt === 'string' ? payload.dueAt : undefined,
        status: 'open',
      });
      entity = 'errand';
      entityId = id;
      message = 'Errand added.';
      break;
    }

    case 'complete_errand': {
      const id = str(payload.errandId);
      if (!repo.updateErrandStatus(session.householdId, id, 'done')) {
        return { decision: 'reject', message: 'That errand does not exist in this household.' };
      }
      entity = 'errand';
      entityId = id;
      message = 'Errand done.';
      break;
    }

    case 'assign_shift': {
      const shiftId = str(payload.shiftId);
      const employeeId = typeof payload.employeeId === 'string' ? payload.employeeId : null;
      if (!repo.assignShift(BUSINESS_ID, shiftId, employeeId)) {
        return { decision: 'reject', message: 'That shift does not exist.' };
      }
      entity = 'shift';
      entityId = shiftId;
      message = employeeId ? 'Shift assigned.' : 'Shift cleared.';
      break;
    }

    case 'adjust_inventory': {
      const productId = str(payload.productId);
      const product = repo.adjustInventory(BUSINESS_ID, productId, numOr(payload.delta, 0));
      if (!product) return { decision: 'reject', message: 'That product does not exist.' };
      entity = 'product';
      entityId = productId;
      message = `${product.name} is now at ${product.quantityOnHand}.`;
      break;
    }

    case 'record_expense': {
      const id = randomUUID();
      repo.insertExpense(BUSINESS_ID, {
        id,
        businessId: BUSINESS_ID,
        occurredAt: str(payload.occurredAt, now),
        vendor: str(payload.vendor, 'Unknown vendor'),
        category: str(payload.category, 'Other'),
        amount: numOr(payload.amount, 0),
        description: typeof payload.description === 'string' ? payload.description : undefined,
      });
      entity = 'expense';
      entityId = id;
      message = 'Expense recorded.';
      break;
    }

    case 'classify_inbox_item':
    case 'dismiss_inbox_item': {
      const id = str(payload.itemId);
      const status = command.type === 'dismiss_inbox_item' ? 'dismissed' : 'classified';
      if (!repo.updateInboxStatus(session.householdId, id, status, typeof payload.domain === 'string' ? payload.domain : undefined)) {
        return { decision: 'reject', message: 'That inbox item does not exist in this household.' };
      }
      entity = 'inbox_item';
      entityId = id;
      message = status === 'dismissed' ? 'Dismissed.' : 'Filed.';
      break;
    }

    default:
      return {
        decision: 'reject',
        message: `“${command.type}” passed validation but has no executor yet.`,
        errors: [{ path: 'type', message: 'no executor implemented', code: 'logic' }],
      };
  }

  repo.appendAudit({
    id: randomUUID(),
    householdId: session.householdId,
    actorMemberId: session.member.id,
    action: command.type,
    entity,
    entityId,
    at: now,
    after: payload,
  });

  revalidatePath('/', 'layout');
  return { decision: 'executed', message };
}

/** Permission required to execute each command the app can run. */
function permissionFor(type: AIActionType): Parameters<typeof authorize>[0]['permission'] {
  switch (type) {
    case 'create_event':
    case 'create_recurring_schedule':
    case 'create_reminder':
    case 'create_errand':
    case 'add_shopping_item':
      return 'event.create';
    case 'update_event':
    case 'complete_reminder':
    case 'complete_errand':
    case 'mark_shopping_item_purchased':
    case 'classify_inbox_item':
    case 'dismiss_inbox_item':
      return 'event.update.any';
    case 'cancel_event':
      return 'event.delete';
    case 'assign_shift':
      return 'employee.schedule';
    case 'adjust_inventory':
      return 'business.manage';
    case 'record_expense':
      return 'finance.manage';
    default:
      return 'event.create';
  }
}

/* ------------------------------------------------ form-shaped wrappers --- */

/** A form submission is a proposal with full confidence. Same pipeline. */
export async function runAction(
  type: AIActionType,
  payload: Record<string, unknown>,
  opts: { confirmed?: boolean } = {},
): Promise<ActionOutcome> {
  return submitProposal({ type, payload, confidence: 1 }, opts);
}
