/**
 * The mini-app catalogue (Agent L).
 *
 * ASSET_MAP.md asks for "a reusable MiniAppIcon component so changing an icon
 * requires only updating an asset path/data record". This is that data record —
 * one table, thirteen rows, and every screen that shows a mini-app reads from
 * it. Swapping the artwork for `shopping` when the final piece is approved is a
 * change to `public/icons/shopping.png` and a re-run of the icon script; no
 * code moves.
 *
 * `domain` is the key the API uses (`DomainKey` in the frozen contracts), and
 * `route` is where tapping the tile goes. They differ for the four tiles that
 * are not calendars — Shia Baby, the assistant, all-schedules and inbox open
 * their own screens rather than a filtered event list.
 */

export const MINI_APPS = [
  { key: 'appointments',  label: 'Appointments', domain: 'appointments', route: '/app/appointments' },
  { key: 'practice',      label: 'Practice',     domain: 'practice',     route: '/app/practice' },
  { key: 'shia-baby',     label: 'Shia Baby',    domain: 'shia-baby',    route: '/business',
    needs: 'business.read' },
  { key: 'school',        label: 'School',       domain: 'school',       route: '/app/school' },
  { key: 'competition',   label: 'Competition',  domain: 'competition',  route: '/app/competition' },
  { key: 'games',         label: 'Games',        domain: 'games',        route: '/app/games' },
  { key: 'errands',       label: 'Errands',      domain: 'errands',      route: '/errands' },
  { key: 'hubby-work',    label: 'Hubby Work',   domain: 'work',         route: '/app/work' },
  { key: 'shopping',      label: 'Shopping',     domain: 'shopping',     route: '/shopping' },
  { key: 'reminders',     label: 'Reminders',    domain: 'reminders',    route: '/reminders' },
  { key: 'ai-assistant',  label: 'AI Assistant', domain: null,           route: '/assistant' },
  { key: 'all-schedules', label: 'All Schedules', domain: null,          route: '/schedule' },
  { key: 'inbox',         label: 'Inbox',        domain: 'inbox',        route: '/inbox' },
];

/** The mini-app a `DomainKey` belongs to, for labelling an event in a list. */
export function forDomain(domain) {
  return MINI_APPS.find((app) => app.domain === domain) ?? null;
}

export function byKey(key) {
  return MINI_APPS.find((app) => app.key === key || app.domain === key) ?? null;
}
