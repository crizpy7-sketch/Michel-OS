/**
 * HTTP core tests (Agent B3).
 *
 * The router and the cookie parser get ordinary coverage. CSRF and the body
 * limit get adversarial coverage, because those two are the difference between
 * a family calendar and a family calendar that any web page can post to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import {
  BodyTooLarge, MAX_BODY_BYTES, Router, checkCsrf, dispatch, json, parseCookies,
  problem, readBody, securityHeaders, serialiseCookie, type RequestContext,
} from '../../server/http/core.ts';

/* ------------------------------------------------------------- helpers */

function fakeRequest(options: {
  method?: string; url?: string; headers?: Record<string, string>; body?: string;
} = {}): IncomingMessage {
  const stream = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
  const req = stream as unknown as IncomingMessage;
  req.method = options.method ?? 'GET';
  req.url = options.url ?? '/';
  req.headers = { host: 'michel.example', ...(options.headers ?? {}) };
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '203.0.113.9' }, configurable: true });
  return req;
}

function ctxFor(headers: Record<string, string>, method = 'POST'): RequestContext {
  return {
    method: method as RequestContext['method'],
    url: new URL('https://michel.example/x'),
    params: {}, query: new URLSearchParams(), headers, cookies: {}, body: null,
    raw: fakeRequest(), ip: '203.0.113.9',
  };
}

const ORIGINS = ['https://michel.example'];

/* -------------------------------------------------------------- router */

test('the router matches literal paths and captures parameters', () => {
  const router = new Router();
  router.get('/events/:id', () => json(200, { ok: true }));
  router.get('/events/:id/edit', () => json(200, { ok: true }));

  const one = router.match('GET', '/events/abc');
  assert.ok(one !== null && 'handler' in one);
  assert.deepEqual(one.params, { id: 'abc' });

  const two = router.match('GET', '/events/abc/edit');
  assert.ok(two !== null && 'handler' in two);
  assert.deepEqual(two.params, { id: 'abc' });

  assert.equal(router.match('GET', '/events'), null);
  assert.equal(router.match('GET', '/events/abc/edit/extra'), null);
});

test('an empty path segment does not satisfy a parameter', () => {
  const router = new Router();
  router.get('/events/:id/edit', () => json(200, {}));
  assert.equal(
    router.match('GET', '/events//edit'),
    null,
    'an empty id would reach the database as an empty string',
  );
});

test('a known path under the wrong method is 405, not 404', () => {
  const router = new Router();
  router.get('/session', () => json(200, {}));
  router.delete('/session', () => json(200, {}));

  const result = router.match('POST', '/session');
  assert.ok(result !== null && 'methodNotAllowed' in result);
  assert.deepEqual(result.allowed.sort(), ['DELETE', 'GET']);
});

test('HEAD is served by the GET handler', () => {
  const router = new Router();
  router.get('/health', () => json(200, { ok: true }));
  const result = router.match('HEAD', '/health');
  assert.ok(result !== null && 'handler' in result);
});

test('a wildcard captures the rest of the path and is safe to register last', () => {
  const router = new Router();
  router.get('/assets/app.css', () => json(200, { specific: true }));
  router.get('/assets/*', () => json(200, { wildcard: true }));

  const specific = router.match('GET', '/assets/app.css');
  assert.ok(specific !== null && 'handler' in specific);
  assert.deepEqual(specific.params, {}, 'the earlier, more specific route wins');

  const wild = router.match('GET', '/assets/icons/deep/file.png');
  assert.ok(wild !== null && 'handler' in wild);
  assert.equal(wild.params['rest'], 'icons/deep/file.png');
});

test('percent-encoded parameters are decoded once', () => {
  const router = new Router();
  router.get('/q/:term', () => json(200, {}));
  const result = router.match('GET', '/q/soccer%20practice');
  assert.ok(result !== null && 'handler' in result);
  assert.equal(result.params['term'], 'soccer practice');
});

/* ------------------------------------------------------------- cookies */

test('cookies parse, including encoded values, and malformed ones do not throw', () => {
  assert.deepEqual(parseCookies('a=1; b=two'), { a: '1', b: 'two' });
  assert.deepEqual(parseCookies('session=abc%2Edef'), { session: 'abc.def' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('=novalue; ; junk'), {});
  // A value containing a stray percent is data, not a crash.
  assert.deepEqual(parseCookies('x=100%'), { x: '100%' });
});

test('session cookies are HttpOnly, Secure and SameSite by default', () => {
  const serialised = serialiseCookie({ name: 'michel_session', value: 'abc.def' });
  assert.match(serialised, /^michel_session=abc\.def/);
  assert.match(serialised, /HttpOnly/, 'script must not be able to read the session');
  assert.match(serialised, /Secure/);
  assert.match(serialised, /SameSite=Lax/);
  assert.match(serialised, /Path=\//);
});

test('a cookie value is encoded so it cannot inject attributes', () => {
  const serialised = serialiseCookie({ name: 'x', value: 'a; Domain=evil.example' });
  assert.equal(serialised.includes('Domain=evil.example'), false);
});

/* ---------------------------------------------------------------- body */

test('a JSON body parses; a non-object JSON body is rejected as unusable', async () => {
  assert.deepEqual(
    await readBody(fakeRequest({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title":"Soccer"}',
    })),
    { title: 'Soccer' },
  );

  for (const body of ['[1,2,3]', '"just a string"', '42', 'null', 'not json at all']) {
    assert.equal(
      await readBody(fakeRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body })),
      null,
      `should not have accepted ${body}`,
    );
  }
});

test('a form body parses, and repeated fields stay arrays', async () => {
  const parsed = await readBody(fakeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'title=Soccer&member=a&member=b',
  }));
  assert.equal(parsed?.['title'], 'Soccer');
  assert.deepEqual(parsed?.['member'], ['a', 'b'], 'a multi-select must not collapse to one value');
});

test('an unknown content type is ignored rather than guessed at', async () => {
  assert.equal(
    await readBody(fakeRequest({
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'title=Soccer',
    })),
    null,
  );
});

test('an oversized body is refused while it is still arriving', async () => {
  const req = fakeRequest({ method: 'POST', headers: { 'content-type': 'application/json' } });
  // A stream that would produce far more than the limit if fully buffered.
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let emitted = 0;
  const flood = Readable.from((function* () {
    for (let i = 0; i < 200; i += 1) {
      emitted += chunk.length;
      yield chunk;
    }
  })());
  Object.assign(flood, { headers: req.headers, method: 'POST', url: '/' });

  await assert.rejects(
    readBody(flood as unknown as IncomingMessage),
    (error: unknown) => error instanceof BodyTooLarge,
  );
  assert.ok(
    emitted < 200 * chunk.length,
    'the stream should have been abandoned partway, not read to the end first',
  );
  assert.ok(emitted <= MAX_BODY_BYTES + chunk.length);
});

/* ---------------------------------------------------------------- CSRF */

test('safe methods are never blocked', () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal(checkCsrf(ctxFor({}, method), ORIGINS).ok, true);
  }
});

test('Sec-Fetch-Site decides when the browser sends it', () => {
  assert.equal(checkCsrf(ctxFor({ 'sec-fetch-site': 'same-origin' }), ORIGINS).ok, true);
  assert.equal(checkCsrf(ctxFor({ 'sec-fetch-site': 'none' }), ORIGINS).ok, true, 'typed in the address bar');
  assert.equal(checkCsrf(ctxFor({ 'sec-fetch-site': 'cross-site' }), ORIGINS).ok, false);
  assert.equal(checkCsrf(ctxFor({ 'sec-fetch-site': 'same-site' }), ORIGINS).ok, false, 'a sibling subdomain is not us');
});

test('a cross-origin POST is refused even when it claims a friendly origin header', () => {
  assert.equal(checkCsrf(ctxFor({ origin: 'https://michel.example' }), ORIGINS).ok, true);
  assert.equal(checkCsrf(ctxFor({ origin: 'https://evil.example' }), ORIGINS).ok, false);
  assert.equal(
    checkCsrf(ctxFor({ origin: 'https://michel.example.evil.example' }), ORIGINS).ok,
    false,
    'a suffix match would be a trivial bypass',
  );
});

test('Sec-Fetch-Site wins over a forged Origin', () => {
  const decision = checkCsrf(
    ctxFor({ 'sec-fetch-site': 'cross-site', origin: 'https://michel.example' }),
    ORIGINS,
  );
  assert.equal(decision.ok, false, 'the browser-set header is the trustworthy one');
});

test('a state-changing request with no provenance headers at all is refused', () => {
  const decision = checkCsrf(ctxFor({}), ORIGINS);
  assert.equal(decision.ok, false);
  assert.match(String(decision.reason), /no Origin, Referer or Sec-Fetch-Site/);
});

test('referer is used only as a last resort, and only its origin', () => {
  assert.equal(checkCsrf(ctxFor({ referer: 'https://michel.example/events/123' }), ORIGINS).ok, true);
  assert.equal(checkCsrf(ctxFor({ referer: 'https://evil.example/page' }), ORIGINS).ok, false);
  assert.equal(checkCsrf(ctxFor({ referer: 'not a url' }), ORIGINS).ok, false);
});

/* ---------------------------------------------------- security headers */

test('the CSP forbids inline script and framing outright', () => {
  const headers = securityHeaders({ https: true });
  const csp = headers['content-security-policy']!;
  assert.match(csp, /script-src 'self'/);
  assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false, 'inline script is where injection pays off');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/, 'an injected form must not be able to post the session away');
  assert.match(csp, /base-uri 'none'/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.match(String(headers['strict-transport-security']), /max-age=31536000/);
});

test('HSTS is omitted when not serving over https, so local development still works', () => {
  assert.equal(Object.hasOwn(securityHeaders({ https: false }), 'strict-transport-security'), false);
});

/* ------------------------------------------------------------ dispatch */

test('dispatch routes, parses and returns the handler reply', async () => {
  const router = new Router();
  router.post('/events/:id', async (ctx) => json(200, { id: ctx.params['id'], body: ctx.body }));

  const reply = await dispatch(
    fakeRequest({
      method: 'POST', url: '/events/abc',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: '{"title":"Soccer"}',
    }),
    { router, allowedOrigins: ORIGINS, https: true },
  );

  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(String(reply.body)), { id: 'abc', body: { title: 'Soccer' } });
});

test('dispatch refuses a cross-site POST before the handler runs', async () => {
  let reached = false;
  const router = new Router();
  router.post('/events', async () => {
    reached = true;
    return json(200, {});
  });

  const reply = await dispatch(
    fakeRequest({
      method: 'POST', url: '/events',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    }),
    { router, allowedOrigins: ORIGINS, https: true },
  );

  assert.equal(reply.status, 403);
  assert.equal(reached, false, 'the handler must never see a cross-site request');
});

test('an unhandled throw becomes an opaque 500 that leaks nothing', async () => {
  const router = new Router();
  router.get('/boom', () => {
    throw new Error('connection string postgres://user:hunter2@db/michel failed');
  });

  const reply = await dispatch(
    fakeRequest({ url: '/boom' }),
    { router, allowedOrigins: ORIGINS, https: true },
  );

  assert.equal(reply.status, 500);
  const body = String(reply.body);
  assert.equal(body.includes('hunter2'), false, 'an error body must not carry internals');
  assert.equal(body.includes('postgres://'), false);
  assert.match(body, /internal/);
});

test('an oversized body is a 413 rather than a crash', async () => {
  const router = new Router();
  router.post('/events', async () => json(200, {}));

  const reply = await dispatch(
    fakeRequest({
      method: 'POST', url: '/events',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: 'x'.repeat(MAX_BODY_BYTES + 10),
    }),
    { router, allowedOrigins: ORIGINS, https: true },
  );
  assert.equal(reply.status, 413);
});

test('an unknown path is 404 and a wrong method is 405 with an Allow header', async () => {
  const router = new Router();
  router.get('/health', () => json(200, {}));

  const missing = await dispatch(fakeRequest({ url: '/nope' }), {
    router, allowedOrigins: ORIGINS, https: true,
  });
  assert.equal(missing.status, 404);

  const wrong = await dispatch(
    fakeRequest({ method: 'DELETE', url: '/health', headers: { 'sec-fetch-site': 'same-origin' } }),
    { router, allowedOrigins: ORIGINS, https: true },
  );
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers?.['allow'], 'GET');
});

test('problem replies carry a machine code and a human sentence, and nothing else', () => {
  const reply = problem(403, 'csrf', 'This request did not come from Michel-OS.');
  const parsed = JSON.parse(String(reply.body)) as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(parsed), ['error']);
  assert.deepEqual(Object.keys(parsed.error).sort(), ['code', 'message']);
});
