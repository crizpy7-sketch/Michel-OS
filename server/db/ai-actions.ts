import type { AIActionProposal, AIDecision, UUID } from '../../lib/contracts/index.ts';
import type { Queryable } from './client.ts';

export interface StoredAiAction {
  id: UUID;
  householdId: UUID;
  actorMemberId: UUID;
  proposal: AIActionProposal;
  verdict: AIDecision;
  executedAt: string | null;
  createdAt: string;
}

interface AiActionRow {
  id: string;
  household_id: string;
  actor_member_id: string;
  proposal: AIActionProposal | string;
  verdict: AIDecision;
  executed_at: string | Date | null;
  created_at: string | Date;
}

export async function insertAiAction(
  tx: Queryable,
  entry: {
    householdId: UUID;
    actorMemberId: UUID;
    proposal: AIActionProposal;
    verdict: AIDecision;
  },
): Promise<StoredAiAction> {
  const { rows } = await tx.query<AiActionRow>(
    `insert into ai_action (household_id, actor_member_id, proposal, verdict)
     values ($1,$2,$3,$4)
     returning *`,
    [entry.householdId, entry.actorMemberId, JSON.stringify(entry.proposal), entry.verdict],
  );
  return toStored(rows[0]!);
}

/**
 * Lock a proposal for execution. Household + actor are part of the lookup so an
 * action id copied from another session is useless, and FOR UPDATE makes two
 * simultaneous confirmation taps serialize on the same row.
 */
export async function lockAiAction(
  tx: Queryable,
  householdId: UUID,
  actorMemberId: UUID,
  actionId: UUID,
): Promise<StoredAiAction | null> {
  const { rows } = await tx.query<AiActionRow>(
    `select * from ai_action
      where id = $1 and household_id = $2 and actor_member_id = $3
      for update`,
    [actionId, householdId, actorMemberId],
  );
  return rows.length === 0 ? null : toStored(rows[0]!);
}

export async function markAiActionExecuted(
  tx: Queryable,
  householdId: UUID,
  actorMemberId: UUID,
  actionId: UUID,
  at: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `update ai_action set executed_at = $4
      where id = $1 and household_id = $2 and actor_member_id = $3 and executed_at is null`,
    [actionId, householdId, actorMemberId, at],
  );
  return rowCount === 1;
}

function toStored(row: AiActionRow): StoredAiAction {
  const proposal = typeof row.proposal === 'string' ? JSON.parse(row.proposal) as AIActionProposal : row.proposal;
  return {
    id: row.id,
    householdId: row.household_id,
    actorMemberId: row.actor_member_id,
    proposal,
    verdict: row.verdict,
    executedAt: row.executed_at === null ? null : new Date(row.executed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}
