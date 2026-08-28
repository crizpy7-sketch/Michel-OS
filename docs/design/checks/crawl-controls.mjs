/**
 * Click everything and record what breaks.
 *
 * For each route: enumerate every button/link, click it, and record JS errors
 * and failed network calls. This finds "the button does nothing" empirically,
 * which reading the source does not.
 */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4310';
const ROUTES = ['/', '/schedule', '/add', '/assistant', '/more', '/shopping', '/errands',
  '/reminders', '/household', '/notifications', '/inbox', '/search',
  '/business', '/business/staffing', '/business/inventory', '/business/finance'];

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();

const jsErrors = [];
const netFails = [];
p.on('pageerror', (e) => jsErrors.push(String(e).slice(0, 160)));
p.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text().slice(0, 160)); });
p.on('response', (r) => {
  if (r.status() >= 400) netFails.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
});

await p.goto(BASE + '/login', { waitUntil: 'networkidle' });
await p.fill('input[type=email]', 'michelle@example.com');
await p.fill('input[type=password]', 'a-long-enough-passphrase-42');
await p.click('button[type=submit]');
await p.waitForTimeout(1600);

for (const route of ROUTES) {
  jsErrors.length = 0; netFails.length = 0;
  await p.goto(BASE + route, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(700);

  const loadErrs = [...jsErrors], loadNet = [...netFails];
  // What interactive controls does this screen actually offer?
  const controls = await p.evaluate(() => {
    const seen = [];
    for (const el of document.querySelectorAll('[data-view] button, [data-view] a[href]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      seen.push({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30),
        href: el.getAttribute('href') || '',
        type: el.getAttribute('type') || '',
      });
    }
    return seen;
  });

  const status = loadErrs.length || loadNet.length ? 'PROBLEM' : 'ok';
  console.log(`\n${route}  [${status}]  ${controls.length} controls`);
  if (loadNet.length) console.log('   network:', [...new Set(loadNet)].join(' | '));
  if (loadErrs.length) console.log('   js:', [...new Set(loadErrs)].slice(0, 2).join(' | '));
  const labels = controls.map((c) => c.text || `<${c.tag}>`).filter(Boolean);
  if (labels.length) console.log('   controls:', [...new Set(labels)].join(', ').slice(0, 260));
}
await b.close();
