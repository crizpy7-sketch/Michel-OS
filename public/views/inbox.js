import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, empty, field, textarea, toast, withStates } from '../lib/ui.js';

export async function render(mount) { await load(mount); }

async function load(mount) {
  await withStates(mount, 'list', () => api.get(`/api/households/${state.household.id}/inbox`),
    (data) => h('div', {},
      state.can('event.create') ? capture(mount) : null,
      (data.items ?? []).length === 0
        ? empty({ title: 'Inbox is empty', body: 'Drop a thought here and Michel OS will classify it without silently changing your calendar.' })
        : h('div', {}, ...(data.items ?? []).map((item) => card(item.rawText, item.suggestedDomain ? String(item.suggestedDomain).replace(/-/g, ' ') : 'unfiled',
            h('div', { style: { display: 'flex', gap: '.4rem', flexWrap: 'wrap' } },
              chip(item.status ?? 'captured', item.status === 'classified' ? 'info' : 'quiet'),
              item.suggestedDomain ? chip(item.suggestedDomain, 'quiet') : null,
            ),
          ))),
    ));
}

function capture(mount) {
  const text = textarea({ placeholder: 'Example: Mateo has practice Tuesday at 6 PM', required: true, maxlength: 4000 });
  const result = h('div');
  return card('Quick capture', null,
    h('form', { onSubmit: async (e) => {
      e.preventDefault(); const btn = e.currentTarget.querySelector('button[type="submit"]'); btn.disabled = true;
      try {
        const saved = await api.post(`/api/households/${state.household.id}/inbox`, { text: text.value.trim() });
        const c = saved.classification ?? {};
        result.replaceChildren(h('div', { class: 'card', style: { marginTop: '.75rem' } },
          h('p', {}, `Filed as ${c.domain ?? 'inbox'} · ${Math.round((c.confidence ?? 0) * 100)}% confidence`),
          saved.verdict?.decision ? chip(saved.verdict.decision, saved.verdict.decision === 'reject' ? 'alert' : 'info') : null,
          (saved.verdict?.requiresConfirmationBecause ?? []).length ? h('p', { style: { color: 'var(--muted)', marginTop: '.5rem' } }, saved.verdict.requiresConfirmationBecause.join(' · ')) : null,
        ));
        text.value = ''; toast('Captured');
      } catch (error) { toast(error.message ?? 'Could not capture that.', 'error'); }
      finally { btn.disabled = false; }
    } }, field('What should Michel OS remember?', text), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Classify')),
    result,
  );
}
