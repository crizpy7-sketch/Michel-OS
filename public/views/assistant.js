import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, field, textarea, toast } from '../lib/ui.js';

export async function render(mount) {
  const prompt = textarea({ placeholder: 'Tell me what is happening: “Sydney has a game Saturday at 9 AM”', maxlength: 4000, required: true });
  const answer = h('div', { style: { marginTop: '1rem' } });

  mount.replaceChildren(
    card('AI Assistant', 'safe proposal mode',
      h('p', { style: { color: 'var(--muted)' } }, 'V1 understands family scheduling text through the same guarded Inbox pipeline. It proposes; the validator decides. It never silently changes your calendar.'),
      h('form', { onSubmit: async (e) => {
        e.preventDefault(); const btn = e.currentTarget.querySelector('button[type="submit"]'); btn.disabled = true;
        try {
          const data = await api.post(`/api/households/${state.household.id}/inbox`, { text: prompt.value.trim() });
          const c = data.classification ?? {}; const verdict = data.verdict ?? {};
          answer.replaceChildren(card('What I understood', null,
            h('p', {}, `Category: ${c.domain ?? 'inbox'}`),
            h('p', {}, `Confidence: ${Math.round((c.confidence ?? 0) * 100)}%`),
            h('div', { style: { display: 'flex', gap: '.4rem', flexWrap: 'wrap' } }, ...(c.signals ?? []).map((signal) => chip(String(signal), 'quiet')), verdict.decision ? chip(verdict.decision, verdict.decision === 'reject' ? 'alert' : 'info') : null),
            (verdict.requiresConfirmationBecause ?? []).length
              ? h('p', { style: { color: 'var(--muted)', marginTop: '.75rem' } }, `Needs confirmation: ${verdict.requiresConfirmationBecause.join(' · ')}`)
              : h('p', { style: { color: 'var(--muted)', marginTop: '.75rem' } }, 'Saved to Inbox for review.'),
          ));
          prompt.value = '';
        } catch (error) { toast(error.message ?? 'The assistant could not process that.', 'error'); }
        finally { btn.disabled = false; }
      } }, field('Ask or tell Michel OS', prompt), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Understand this')),
    ), answer,
  );
}
