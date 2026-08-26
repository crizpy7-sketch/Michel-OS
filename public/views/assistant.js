import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, denied, field, textarea, toast } from '../lib/ui.js';

export async function render(mount) {
  if (!state.can('ai.propose')) {
    mount.replaceChildren(denied('AI Assistant'));
    return;
  }

  const prompt = textarea({
    placeholder: 'Try: “Sydney has a game Saturday at 9 AM” or “add milk to the shopping list”',
    maxlength: 4000,
    required: true,
  });
  const answer = h('div', { style: { marginTop: '1rem' } });

  const form = h(
    'form',
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        answer.replaceChildren(card('Working…', null, h('p', { style: { color: 'var(--muted)' } }, 'Understanding your request and checking permissions.')));
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
    field('Ask or tell Michel OS', prompt),
    h('button', { class: 'btn btn--primary', type: 'submit' }, 'Do this'),
  );

  mount.replaceChildren(
    card(
      'AI Assistant',
      'guarded actions',
      h('p', { style: { color: 'var(--muted)' } }, 'Tell Michel OS what you need in normal language. AI can propose the action, but the app checks household access, permissions, dates, money and inventory rules before anything changes.'),
      form,
    ),
    answer,
  );
}

function renderProposal(mount, data) {
  const proposal = data.proposal ?? {};
  const verdict = data.verdict ?? {};
  const decision = verdict.decision ?? 'reject';
  const provider = data.provider === 'openai' ? `OpenAI${data.model ? ` · ${data.model}` : ''}` : 'Michel OS local parser';

  if (data.executed === true) {
    mount.replaceChildren(card(
      'Done',
      provider,
      chip('Applied', 'good'),
      h('p', { style: { marginTop: '.75rem' } }, describeAction(proposal)),
      h('p', { style: { color: 'var(--muted)' } }, 'The action passed Michel OS validation and was written once to the real app data.'),
    ));
    toast('Michel OS applied it', 'good');
    return;
  }

  const reasons = verdict.requiresConfirmationBecause ?? [];
  const errors = verdict.errors ?? [];
  const content = [
    h('p', {}, describeAction(proposal)),
    h('div', { style: { display: 'flex', gap: '.4rem', flexWrap: 'wrap', margin: '.65rem 0' } },
      chip(decision, decision === 'reject' ? 'alert' : decision === 'confirm' ? 'warn' : 'info'),
      chip(`${Math.round((proposal.confidence ?? 0) * 100)}% confidence`, 'quiet')),
  ];

  if (reasons.length > 0) {
    content.push(h('div', {}, ...reasons.map((reason) => h('p', { style: { color: 'var(--muted)' } }, `• ${reason}`))));
  }
  if (errors.length > 0) {
    content.push(h('div', {}, ...errors.map((error) => h('p', { style: { color: 'var(--danger, #8b1e1e)' } }, error.message ?? 'That request could not be validated.'))));
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
          mount.replaceChildren(card(
            'Done',
            provider,
            chip(decision === 'confirm' ? 'Confirmed & applied' : 'Applied', 'good'),
            h('p', { style: { marginTop: '.75rem' } }, describeAction(proposal)),
          ));
          toast(result.executed ? 'Action applied' : 'Action finished', 'good');
        } catch (error) {
          toast(error.message ?? 'That action could not be applied.', 'error');
          event.currentTarget.disabled = false;
        }
      },
    }, label);
    content.push(confirm);
  } else if (decision === 'reject') {
    content.push(h('p', { style: { color: 'var(--muted)' } }, 'Nothing was changed. Add the missing detail and try again.'));
  }

  mount.replaceChildren(card('Review', provider, ...content));
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
