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
 * change is ONE field on ONE record: flip `artStatus` to `'approved'`. The
 * `icon` path is derived from the id and the status by `iconPath()` below, so
 * `shopping` automatically stops pointing at its `.placeholder.png` and
 * starts pointing at the production file. The placeholder badge disappears on
 * its own. There is no second edit to forget, and no path to mistype.
 *
 * `ICON_MANIFEST` + `assertMiniAppArtIntegrity()` make a wrong path a loud
 * build failure instead of a silent 404 on a broken image.
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

/**
 * The literal contents of `public/icons/`, checked in beside the registry.
 *
 * This is the guard. A mistyped or stale `icon` path used to fail as a silent
 * 404 rendering a broken image; now it fails `assertMiniAppArtIntegrity()`,
 * which runs at module load and therefore at `next build`. Add a file to
 * `public/icons/`, add its name here.
 */
export const ICON_MANIFEST: readonly string[] = [
  'appointments.png',
  'practice.png',
  'shia-baby.png',
  'school.png',
  'competition.png',
  'games.png',
  'errands.png',
  'hubby-work.png',
  'shopping.placeholder.png',
  'reminders.placeholder.png',
  'ai-assistant.placeholder.png',
  'all-schedules.placeholder.png',
  'inbox.placeholder.png',
];

/**
 * The one place a mini-app asset path is constructed.
 *
 * Approved art is `/icons/<id>.png`; pending art is `/icons/<id>.placeholder.png`.
 * Because the path is a function of (id, artStatus), flipping `artStatus` is
 * the whole swap — exactly the one-record change ASSET_MAP.md promises.
 */
export function iconPath(id: MiniAppId, status: ArtStatus): string {
  return status === 'approved' ? `/icons/${id}.png` : `/icons/${id}.placeholder.png`;
}

export const MINI_APPS: Record<MiniAppId, MiniApp> = {
  appointments: {
    id: 'appointments',
    label: 'Appointments',
    shortLabel: 'Appts',
    href: '/appointments',
    icon: iconPath('appointments', APPROVED),
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
    icon: iconPath('practice', APPROVED),
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
    icon: iconPath('shia-baby', APPROVED),
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
    icon: iconPath('school', APPROVED),
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
    icon: iconPath('competition', APPROVED),
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
    icon: iconPath('games', APPROVED),
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
    icon: iconPath('errands', APPROVED),
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
    icon: iconPath('hubby-work', APPROVED),
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
    icon: iconPath('shopping', PENDING),
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
    icon: iconPath('reminders', PENDING),
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
    icon: iconPath('ai-assistant', PENDING),
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
    icon: iconPath('all-schedules', PENDING),
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
    icon: iconPath('inbox', PENDING),
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

/**
 * Fails loudly if the registry and `public/icons/` have drifted apart.
 *
 * Runs once at module load — which means it runs during `next build`, so a
 * bad path is a red build rather than a broken image somebody notices in QA
 * three days later. It is a pure check over thirteen records; the cost is nil.
 */
export function assertMiniAppArtIntegrity(): void {
  const problems: string[] = [];
  const manifest = new Set(ICON_MANIFEST);

  for (const id of MINI_APP_IDS) {
    const app = MINI_APPS[id];

    if (app.id !== id) {
      problems.push(`${id}: record id is "${app.id}"`);
    }
    const expected = iconPath(app.id, app.artStatus);
    if (app.icon !== expected) {
      problems.push(`${id}: icon is "${app.icon}", expected "${expected}"`);
    }
    const file = app.icon.replace('/icons/', '');
    if (!manifest.has(file)) {
      problems.push(`${id}: "${file}" is not in public/icons/ (ICON_MANIFEST)`);
    }
    if (app.artStatus === 'pending' && !file.endsWith('.placeholder.png')) {
      problems.push(`${id}: marked pending but does not point at a .placeholder.png`);
    }
    if (app.artStatus === 'approved' && file.includes('.placeholder.')) {
      problems.push(`${id}: marked approved but still points at a placeholder`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Mini-app artwork registry is inconsistent with public/icons/:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

assertMiniAppArtIntegrity();
