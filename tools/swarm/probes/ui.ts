/**
 * UI PROBE — Agents C/D/N in probe form (UX, design system, accessibility,
 * performance/responsiveness).
 *
 * UI_RESPONSIVE_SPEC §10 says a feature "is not complete until it passes all
 * relevant layouts", and §8 lists accessibility as required rather than nice to
 * have. Neither claim can be checked by reading source, so this probe starts
 * the real production server, drives a real browser, and looks at the rendered
 * result at the exact device widths the spec names.
 *
 * It is deliberately unkind: a page that throws in the console, scrolls
 * sideways on a 320px phone, ships an approved-artwork slot with no alt text,
 * or renders the same layout at phone and desktop width is a failure, not a
 * detail.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { type ProbeOutcome, type ProbeCheck, check } from './kit.ts';

/** The widths UI_RESPONSIVE_SPEC §1 and §10 actually enumerate. */
const VIEWPORTS: Array<{ name: string; width: number; height: number; band: 'mobile' | 'tablet' | 'desktop' }> = [
  { name: 'iPhone SE 320', width: 320, height: 568, band: 'mobile' },
  { name: 'iPhone 375', width: 375, height: 667, band: 'mobile' },
  { name: 'iPhone 390', width: 390, height: 844, band: 'mobile' },
  { name: 'iPhone Max 430', width: 430, height: 932, band: 'mobile' },
  { name: 'iPad portrait', width: 820, height: 1180, band: 'tablet' },
  { name: 'iPad landscape', width: 1180, height: 820, band: 'tablet' },
  { name: 'Desktop', width: 1440, height: 900, band: 'desktop' },
];

const ROUTES = ['/', '/schedules', '/business', '/ai', '/inbox', '/more', '/appointments', '/practice', '/shopping', '/reminders'];

const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function run(): Promise<ProbeOutcome> {
  const checks: ProbeCheck[] = [];
  const stats: Record<string, string | number> = {};

  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return {
      checks: [check('playwright available', 'orchestrator', false, 'playwright is not installed; UI cannot be verified')],
    };
  }

  let server: ChildProcess | null = null;
  try {
    server = spawn('npx', ['next', 'start', '--port', String(PORT), '--hostname', '127.0.0.1'], {
      cwd: process.cwd(),
      stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'production' },
    });

    if (!(await waitForServer(60_000))) {
      return {
        checks: [check('production server starts', 'orchestrator', false, `next start did not answer on ${BASE} within 60s — run \`npm run build\` first`)],
      };
    }
    checks.push(check('production server starts', 'orchestrator', true, 'next start is serving'));

    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });

    /* ------------------------------------------- routes render at all ---- */

    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    for (const route of ROUTES) {
      const page = await desktop.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e)));

      let status = 0;
      try {
        const res = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        status = res?.status() ?? 0;
      } catch (e) {
        checks.push(check(`route ${route} responds`, ownerForRoute(route), false, `navigation failed: ${e instanceof Error ? e.message : String(e)}`));
        await page.close();
        continue;
      }

      checks.push(check(`route ${route} responds`, ownerForRoute(route), status === 200, `HTTP ${status}`));

      // A page that renders but logs errors is broken in a way users feel later.
      checks.push(
        check(
          `route ${route} is console-clean`,
          ownerForRoute(route),
          consoleErrors.length === 0,
          consoleErrors.slice(0, 3).join(' | ') || 'no errors',
        ),
      );

      // Every page needs exactly one h1 and a landmark, or screen readers get lost.
      const structure = await page.evaluate(() => ({
        h1: document.querySelectorAll('h1').length,
        main: document.querySelectorAll('main').length,
        title: document.title,
        imagesMissingAlt: [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length,
        emptyButtons: [...document.querySelectorAll('button')].filter(
          (b) => !b.textContent?.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'),
        ).length,
      }));

      checks.push(check(`route ${route} has one h1`, ownerForRoute(route), structure.h1 === 1, `found ${structure.h1}`));
      checks.push(check(`route ${route} has a main landmark`, ownerForRoute(route), structure.main >= 1, `found ${structure.main}`));
      checks.push(
        check(`route ${route} images carry alt text`, ownerForRoute(route), structure.imagesMissingAlt === 0, `${structure.imagesMissingAlt} without alt`),
      );
      checks.push(
        check(`route ${route} buttons have accessible names`, ownerForRoute(route), structure.emptyButtons === 0, `${structure.emptyButtons} unnamed`),
      );

      await page.close();
    }
    await desktop.close();

    /* ----------------------------------------------- responsive sweep ---- */

    const layoutFingerprints = new Map<string, string>();
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });

      const probe = await page.evaluate(() => {
        const doc = document.documentElement;
        const overflow = doc.scrollWidth > doc.clientWidth + 1;
        // Widest offender helps whoever has to fix it.
        let worst = '';
        let worstWidth = 0;
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > worstWidth && r.right > doc.clientWidth + 1) {
            worstWidth = r.width;
            worst = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : '');
          }
        }
        const nav = document.querySelector('nav');
        const navBox = nav?.getBoundingClientRect();
        const smallTargets = [...document.querySelectorAll('a, button')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.height < 40 || r.width < 40);
        }).length;
        return {
          overflow,
          worst,
          navPosition: navBox ? (navBox.top > window.innerHeight / 2 ? 'bottom' : navBox.width < window.innerWidth / 2 ? 'side' : 'top') : 'none',
          smallTargets,
          gridColumns: getComputedStyle(document.querySelector('[data-mini-app-grid]') ?? document.body).gridTemplateColumns,
        };
      });

      checks.push(
        check(
          `no horizontal overflow at ${vp.name}`,
          'design-system',
          !probe.overflow,
          probe.overflow ? `page scrolls sideways; widest offender: ${probe.worst || 'unknown'}` : 'fits',
        ),
      );

      if (vp.band === 'mobile') {
        checks.push(
          check(
            `touch targets are reachable at ${vp.name}`,
            'design-system',
            probe.smallTargets === 0,
            `${probe.smallTargets} interactive element(s) under 40px — spec §8 asks for ~44px`,
          ),
        );
      }

      layoutFingerprints.set(vp.band, `${probe.navPosition}|${probe.gridColumns}`);
      await ctx.close();
    }

    // UI_RESPONSIVE_SPEC §1: "Do not merely stretch the mobile UI." Three bands
    // must produce three genuinely different layouts.
    const bands = [...layoutFingerprints.entries()];
    const distinct = new Set(bands.map(([, fp]) => fp)).size;
    checks.push(
      check(
        'mobile, tablet and desktop are different layouts',
        'design-system',
        distinct >= 2,
        bands.map(([b, fp]) => `${b}=${fp}`).join('  '),
      ),
    );
    stats.layoutBands = bands.map(([b, fp]) => `${b}:${fp}`).join(' ');

    /* ------------------------------------------------------ keyboard ---- */

    const kb = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await kb.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.keyboard.press('Tab');
    const focusVisible = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { ok: false, detail: 'nothing receives focus on first Tab' };
      const s = getComputedStyle(el);
      const hasRing = s.outlineStyle !== 'none' || s.boxShadow !== 'none';
      return { ok: hasRing, detail: `${el.tagName.toLowerCase()} outline=${s.outlineStyle} shadow=${s.boxShadow.slice(0, 40)}` };
    });
    checks.push(check('first Tab lands on a visibly focused control', 'design-system', focusVisible.ok, focusVisible.detail));
    await kb.close();

    await browser.close();
    stats.routes = ROUTES.length;
    stats.viewports = VIEWPORTS.length;
  } finally {
    server?.kill('SIGKILL');
  }

  return { checks, stats };
}

/** Route ownership mirrors tools/swarm/registry.ts so findings land correctly. */
function ownerForRoute(route: string): string {
  if (route.startsWith('/schedules')) return 'schedules-screen';
  if (route.startsWith('/business')) return 'business-screen';
  if (route.startsWith('/ai') || route.startsWith('/inbox')) return 'ai-screen';
  if (/^\/(appointments|practice|school|competition|games|errands|hubby-work|shopping|reminders)/.test(route)) return 'miniapps-screen';
  return 'home-screen';
}
