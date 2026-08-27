/**
 * Does the app pick up the other person's change when it comes back to the
 * foreground — and does it leave half-typed forms alone?
 *
 * Headless Chromium never actually backgrounds a page (`visibilityState` stays
 * "visible" and no visibilitychange/focus/blur ever fires), so the state is
 * overridden in-page and the event dispatched by hand. That exercises the real
 * guard chain in `refreshIfStale`; the browser firing the event in the first
 * place is standard platform behaviour.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4310';
// Unique per run: a leftover event from an earlier run would make the
// "did it refresh?" assertions pass for the wrong reason.
const TITLE = `Away-add ${Date.now().toString(36)}`;

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const wife = await ctx.newPage();
const errs = [];
wife.on('pageerror', (e) => errs.push(String(e)));

async function goAway(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
}
async function comeBack(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
}

await wife.goto(BASE + '/login', { waitUntil: 'networkidle' });
await wife.fill('input[type=email]', 'michelle@example.com');
await wife.fill('input[type=password]', 'a-long-enough-passphrase-42');
await wife.click('button[type=submit]');
await wife.waitForTimeout(1600);
await wife.goto(BASE + '/', { waitUntil: 'networkidle' });
await wife.waitForTimeout(900);

const onScreen = () => wife.evaluate(() => document.body.innerText);

/* The second person, created fresh: the dev server starts an empty database
   each run, so this cannot lean on an account an earlier script made. */
const base = { 'content-type': 'application/json', origin: BASE, 'sec-fetch-site': 'same-origin' };
const cookieOf = (r) => /michel_session=([^;]*)/.exec(r.headers.get('set-cookie') ?? '')?.[1];

const herLogin = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: base,
  body: JSON.stringify({ email: 'michelle@example.com', password: 'a-long-enough-passphrase-42' }),
});
const herHdrs = { ...base, cookie: `michel_session=${cookieOf(herLogin)}` };
const herMe = await (await fetch(BASE + '/api/me', { headers: herHdrs })).json();
const hh = herMe.households[0].household.id;

const email = `partner-${Date.now().toString(36)}@example.com`;
const inv = await (await fetch(`${BASE}/api/households/${hh}/invitations`, {
  method: 'POST', headers: herHdrs, body: JSON.stringify({ email, role: 'adult' }),
})).json();
const reg = await fetch(BASE + '/api/auth/register', {
  method: 'POST', headers: base,
  body: JSON.stringify({ email, password: 'a-different-long-passphrase-99', displayName: 'Partner', joinToken: inv.token ?? inv.invitation?.token }),
});
console.log('second account joins household   ', reg.status === 201 ? 'OK' : 'FAILED ' + reg.status);
const hdrs = { ...base, cookie: `michel_session=${cookieOf(reg)}` };
const add = await fetch(`${BASE}/api/households/${hh}/events`, {
  method: 'POST', headers: hdrs,
  body: JSON.stringify({ title: TITLE, domain: 'appointments', startsAt: '2026-08-27T20:00:00.000Z', endsAt: '2026-08-27T21:00:00.000Z' }),
});
console.log('husband adds an event            ', add.status === 201 ? 'OK' : 'FAILED ' + add.status);
console.log('her screen shows it yet?         ', (await onScreen()).includes(TITLE) ? 'yes' : 'no (correct — nothing is pushed)');

/* 1. a quick glance away must NOT reload */
await goAway(wife); await wife.waitForTimeout(1500); await comeBack(wife);
await wife.waitForTimeout(1500);
console.log('1. back after ~1.5s              ',
  (await onScreen()).includes(TITLE) ? 'REFRESHED — too eager' : 'left alone (correct)');

/* 2. away long enough SHOULD reload */
await goAway(wife); await wife.waitForTimeout(31_000); await comeBack(wife);
await wife.waitForTimeout(2500);
const refreshed = (await onScreen()).includes(TITLE);
console.log('2. back after ~31s               ', refreshed ? 'REFRESHED — his event appeared on its own' : 'STILL STALE — broken');

/* 3. typing must survive the return */
await wife.goto(BASE + '/add', { waitUntil: 'networkidle' });
await wife.waitForTimeout(900);
await wife.fill('input[name="title"]', 'Half-typed dentist appointment');
await goAway(wife); await wife.waitForTimeout(31_000); await comeBack(wife);
await wife.waitForTimeout(2500);
const typed = await wife.inputValue('input[name="title"]').catch(() => '(field gone)');
console.log('3. typing survives a long return ',
  typed === 'Half-typed dentist appointment' ? 'kept (correct)' : `LOST — got "${typed}"`);

/* 4. offline must not reload into an error */
await wife.goto(BASE + '/', { waitUntil: 'networkidle' });
await wife.waitForTimeout(900);
await ctx.setOffline(true);
await goAway(wife); await wife.waitForTimeout(31_000); await comeBack(wife);
await wife.waitForTimeout(1800);
const offlineText = await onScreen();
console.log('4. offline return                ',
  /did not load|No connection/i.test(offlineText) ? 'REPLACED SCREEN WITH ERROR — bad' : 'left alone (correct)');
await ctx.setOffline(false);

console.log('page errors                      ', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
