import type {
  AIActionProposal, AIActionVerdict, DomainKey, RecurrenceRule, UUID,
} from '../../lib/contracts/index.ts';
import { DOMAINS } from '../../lib/contracts/index.ts';
import { classifyInboxItem } from '../../domains/ai/inbox.ts';
import { validateAction } from '../../domains/ai/validator.ts';
import {
  addShoppingItem, createErrand, createReminder,
} from '../../domains/personal/lists.ts';
import { recordExpense, recordMovement } from '../../domains/shia-baby/ledger.ts';
import type { Queryable } from '../db/client.ts';
import * as repo from '../db/repositories.ts';
import {
  insertAiAction, lockAiAction, markAiActionExecuted,
} from '../db/ai-actions.ts';
import { problem, type Router } from '../http/core.ts';
import {
  created, fromIssues, guard, ok, str, type AppEnv, type AuthedContext,
} from './context.ts';
import { proposeWithOpenAI, type AssistantProposalContext } from './assistant-provider.ts';

const DOMAIN_LABEL: Readonly<Record<DomainKey, string>> = {
  appointments: 'Appointments', practice: 'Practice', competition: 'Competition',
  games: 'Games', school: 'School', errands: 'Errands', shopping: 'Shopping',
  reminders: 'Reminders', work: 'Hubby Work', 'shia-baby': 'Shia Baby',
  inbox: 'Inbox', general: 'General',
};

const EXECUTABLE = new Set([
  'create_event', 'create_recurring_schedule', 'create_reminder', 'add_shopping_item',
  'create_errand', 'classify_inbox_item', 'adjust_inventory', 'record_expense',
]);

interface ProposalContext {
  members: Awaited<ReturnType<typeof repo.listMembers>>;
  business: Awaited<ReturnType<typeof repo.getBusinessForHousehold>>;
}

export function registerAssistantRoutes(router: Router, env: AppEnv): void {
  /**
   * The provider proposes only. Validation runs after it and every proposal is
   * persisted before anything can execute. If OpenAI is unavailable or no key
   * is configured, Michel OS falls back to the deterministic Inbox classifier.
   */
  router.post('/api/households/:householdId/assistant/propose',
    guard(env, { permission: 'ai.propose' }, async (ctx) => {
      const text = str(ctx.req.body, 'text', 4000);
      if (text === null) return problem(422, 'invalid', 'Tell Michel OS what you want to do.');

      const context = await loadProposalContext(ctx);
      const proposed = await modelOrLocalProposal(ctx, text, context);
      const verdict = validateForActor(ctx, proposed.proposal, context.business?.id);

      const stored = await ctx.env.db.transaction((tx) => insertAiAction(tx, {
        householdId: ctx.actor.household.id,
        actorMemberId: ctx.actor.member.id,
        proposal: proposed.proposal,
        verdict: verdict.decision,
      }));

      // Owners may have ai.execute.autonomous. The validator, not the route,
      // decides whether this individual command actually qualifies.
      if (verdict.decision === 'execute' && verdict.command !== undefined) {
        const execution = await executeStoredAction(ctx, stored.id, false);
        if (execution.kind === 'executed') {
          return created({
            actionId: stored.id,
            provider: proposed.provider,
            ...(proposed.model ? { model: proposed.model } : {}),
            proposal: proposed.proposal,
            verdict: publicVerdict(verdict),
            executed: true,
            result: execution.result,
          });
        }
      }

      return created({
        actionId: stored.id,
        provider: proposed.provider,
        ...(proposed.model ? { model: proposed.model } : {}),
        proposal: proposed.proposal,
        verdict: publicVerdict(verdict),
        executed: false,
      });
    }));

  /**
   * Calling this endpoint IS the human confirmation. It re-runs validation
   * against current membership/permissions and locks the stored proposal, so a
   * double tap cannot execute twice and a stale permission cannot be replayed.
   */
  router.post('/api/households/:householdId/assistant/actions/:actionId/execute',
    guard(env, { permission: 'ai.propose' }, async (ctx) => {
      const actionId = ctx.req.params['actionId'];
      if (actionId === undefined || actionId.length === 0) {
        return problem(404, 'not_found', 'No such assistant action.');
      }
      const execution = await executeStoredAction(ctx, actionId, true);
      switch (execution.kind) {
        case 'missing': return problem(404, 'not_found', 'No such assistant action.');
        case 'already_executed': return problem(409, 'already_executed', 'That assistant action already ran.');
        case 'rejected': return problem(422, 'rejected', execution.message);
        case 'unsupported': return problem(422, 'unsupported', execution.message);
        case 'issues': return fromIssues(execution.issues);
        case 'executed': return ok({ executed: true, result: execution.result });
      }
    }));
}

async function loadProposalContext(ctx: AuthedContext): Promise<ProposalContext> {
  const members = await repo.listMembers(ctx.env.db, ctx.actor.household.id);
  const business = ctx.can('business.read')
    ? await repo.getBusinessForHousehold(ctx.env.db, ctx.actor.household.id)
    : null;
  return { members, business };
}

async function modelOrLocalProposal(
  ctx: AuthedContext,
  text: string,
  context: ProposalContext,
): Promise<{ proposal: AIActionProposal; provider: 'openai' | 'local'; model?: string }> {
  const modelContext: AssistantProposalContext = {
    text,
    now: ctx.now,
    timezone: ctx.actor.household.timezone,
    members: context.members.map((member) => ({ id: member.id, displayName: member.displayName })),
  };

  if (context.business !== null) {
    const from = new Date(Date.parse(ctx.now) - 24 * 3600_000).toISOString();
    const to = new Date(Date.parse(ctx.now) + 60 * 24 * 3600_000).toISOString();
    const [employees, products, shifts] = await Promise.all([
      repo.listEmployees(ctx.env.db, ctx.actor.household.id, context.business.id),
      repo.listProducts(ctx.env.db, ctx.actor.household.id, context.business.id),
      repo.listShifts(ctx.env.db, ctx.actor.household.id, context.business.id, { from, to }),
    ]);
    modelContext.business = {
      id: context.business.id,
      name: context.business.name,
      timezone: context.business.timezone,
      employees: employees.map((employee) => ({ id: employee.id, displayName: employee.displayName })),
      products: products.map((product) => ({
        id: product.id, sku: product.sku, name: product.name,
        quantityOnHand: product.quantityOnHand, reorderPoint: product.reorderPoint,
      })),
      shifts: shifts.map((shift) => ({
        id: shift.id,
        ...(shift.employeeId ? { employeeId: shift.employeeId } : {}),
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        ...(shift.role ? { role: shift.role } : {}),
        status: shift.status,
      })),
    };
  }

  try {
    const model = await proposeWithOpenAI(modelContext);
    if (model !== null) return { proposal: model.proposal, provider: 'openai', model: model.model };
  } catch (error) {
    console.warn(`[assistant] OpenAI proposal failed; using deterministic fallback: ${safeError(error)}`);
  }

  const classified = classifyInboxItem({
    id: 'assistant-draft',
    householdId: ctx.actor.household.id,
    rawText: text,
    capturedBy: ctx.actor.member.id,
    capturedAt: ctx.now,
    status: 'unclassified',
  }, {
    householdId: ctx.actor.household.id,
    now: ctx.now,
    timezone: ctx.actor.household.timezone,
    members: modelContext.members,
    employees: modelContext.business?.employees,
  });
  return { proposal: classified.proposal, provider: 'local' };
}

function validateForActor(
  ctx: AuthedContext,
  proposal: AIActionProposal,
  businessId?: UUID,
): AIActionVerdict {
  return validateAction(proposal, {
    householdId: ctx.actor.household.id,
    actorMemberId: ctx.actor.member.id,
    now: ctx.now,
    can: ctx.can,
    ...(businessId ? { businessId } : {}),
  });
}

type Execution =
  | { kind: 'executed'; result: unknown }
  | { kind: 'missing' }
  | { kind: 'already_executed' }
  | { kind: 'rejected'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'issues'; issues: Array<{ path: string; message: string; code: 'required' | 'type' | 'range' | 'enum' | 'format' | 'permission' | 'tenant' | 'logic' }> };

async function executeStoredAction(
  ctx: AuthedContext,
  actionId: UUID,
  humanConfirmed: boolean,
): Promise<Execution> {
  return ctx.env.db.transaction(async (tx) => {
    const stored = await lockAiAction(tx, ctx.actor.household.id, ctx.actor.member.id, actionId);
    if (stored === null) return { kind: 'missing' } as const;
    if (stored.executedAt !== null) return { kind: 'already_executed' } as const;

    const business = ctx.can('business.read')
      ? await repo.getBusinessForHousehold(tx, ctx.actor.household.id)
      : null;
    const verdict = validateForActor(ctx, stored.proposal, business?.id);
    if (verdict.decision === 'reject' || verdict.command === undefined) {
      return {
        kind: 'rejected',
        message: verdict.errors.map((issue) => issue.message).join(' ') || 'That action is no longer valid.',
      } as const;
    }
    if (verdict.decision === 'confirm' && !humanConfirmed) {
      return { kind: 'rejected', message: 'This action still needs your confirmation.' } as const;
    }
    if (!EXECUTABLE.has(verdict.command.type)) {
      return { kind: 'unsupported', message: 'That action is not executable in Michel OS V1.' } as const;
    }

    const result = await executeCommand(tx, ctx, verdict.command, business?.id);
    if (result.kind !== 'executed') return result;

    const marked = await markAiActionExecuted(
      tx, ctx.actor.household.id, ctx.actor.member.id, actionId, ctx.now,
    );
    if (!marked) return { kind: 'already_executed' } as const;

    await repo.writeAudit(tx, {
      householdId: ctx.actor.household.id,
      actorMemberId: ctx.actor.member.id,
      action: `ai.execute.${verdict.command.type}`,
      entity: 'ai_action',
      entityId: actionId,
      after: { command: verdict.command },
    });
    return result;
  });
}

async function executeCommand(
  tx: Queryable,
  ctx: AuthedContext,
  command: NonNullable<AIActionVerdict['command']>,
  businessId?: UUID,
): Promise<Execution> {
  const payload = command.payload;

  if (command.type === 'create_event' || command.type === 'create_recurring_schedule') {
    const domain = String(payload['domain'] ?? 'general') as DomainKey;
    if (!DOMAINS.includes(domain)) return { kind: 'rejected', message: 'Unknown schedule category.' };
    const participantIds = stringArray(payload['participantIds']);
    const members = await repo.listMembers(tx, ctx.actor.household.id);
    const knownMembers = new Set(members.map((member) => member.id));
    if (participantIds.some((id) => !knownMembers.has(id))) {
      return { kind: 'rejected', message: 'The assistant named somebody outside this household.' };
    }

    const schedule = await repo.ensureSchedule(tx, ctx.actor.household.id, domain, DOMAIN_LABEL[domain]);
    const event = await repo.createEvent(tx, {
      householdId: ctx.actor.household.id,
      scheduleId: schedule.id,
      domain,
      title: String(payload['title']),
      ...(typeof payload['notes'] === 'string' ? { notes: payload['notes'] } : {}),
      ...(typeof payload['location'] === 'string' ? { location: payload['location'] } : {}),
      startsAt: String(payload['startsAt']),
      endsAt: String(payload['endsAt']),
      allDay: payload['allDay'] === true,
      timezone: typeof payload['timezone'] === 'string' ? payload['timezone'] : ctx.actor.household.timezone,
      createdBy: ctx.actor.member.id,
      ...(payload['recurrence'] && typeof payload['recurrence'] === 'object'
        ? { recurrence: payload['recurrence'] as RecurrenceRule }
        : {}),
      participants: participantIds.map((memberId) => ({ memberId })),
    });
    return { kind: 'executed', result: { entity: 'event', item: event } };
  }

  if (command.type === 'create_reminder') {
    const assignedTo = typeof payload['assignedTo'] === 'string' ? payload['assignedTo'] : undefined;
    if (assignedTo !== undefined) {
      const members = await repo.listMembers(tx, ctx.actor.household.id);
      if (!members.some((member) => member.id === assignedTo)) {
        return { kind: 'rejected', message: 'The reminder assignee is not in this household.' };
      }
    }
    const domainResult = createReminder({
      id: 'pending',
      householdId: ctx.actor.household.id,
      actor: ctx.actor.member,
      title: String(payload['title']),
      dueAt: String(payload['dueAt']),
      ...(assignedTo ? { assignedTo } : {}),
    });
    if (!domainResult.ok) return { kind: 'issues', issues: domainResult.issues };
    const { id: _drop, ...reminder } = domainResult.value;
    return { kind: 'executed', result: { entity: 'reminder', item: await repo.insertReminder(tx, reminder) } };
  }

  if (command.type === 'add_shopping_item') {
    const domainResult = addShoppingItem({
      id: 'pending',
      householdId: ctx.actor.household.id,
      actor: ctx.actor.member,
      name: String(payload['name']),
      quantity: Number(payload['quantity'] ?? 1),
      ...(typeof payload['listName'] === 'string' ? { listName: payload['listName'] } : {}),
    });
    if (!domainResult.ok) return { kind: 'issues', issues: domainResult.issues };
    const { id: _drop, ...item } = domainResult.value;
    return { kind: 'executed', result: { entity: 'shopping_item', item: await repo.insertShoppingItem(tx, item) } };
  }

  if (command.type === 'create_errand') {
    const assignedTo = typeof payload['assignedTo'] === 'string' ? payload['assignedTo'] : undefined;
    if (assignedTo !== undefined) {
      const members = await repo.listMembers(tx, ctx.actor.household.id);
      if (!members.some((member) => member.id === assignedTo)) {
        return { kind: 'rejected', message: 'The errand assignee is not in this household.' };
      }
    }
    const domainResult = createErrand({
      id: 'pending',
      householdId: ctx.actor.household.id,
      actor: ctx.actor.member,
      title: String(payload['title']),
      ...(assignedTo ? { assignedTo } : {}),
      ...(typeof payload['dueAt'] === 'string' ? { dueAt: payload['dueAt'] } : {}),
      ...(typeof payload['location'] === 'string' ? { location: payload['location'] } : {}),
    });
    if (!domainResult.ok) return { kind: 'issues', issues: domainResult.issues };
    const { id: _drop, ...item } = domainResult.value;
    return { kind: 'executed', result: { entity: 'errand', item: await repo.insertErrand(tx, item) } };
  }

  if (command.type === 'classify_inbox_item') {
    const text = typeof payload['notes'] === 'string'
      ? payload['notes']
      : typeof payload['title'] === 'string' ? payload['title'] : 'Assistant item needing review';
    const item = await repo.insertInboxItem(tx, {
      householdId: ctx.actor.household.id,
      rawText: text,
      capturedBy: ctx.actor.member.id,
    });
    const domain = typeof payload['domain'] === 'string' && DOMAINS.includes(payload['domain'] as DomainKey)
      ? payload['domain'] as DomainKey
      : 'inbox';
    const classified = await repo.classifyInboxItemRow(
      tx, ctx.actor.household.id, item.id, domain, { source: 'assistant', command },
    );
    return { kind: 'executed', result: { entity: 'inbox_item', item: classified ?? item } };
  }

  if (command.type === 'adjust_inventory') {
    if (businessId === undefined) return { kind: 'rejected', message: 'Shia Baby is not configured.' };
    const products = await repo.listProducts(tx, ctx.actor.household.id, businessId);
    const productId = String(payload['productId']);
    const product = products.find((candidate) => candidate.id === productId);
    if (product === undefined) return { kind: 'rejected', message: 'That inventory item no longer exists.' };
    const domainResult = recordMovement({
      id: 'pending', businessId, product, actor: ctx.actor.member,
      householdId: ctx.actor.household.id, kind: 'adjustment',
      quantityDelta: Number(payload['delta']), at: ctx.now,
      ...(typeof payload['reason'] === 'string' ? { note: payload['reason'] } : {}),
    });
    if (!domainResult.ok) return { kind: 'issues', issues: domainResult.issues };
    const { id: _drop, ...movement } = domainResult.value.movement;
    await repo.insertMovement(tx, ctx.actor.household.id, movement);
    const productSaved = await repo.saveProduct(tx, ctx.actor.household.id, domainResult.value.product);
    return { kind: 'executed', result: { entity: 'product', item: productSaved } };
  }

  if (command.type === 'record_expense') {
    if (businessId === undefined) return { kind: 'rejected', message: 'Shia Baby is not configured.' };
    const amount = Number(payload['amount']);
    const domainResult = recordExpense({
      id: 'pending', businessId, actor: ctx.actor.member, householdId: ctx.actor.household.id,
      at: typeof payload['occurredAt'] === 'string' ? payload['occurredAt'] : ctx.now,
      vendor: typeof payload['vendor'] === 'string' ? payload['vendor'] : 'Unspecified vendor',
      category: typeof payload['category'] === 'string' ? payload['category'] : 'Other',
      amountCents: Math.round(amount * 100),
      description: String(payload['description']),
    });
    if (!domainResult.ok) return { kind: 'issues', issues: domainResult.issues };
    const { id: _drop, ...expense } = domainResult.value;
    return { kind: 'executed', result: { entity: 'expense', item: await repo.insertExpense(tx, ctx.actor.household.id, expense) } };
  }

  return { kind: 'unsupported', message: 'That action is not executable in Michel OS V1.' };
}

function publicVerdict(verdict: AIActionVerdict): Record<string, unknown> {
  return {
    decision: verdict.decision,
    errors: verdict.errors,
    requiresConfirmationBecause: verdict.requiresConfirmationBecause ?? [],
    ...(verdict.command ? { command: verdict.command } : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'provider_error';
}
