import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, denied, field, icon, ICONS, textarea, toast } from '../lib/ui.js';

export async function render(mount) {
  if (!state.can('ai.propose')) {
    mount.replaceChildren(denied('AI Assistant'));
    return;
  }

  // The example used a fixed name that belongs to no household using this app.
  // A prompt suggestion is more persuasive when it names somebody the person
  // reading it actually has to schedule around.
  const example = state.members.find((m) => m.id !== state.member?.id && m.active !== false)
    ?? state.members.find((m) => m.active !== false);
  const who = example?.displayName ?? 'Sam';

  const prompt = textarea({
    placeholder: `Try: “${who} has a game Saturday at 9 AM” or “add milk to the shopping list”`,
    maxlength: 4000,
    required: true,
  });
  const answer = h('div', { class: 'assistant-answer', style: { marginTop: '1rem' } });

  const form = h(
    'form',
    {
      class: 'assistant-form',
      onSubmit: async (event) => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        answer.replaceChildren(mark(card(
          'Working…',
          null,
          h('div', { class: 'assistant-working' },
            h('span', { class: 'assistant-sparkles', 'aria-hidden': 'true' }, '✦'),
            h('p', { class: 'muted' }, 'Understanding your request and checking permissions.'),
          ),
        ), 'assistant-result assistant-result--working'));
        try {
          const data = await api.post(`/api/households/${state.household.id}/assistant/propose`, {
            text: prompt.value.trim(),
          });
          renderProposal(answer, data);
          if (data.executed === true) prompt.value = '';
        } catch (error) {
          answer.replaceChildren();
          toast(error.message ?? 'The assistant could not process that.', 'error');
        } finally {
          button.disabled = false;
        }
      },
    },
    field('What would you like me to do?', prompt),
    h('button', { class: 'btn btn--primary btn--block assistant-submit', type: 'submit' }, 'Do this'),
  );

  const intro = mark(card(
    'Your helpful AI Assistant',
    null,
    h('div', { class: 'assistant-intro__body' },
      h('div', { class: 'assistant-orb', 'aria-hidden': 'true' }, h('span', {}, '✦'), h('span', {}, '✦')),
      h('p', { class: 'assistant-intro__copy' }, 'Ask me to add, schedule, plan, or organize anything across Michel OS. I’ll take care of the request, while the app keeps the final safety checks.'),
    ),
  ), 'assistant-intro');

  const promptCard = mark(card(null, null, form), 'assistant-prompt-card');
  mount.replaceChildren(intro, promptCard, answer);
}

function renderProposal(mount, data) {
  const proposal = data.proposal ?? {};
  const verdict = data.verdict ?? {};
  const decision = verdict.decision ?? 'reject';
  const provider = data.provider === 'openai' ? `OpenAI${data.model ? ` · ${data.model}` : ''}` : 'Michel OS local parser';

  if (data.executed === true) {
    mount.replaceChildren(mark(card(
      'Applied',
      provider,
      h('div', { class: 'assistant-applied-row' },
        h('span', { class: 'assistant-check', 'aria-hidden': 'true' }, icon(ICONS.check, 22)),
        h('div', {},
          h('p', { class: 'assistant-action-title' }, describeAction(proposal)),
          h('p', { class: 'muted' }, 'Michel OS validation passed.'),
          h('p', { class: 'muted' }, 'The action was written once to the real app data.'),
        ),
      ),
    ), 'assistant-result assistant-result--applied'));
    toast('Michel OS applied it', 'good');
    return;
  }

  const reasons = verdict.requiresConfirmationBecause ?? [];
  const errors = verdict.errors ?? [];
  const content = [
    h('p', { class: 'assistant-action-title' }, describeAction(proposal)),
    h('div', { class: 'assistant-status-row' },
      chip(decision, decision === 'reject' ? 'alert' : decision === 'confirm' ? 'warn' : 'info'),
      chip(`${Math.round((proposal.confidence ?? 0) * 100)}% confidence`, 'quiet')),
  ];

  if (reasons.length > 0) {
    content.push(h('div', { class: 'assistant-reasons' }, ...reasons.map((reason) => h('p', { class: 'muted' }, `• ${reason}`))));
  }
  if (errors.length > 0) {
    content.push(h('div', { class: 'assistant-errors' }, ...errors.map((error) => h('p', {}, error.message ?? 'That request could not be validated.'))));
  }

  if ((decision === 'confirm' || decision === 'execute') && data.actionId) {
    const label = decision === 'confirm' ? 'Confirm and apply' : 'Apply';
    const confirm = h('button', {
      class: 'btn btn--primary',
      type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const result = await api.post(`/api/households/${state.household.id}/assistant/actions/${encodeURIComponent(data.actionId)}/execute`, {});
          mount.replaceChildren(mark(card(
            'Applied',
            provider,
            h('div', { class: 'assistant-applied-row' },
              h('span', { class: 'assistant-check', 'aria-hidden': 'true' }, icon(ICONS.check, 22)),
              h('div', {}, h('p', { class: 'assistant-action-title' }, describeAction(proposal))),
            ),
          ), 'assistant-result assistant-result--applied'));
          toast(result.executed ? 'Action applied' : 'Action finished', 'good');
        } catch (error) {
          toast(error.message ?? 'That action could not be applied.', 'error');
          event.currentTarget.disabled = false;
        }
      },
    }, label);
    content.push(confirm);
  } else if (decision === 'reject') {
    content.push(h('p', { class: 'muted' }, 'Nothing was changed. Add the missing detail and try again.'));
  }

  mount.replaceChildren(mark(card('Review', provider, ...content), `assistant-result assistant-result--${decision}`));
}

function mark(node, className) {
  node.classList.add(...className.split(/\s+/).filter(Boolean));
  return node;
}

function describeAction(proposal) {
  const payload = proposal.payload ?? {};
  const type = proposal.type ?? 'request';
  if (type === 'create_event' || type === 'create_recurring_schedule') {
    return `${payload.title ?? 'Event'}${payload.startsAt ? ` · ${friendlyDate(payload.startsAt)}` : ''}`;
  }
  if (type === 'create_reminder') return `Reminder: ${payload.title ?? 'Untitled'}`;
  if (type === 'add_shopping_item') return `Add ${payload.name ?? 'item'} to shopping`;
  if (type === 'create_errand') return `Errand: ${payload.title ?? 'Untitled'}`;
  if (type === 'adjust_inventory') return `Adjust inventory by ${payload.delta ?? '?'} unit(s)`;
  if (type === 'record_expense') return `Record expense: $${Number(payload.amount ?? 0).toFixed(2)} · ${payload.description ?? 'expense'}`;
  if (type === 'classify_inbox_item') return 'Save this to Inbox for review';
  return String(type).replace(/_/g, ' ');
}

function friendlyDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: state.timezone,
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}
