/**
 * Appearance — the seasonal skin picker.
 *
 * This exists as its own route because the previous arrangement failed twice
 * over: the control was a bare <select> at the bottom of /more, and the skins
 * it selected changed three background tints at 8-14% alpha. Choosing one
 * produced no visible result, so the honest description was that themes did
 * not work.
 *
 * Two things fix that. The skins now carry real weight (see the data-skin
 * blocks in app.css), and this screen shows each one as a swatch you can see
 * before you pick it — a theme chooser you cannot preview is a guess.
 */
import { h } from '../lib/dom.js';
import { card, toast } from '../lib/ui.js';
import {
  APPEARANCE_OPTIONS,
  getAppearancePreference,
  setAppearancePreference,
  applyAppearance,
} from '../lib/theme.js';

/** What each option is for, in the user's terms rather than the code's. */
const BLURB = {
  auto: 'Follows the calendar on its own — Christmas in December, Halloween in October, and so on.',
  classic: 'The everyday look. Ivory and gold, no seasonal tint.',
  christmas: 'Deep green and cranberry, warm gold highlights.',
  halloween: 'Dusk purple and burnt orange, cooler metal.',
  valentines: 'Soft rose and blush.',
  spring: 'Fresh green and lilac.',
};

/** Which skin `auto` resolves to right now, so the label can say so. */
function automaticNow() {
  const previous = document.documentElement.dataset.skin;
  const resolved = applyAppearance('auto');
  applyAppearance(getAppearancePreference());
  if (previous !== undefined) document.documentElement.dataset.skin = previous;
  return resolved;
}

export async function render(mount) {
  const current = getAppearancePreference();
  const autoResolves = automaticNow();

  const swatches = APPEARANCE_OPTIONS.map(([key, label]) => {
    const isAuto = key === 'auto';
    const preview = h('span', {
      class: 'skin-swatch__preview',
      'data-skin-preview': isAuto ? autoResolves : key,
      'aria-hidden': 'true',
    });

    const button = h('button', {
      class: 'skin-swatch',
      type: 'button',
      'aria-pressed': String(key === current),
      onClick: () => {
        setAppearancePreference(key);
        applyAppearance(key);
        // Re-render so the pressed state and the "in use" note follow the
        // choice; the skin itself has already changed behind this screen.
        render(mount);
        toast(isAuto ? `Following the season — ${autoResolves} right now` : `${label} applied`);
      },
    },
      preview,
      h('span', { class: 'skin-swatch__label' }, label),
      h('span', { class: 'skin-swatch__blurb' }, BLURB[key] ?? ''),
      key === current ? h('span', { class: 'skin-swatch__check', 'aria-hidden': 'true' }, '✓') : null,
    );

    return button;
  });

  const picker = card('Appearance', current === 'auto' ? `automatic — ${autoResolves} today` : 'chosen by you',
    h('p', { class: 'muted' },
      'Seasonal skins change atmosphere, accents and motion only. Your schedule, Assistant, ' +
      'permissions and the Shia Baby engine are untouched.'),
    h('div', { class: 'skin-grid' }, ...swatches),
  );
  picker.classList.add('appearance-card');

  mount.replaceChildren(picker);
}
