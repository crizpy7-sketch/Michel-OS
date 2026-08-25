import type { DomainKey } from '../../lib/contracts/index.ts';

/**
 * THE MINI-APP REGISTRY — single source of truth.
 *
 * ASSET_MAP.md: "changing an icon requires only updating an asset path/data
 * record." That promise is kept here. The home grid, the navigation, the
 * "More" screen and every mini-app header all read this file; nothing else
 * anywhere in the app should contain a literal `/icons/...` string.
 *
 * When final artwork lands for one of the five pending icons, the entire
 * change is two fields on one record:
 *
 *     icon: '/icons/shopping.png',
 *     artStatus: 'approved',
 *
 * Nothing else moves, and the placeholder badge disappears on its own.
 *
 * Hard rule (ASSET_MAP.md): approved artwork is never replaced by emoji,
 * Lucide, generic stock icons or CSS recreations. `icon` always points at a
 * real PNG in `public/icons/`.
 */

/** Whether `icon` is final production artwork or a stand-in. */
export type ArtStatus = 'approved' | 'pending';

export const MINI_APP_IDS = [
  'appointments',
  'practice',
  'shia-baby',
  'school',
  'competition',
  'games',
  'errands',
  'hubby-work',
  'shopping',
  'reminders',
  'ai-assistant',
  'all-schedules',
  'inbox',
] as const;

export type MiniAppId = (typeof MINI_APP_IDS)[number];

/** Coarse grouping, used by the "More" screen and the desktop sidebar. */
export type MiniAppGroup = 'schedule' | 'household' | 'business' | 'system';

export interface MiniApp {
  id: MiniAppId;
  /** Full name. Used in headings, nav labels and `alt` text. */
  label: string;
  /** Short form for the 3-column phone grid, where 10 chars is the budget. */
  shortLabel: string;
  /** Route. Owned by the screen agents; this file owns the mapping. */
  href: string;
  /** Path under `public/`. The ONLY place a mini-app asset path is written. */
  icon: string;
  artStatus: ArtStatus;
  /**
   * CSS custom property name for this app's accent. Tint only — used behind
   * artwork and as a 2px rule. Never a text colour, never load-bearing:
   * every mini-app is also identified by its label and its artwork.
   */
  accentVar: string;
  /** Link into the frozen contract's domain union, where one exists. */
  domain: DomainKey | null;
  group: MiniAppGroup;
  /** One line, used in empty states, tooltips and the More list. */
  description: string;
}

const APPROVED = 'approved' satisfies ArtStatus;
const PENDING = 'pending' satisfies ArtStatus;

export const MINI_APPS: Record<MiniAppId, MiniApp> = {
  appointments: {
    id: 'appointments',
    label: 'Appointments',
    shortLabel: 'Appts',
    href: '/appointments',
    icon: '/icons/appointments.png',
    artStatus: APPROVED,
    accentVar: '--color-app-appointments',
    domain: 'appointments',
    group: 'schedule',
    description: 'Medical, dental, salon, reservations and meetings.',
  },
  practice: {
    id: 'practice',
    label: 'Practice',
    shortLabel: 'Practice',
    href: '/practice',
    icon: '/icons/practice.png',
    artStatus: APPROVED,
    accentVar: '--color-app-practice',
    domain: 'practice',
    group: 'schedule',
    description: 'Recurring sport and activity practice.',
  },
  'shia-baby': {
    id: 'shia-baby',
    label: 'Shia Baby',
    shortLabel: 'Shia Baby',
    href: '/business',
    icon: '/icons/shia-baby.png',
    artStatus: APPROVED,
    accentVar: '--color-app-shia-baby',
    domain: 'shia-baby',
    group: 'business',
    description: 'The boutique: staffing, inventory, sales and tax set-aside.',
  },
  school: {
    id: 'school',
    label: 'School',
    shortLabel: 'School',
    href: '/school',
    icon: '/icons/school.png',
    artStatus: APPROVED,
    accentVar: '--color-app-school',
    domain: 'school',
    group: 'schedule',
    description: 'Drop-off, pickup, holidays, testing and teacher meetings.',
  },
  competition: {
    id: 'competition',
    label: 'Competition',
    shortLabel: 'Comp',
    href: '/competition',
    icon: '/icons/competition.png',
    artStatus: APPROVED,
    accentVar: '--color-app-competition',
    domain: 'competition',
    group: 'schedule',
    description: 'Competition days: check-in, warm-up, performance, awards.',
  },
  games: {
    id: 'games',
    label: 'Games',
    shortLabel: 'Games',
    href: '/games',
    icon: '/icons/games.png',
    artStatus: APPROVED,
    accentVar: '--color-app-games',
    domain: 'games',
    group: 'schedule',
    description: 'Valley Cats game days, home and away.',
  },
  errands: {
    id: 'errands',
    label: 'Errands',
    shortLabel: 'Errands',
    href: '/errands',
    icon: '/icons/errands.png',
    artStatus: APPROVED,
    accentVar: '--color-app-errands',
    domain: 'errands',
    group: 'household',
    description: 'Things that need doing somewhere: returns, pharmacy, bank.',
  },
  'hubby-work': {
    id: 'hubby-work',
    label: 'Hubby Work',
    shortLabel: 'Work',
    href: '/hubby-work',
    icon: '/icons/hubby-work.png',
    artStatus: APPROVED,
    accentVar: '--color-app-hubby-work',
    domain: 'work',
    group: 'schedule',
    description: 'Jobsites, shifts, travel and scaffold design work.',
  },

  /* ---- pending final artwork (ASSET_MAP.md) ------------------------------
     These five render a real PNG placeholder and are visibly flagged by
     MiniAppIcon so they cannot be shipped as final by accident.           */
  shopping: {
    id: 'shopping',
    label: 'Shopping',
    shortLabel: 'Shopping',
    href: '/shopping',
    icon: '/icons/shopping.placeholder.png',
    artStatus: PENDING,
    accentVar: '--color-app-shopping',
    domain: 'shopping',
    group: 'household',
    description: 'Everything that needs buying, grouped by store.',
  },
  reminders: {
    id: 'reminders',
    label: 'Reminders',
    shortLabel: 'Remind',
    href: '/reminders',
    icon: '/icons/reminders.placeholder.png',
    artStatus: PENDING,
    accentVar: '--color-app-reminders',
    domain: 'reminders',
    group: 'household',
    description: 'Things to remember, snooze and tick off.',
  },
  'ai-assistant': {
    id: 'ai-assistant',
    label: 'AI Assistant',
    shortLabel: 'AI',
    href: '/ai',
    icon: '/icons/ai-assistant.placeholder.png',
    artStatus: PENDING,
    accentVar: '--color-app-ai-assistant',
    domain: null,
    group: 'system',
    description: 'Say it in plain words; the assistant files it correctly.',
  },
  'all-schedules': {
    id: 'all-schedules',
    label: 'All Schedules',
    shortLabel: 'All',
    href: '/schedules',
    icon: '/icons/all-schedules.placeholder.png',
    artStatus: PENDING,
    accentVar: '--color-app-all-schedules',
    domain: 'general',
    group: 'system',
    description: 'Every schedule in one place: today, week, month, agenda.',
  },
  inbox: {
    id: 'inbox',
    label: 'Inbox',
    shortLabel: 'Inbox',
    href: '/inbox',
    icon: '/icons/inbox.placeholder.png',
    artStatus: PENDING,
    accentVar: '--color-app-inbox',
    domain: 'inbox',
    group: 'system',
    description: 'Dump anything here; it gets classified and routed.',
  },
};

/** Home-grid order — PRODUCT_SPEC §2, top to bottom, left to right. */
export const MINI_APP_LIST: readonly MiniApp[] = MINI_APP_IDS.map((id) => MINI_APPS[id]);

export function getMiniApp(id: MiniAppId): MiniApp {
  return MINI_APPS[id];
}

/** Resolve by route — handy for a mini-app screen labelling its own header. */
export function getMiniAppByHref(href: string): MiniApp | undefined {
  return MINI_APP_LIST.find((app) => app.href === href);
}

export function miniAppsInGroup(group: MiniAppGroup): readonly MiniApp[] {
  return MINI_APP_LIST.filter((app) => app.group === group);
}

/**
 * The five that are still placeholders. A build-time check or a QA screen can
 * read this rather than eyeballing thirteen tiles.
 */
export const PENDING_ART: readonly MiniApp[] = MINI_APP_LIST.filter(
  (app) => app.artStatus === 'pending',
);
