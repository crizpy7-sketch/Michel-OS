/**
 * Static file serving, mostly about path traversal (Agent B3).
 *
 * `public/` sits next to directories that must never be served, and the URL
 * path is attacker-controlled. These tests spell the traversal several
 * different ways on purpose: the defence is "resolve, then check containment",
 * and the point of the list is to show that it does not depend on recognising
 * any particular spelling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAsset, cacheControlFor } from '../../server/http/static.ts';
import { call, startHarness } from './harness.ts';

const PUBLIC = new URL('../fixtures/public/', import.meta.url).pathname;

test('a file inside the root resolves', async () => {
  const asset = await resolveAsset(PUBLIC, '/app.css');
  assert.notEqual(asset, null);
  assert.equal(asset?.contentType, 'text/css; charset=utf-8');
});

test('traversal is refused however it is spelled', async () => {
  const attempts = [
    '/../secret/keys.txt',
    '/../../etc/passwd',
    '/%2e%2e/secret/keys.txt',
    '/%2e%2e%2fsecret%2fkeys.txt',
    '/..%2fsecret%2fkeys.txt',
    '/....//secret/keys.txt',
    '/a/../../secret/keys.txt',
    '/%252e%252e/secret/keys.txt',
    '/app.css/../../secret/keys.txt',
  ];
  for (const path of attempts) {
    assert.equal(await resolveAsset(PUBLIC, path), null, `${path} escaped the root`);
  }
});

test('a sibling directory whose name merely starts with the root is not inside it', async () => {
  // `/x/public-evil` starts with `/x/public`. Checking `startsWith` without a
  // separator would have let this through.
  assert.equal(await resolveAsset(PUBLIC.replace(/\/$/, ''), '-evil/anything'), null);
});

test('a malformed escape is refused rather than guessed at', async () => {
  assert.equal(await resolveAsset(PUBLIC, '/%zz'), null);
});

test('a NUL byte in the path is refused', async () => {
  assert.equal(await resolveAsset(PUBLIC, '/app.css%00.png'), null);
});

test('a directory is not a file', async () => {
  assert.equal(await resolveAsset(PUBLIC, '/assets'), null);
});

test('a missing file is null, not a throw', async () => {
  assert.equal(await resolveAsset(PUBLIC, '/nope.css'), null);
});

test('hashed assets are cached hard and everything else is not', () => {
  assert.match(cacheControlFor('/assets/app.a1b2c3.css'), /immutable/);
  assert.doesNotMatch(cacheControlFor('/manifest.webmanifest'), /immutable/);
});

/* ------------------------------------------------------------ over HTTP */

test('a static file is served with the security headers and an ETag', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/app.css`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('etag'));
  assert.match(await response.text(), /color/);
});

test('a matching If-None-Match gets 304 and no body', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const first = await fetch(`${h.base}/app.css`);
  const etag = first.headers.get('etag')!;
  await first.text();

  const second = await fetch(`${h.base}/app.css`, { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), '');
});

test('a traversal over HTTP does not reach a neighbouring directory', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  for (const path of ['/../secret/keys.txt', '/%2e%2e/secret/keys.txt']) {
    const response = await fetch(`${h.base}${path}`, { redirect: 'manual' });
    const body = await response.text();
    assert.ok(!body.includes('TOP SECRET'), `${path} served the secret`);
  }
});

test('a static path cannot shadow the API', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  // Even if someone drops an `api/health` file into public/, the endpoint wins:
  // static serving is skipped for /api/ entirely.
  const response = await call<{ ok: boolean }>(h, '/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('a POST to a static path is not served as a file', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/app.css`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.notEqual(response.status, 200);
});
