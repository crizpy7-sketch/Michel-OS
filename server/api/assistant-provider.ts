import { AI_ACTION_TYPES, type AIActionProposal, type AIActionType } from '../../lib/contracts/index.ts';

/**
 * Actions Michel OS can deterministically execute in V1. The model is not
 * offered action names whose executor is not implemented; unsupported work is
 * filed for review instead of becoming a promise the app cannot keep.
 */
export const ASSISTANT_ACTION_TYPES = [
  'create_event',
  'create_recurring_schedule',
  'create_reminder',
  'add_shopping_item',
  'create_errand',
  'classify_inbox_item',
  'adjust_inventory',
  'record_expense',
] as const satisfies readonly AIActionType[];

const ALLOWED_DOMAINS = [
  'appointments',
  'practice',
  'competition',
  'games',
  'school',
  'errands',
  'shopping',
  'reminders',
  'work',
  'shia-baby',
  'inbox',
  'general',
] as const;

const CALENDAR_DOMAIN_ALIASES: Readonly<Record<string, (typeof ALLOWED_DOMAINS)[number]>> = Object.freeze({
  business: 'work',
});

export interface AssistantProposalContext {
  text: string;
  now: string;
  timezone: string;
  members: ReadonlyArray<{ id: string; displayName: string }>;
  business?: {
    id: string;
    name: string;
    timezone: string;
    employees: ReadonlyArray<{ id: string; displayName: string }>;
    products: ReadonlyArray<{ id: string; sku: string; name: string; quantityOnHand: number; reorderPoint: number }>;
    shifts: ReadonlyArray<{ id: string; employeeId?: string; startsAt: string; endsAt: string; role?: string; status: string }>;
  };
}

export interface ModelProposalResult {
  proposal: AIActionProposal;
  model: string;
}

const DEFAULT_MODEL = 'gpt-5.4-mini';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = 20_000;

const SYSTEM_INSTRUCTIONS = `You are the intent parser for Michel OS, a private family scheduling and small-business app.
You PROPOSE exactly one structured action. You never execute anything and you never invent entity ids.

Rules:
- Use only ids that appear in the supplied authorized context.
- Resolve relative dates/times from context.now in context.timezone.
- For an event, include title, domain, startsAt, endsAt and timezone. Default duration to 60 minutes only when the user gave a start time but no duration/end.
- The ONLY valid domain values are: ${ALLOWED_DOMAINS.join(', ')}.
- Personal job/work schedules use domain "work". Never use "business" as a domain. Shia Baby employee/store operations use domain "shia-baby".
- For a recurring event, use create_recurring_schedule and include a recurrence object.
- For a reminder, a dueAt is required. If the user did not provide enough timing detail, choose classify_inbox_item.
- For shopping, use add_shopping_item. For a physical trip/task, use create_errand.
- For adjust_inventory, productId must come from context.business.products and delta must be a non-zero whole quantity. Never invent a product id.
- For record_expense include amount in dollars, vendor, category and description. Never guess a dollar amount.
- If the request asks for another business mutation, a destructive edit, an unsupported action, or lacks required information, choose classify_inbox_item and put the original request in payload.notes. Include payload.domain when a category is clear.
- Do not include householdId, businessId, roles, permissions, user ids, auth data, or other server-assigned authority fields in payload. The server injects trusted scope.
- payload_json must be a JSON object encoded as a string, with only fields needed by the selected action.
- Confidence is 0..1 and reflects how completely the user's words determine the action.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...ASSISTANT_ACTION_TYPES] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', maxLength: 500 },
    payload_json: { type: 'string', maxLength: 8000 },
  },
  required: ['type', 'confidence', 'rationale', 'payload_json'],
  additionalProperties: false,
} as const;

/**
 * Returns null when no OpenAI key is configured, so the route can fall back to
 * the deterministic local classifier. Provider failures throw and are caught at
 * that boundary; an AI outage must not take the family organizer down.
 */
export async function proposeWithOpenAI(context: AssistantProposalContext): Promise<ModelProposalResult | null> {
  const apiKey = (process.env['OPENAI_API_KEY'] ?? '').trim();
  if (apiKey.length === 0) return null;

  const model = (process.env['OPENAI_MODEL'] ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        instructions: SYSTEM_INSTRUCTIONS,
        input: JSON.stringify(boundContext(context)),
        text: {
          format: {
            type: 'json_schema',
            name: 'michel_os_action',
            description: 'One proposed Michel OS action. The server validates and decides whether it may execute.',
            strict: true,
            schema: OUTPUT_SCHEMA,
          },
        },
        max_output_tokens: 900,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI Responses API returned HTTP ${response.status}.`);
    }

    const data = await response.json() as Record<string, unknown>;
    const output = extractOutputText(data);
    if (output === null) throw new Error('OpenAI returned no structured output text.');

    const outer = JSON.parse(output) as Record<string, unknown>;
    const type = outer['type'];
    const confidence = outer['confidence'];
    const rationale = outer['rationale'];
    const payloadJson = outer['payload_json'];

    if (typeof type !== 'string' || !ASSISTANT_ACTION_TYPES.includes(type as (typeof ASSISTANT_ACTION_TYPES)[number])) {
      throw new Error('OpenAI returned an unsupported action type.');
    }
    if (!(AI_ACTION_TYPES as readonly string[]).includes(type)) {
      throw new Error('OpenAI returned an action outside the frozen contract.');
    }
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('OpenAI returned an invalid confidence value.');
    }
    if (typeof payloadJson !== 'string') throw new Error('OpenAI returned no payload JSON.');

    const parsedPayload = JSON.parse(payloadJson) as unknown;
    if (!isPlainObject(parsedPayload)) throw new Error('OpenAI payload must be a JSON object.');

    return {
      model,
      proposal: normalizeProviderProposal({
        type: type as AIActionType,
        payload: parsedPayload,
        confidence,
        ...(typeof rationale === 'string' && rationale.trim().length > 0
          ? { rationale: rationale.trim().slice(0, 500) }
          : {}),
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize only narrow, deterministic provider synonyms before the frozen
 * validator sees the proposal. This is not a permissive repair layer: unknown
 * domains remain untouched so the validator can reject them.
 */
export function normalizeProviderProposal(proposal: AIActionProposal): AIActionProposal {
  if (proposal.type !== 'create_event' && proposal.type !== 'create_recurring_schedule') return proposal;

  const domain = proposal.payload['domain'];
  if (typeof domain !== 'string') return proposal;
  if ((ALLOWED_DOMAINS as readonly string[]).includes(domain)) return proposal;

  const normalized = CALENDAR_DOMAIN_ALIASES[domain.trim().toLowerCase()];
  if (normalized === undefined) return proposal;

  return {
    ...proposal,
    payload: {
      ...proposal.payload,
      domain: normalized,
    },
  };
}

function boundContext(context: AssistantProposalContext): Record<string, unknown> {
  return {
    user_request: context.text.slice(0, 4000),
    now: context.now,
    timezone: context.timezone,
    members: context.members.slice(0, 30),
    ...(context.business === undefined ? {} : {
      business: {
        id: context.business.id,
        name: context.business.name,
        timezone: context.business.timezone,
        employees: context.business.employees.slice(0, 100),
        products: context.business.products.slice(0, 200),
        shifts: context.business.shifts.slice(0, 100),
      },
    }),
  };
}

function extractOutputText(data: Record<string, unknown>): string | null {
  const output = data['output'];
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!isPlainObject(item) || item['type'] !== 'message') continue;
    const content = item['content'];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isPlainObject(part) || part['type'] !== 'output_text') continue;
      const text = part['text'];
      if (typeof text === 'string' && text.length > 0) return text;
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
