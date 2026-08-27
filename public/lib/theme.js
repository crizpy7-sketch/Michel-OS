/**
 * Michel OS appearance layer.
 *
 * This module is deliberately presentation-only. It writes data attributes on
 * <html>; it never touches API state, schedules, permissions, recurrence, or
 * business data. CSS owns the actual visual treatment.
 */

const STORAGE_KEY = 'michel-os.appearance';

export const APPEARANCE_OPTIONS = Object.freeze([
  ['auto', 'Automatic seasonal'],
  ['classic', 'Always classic'],
  ['christmas', 'Christmas'],
  ['halloween', 'Halloween'],
  ['valentines', "Valentine's"],
  ['spring', 'Spring / Easter'],
]);

export function getAppearancePreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY) ?? 'auto';
    return APPEARANCE_OPTIONS.some(([key]) => key === value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function setAppearancePreference(value) {
  const safe = APPEARANCE_OPTIONS.some(([key]) => key === value) ? value : 'auto';
  try { localStorage.setItem(STORAGE_KEY, safe); } catch {}
  applyAppearance(safe);
}

export function applyAppearance(preference = getAppearancePreference(), now = new Date()) {
  const skin = preference === 'auto' ? automaticSkin(now) : preference;
  document.documentElement.dataset.appearance = preference;
  document.documentElement.dataset.skin = skin;
  syncThemeColor();
  return skin;
}

/**
 * Point the browser/PWA chrome at whatever the skin just painted the canvas.
 *
 * `theme-color` was a fixed `#f7f1e8` in the document head, so on a phone the
 * status bar stayed classic ivory in December — a seam right at the top of the
 * screen, and the most visible part of the skin on an installed app.
 *
 * The value is read back off the canvas rather than kept in a second table
 * here, so a skin can never drift from its own status bar.
 */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta === null) return;
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--midnight').trim();
  if (canvas.length > 0) meta.setAttribute('content', canvas);
}

function automaticSkin(now) {
  const month = now.getMonth() + 1;
  const day = now.getDate();

  if (month === 12) return 'christmas';
  if (month === 10) return 'halloween';
  if (month === 2 && day <= 14) return 'valentines';
  if ((month === 3 && day >= 15) || month === 4) return 'spring';
  return 'classic';
}
