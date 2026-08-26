/**
 * HTTP primitives (Agent B3 — Web tier).
 *
 * A router, cookie handling, body parsing, security headers and CSRF, on
 * `node:http` with no framework. ADR-001 chose a dependency-free runtime; a
 * router is a hundred lines and an Express-shaped dependency tree is not worth
 * that trade for a family calendar.
 *
 * The two things here that are load-bearing rather than plumbing:
 *
 *   **CSRF.** Auth is cookie-based, so a form on another site could otherwise
 *   post to this one with the family's cookie attached. Defence is layered:
 *   `SameSite=Lax` stops the browser sending the cookie on cross-site POSTs at
 *   all; `Origin`/`Sec-Fetch-Site` are checked server-side for every unsafe
 *   method; and neither is trusted alone, because SameSite has gaps in older
 *   browsers and `Origin` can be absent.
 *
 *   **Body limits.** An unbounded request body is a free denial of service. The
 *   limit is enforced while reading, not after, so an attacker cannot make the
 *   process buffer a gigabyte before being told no.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/* ------------------------------------------------------------------ types */

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Methods that may change state, and therefore need CSRF defence. */
const UNSAFE: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestContext {
  method: Method;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  cookies: Record<string, string>;
  /** Parsed body: JSON object, form fields, or null. */
  body: Record<string, unknown> | null;
  raw: IncomingMessage;
  /** Best-effort client address, honouring one trusted proxy hop. */
  ip: string;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  cookies?: SetCookie[];
}

export interface SetCookie {
  name: string;
  value: string;
  maxAgeSeconds?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
}

export type Handler = (ctx: RequestContext) => Promise<Reply> | Reply;

/* ---------------------------------------------------------------- replies */

export const json = (status: number, value: unknown, extra?: Partial<Reply>): Reply => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...(extra?.headers ?? {}) },
  body: JSON.stringify(value),
  ...(extra?.cookies ? { cookies: extra.cookies } : {}),
});

export const html = (status: number, markup: string, extra?: Partial<Reply>): Reply => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', ...(extra?.headers ?? {}) },
  body: markup,
  ...(extra?.cookies ? { cookies: extra.cookies } : {}),
});

export const redirect = (location: string, extra?: Partial<Reply>): Reply => ({
  status: 303, // See Other: turns a POST into a GET, so refresh does not resubmit
  headers: { location, ...(extra?.headers ?? {}) },
  ...(extra?.cookies ? { cookies: extra.cookies } : {}),
});

export const noContent = (extra?: Partial<Reply>): Reply => ({
  status: 204,
  ...(extra?.cookies ? { cookies: extra.cookies } : {}),
});

/**
 * An error reply. `code` is a stable machine string; `message` is for a person.
 *
 * Deliberately never carries a stack, a SQL fragment or an internal id: an
 * error body is the cheapest reconnaissance an attacker gets.
 */
export const problem = (status: number, code: string, message: string): Reply =>
  json(status, { error: { code, message } });

/* ---------------------------------------------------------------- cookies */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length === 0) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // a malformed cookie is data, not a crash
    }
  }
  return out;
}

export function serialiseCookie(cookie: SetCookie): string {
  const parts = [`${cookie.name}=${encodeURIComponent(cookie.value)}`];
  parts.push(`Path=${cookie.path ?? '/'}`);
  if (cookie.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(cookie.maxAgeSeconds)}`);
  if (cookie.expires !== undefined) parts.push(`Expires=${cookie.expires.toUTCString()}`);
  if (cookie.httpOnly !== false) parts.push('HttpOnly');
  if (cookie.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${cookie.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

/* ------------------------------------------------------------------ body */

export const MAX_BODY_BYTES = 1024 * 1024; // 1MB: far more than any form here needs

export class BodyTooLarge extends Error {
  constructor() {
    super('Request body too large.');
  }
}

/**
 * Read and parse a request body.
 *
 * The size check happens per chunk, so an oversized upload is refused while it
 * is still arriving rather than after it has all been buffered.
 */
export async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') return null;

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return null;

  if (type === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(raw);
      // Only an object is a usable body. An array or a bare string would make
      // every downstream `body.x` read undefined in a confusing way.
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  const params = new URLSearchParams(raw);
  const out: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    // Repeated fields (checkboxes, multi-selects) stay arrays; single fields
    // stay scalars, so handlers do not have to unwrap everything.
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

/* ------------------------------------------------------------------ CSRF */

export interface CsrfDecision {
  ok: boolean;
  reason?: string;
}

/**
 * Is this state-changing request allowed to have come from where it says?
 *
 * Checked in order of reliability:
 *   1. `Sec-Fetch-Site` — set by the browser, unforgeable by page script.
 *   2. `Origin` — present on virtually every cross-origin POST.
 *   3. `Referer` — last resort, and only its origin is used.
 *
 * A request with none of the three is refused rather than trusted. That is
 * stricter than most frameworks and it is the right default here: every real
 * browser sends at least one, so the only callers it turns away are scripted
 * ones, which should be using the API with an explicit header anyway.
 */
export function checkCsrf(ctx: RequestContext, allowedOrigins: readonly string[]): CsrfDecision {
  if (!UNSAFE.has(ctx.method)) return { ok: true };

  const fetchSite = ctx.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string') {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return { ok: true };
    return { ok: false, reason: `cross-site request (Sec-Fetch-Site: ${fetchSite})` };
  }

  const origin = ctx.headers['origin'];
  if (typeof origin === 'string' && origin.length > 0) {
    return allowedOrigins.includes(origin)
      ? { ok: true }
      : { ok: false, reason: `origin ${origin} is not allowed` };
  }

  const referer = ctx.headers['referer'];
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      return allowedOrigins.includes(new URL(referer).origin)
        ? { ok: true }
        : { ok: false, reason: 'referer is a different origin' };
    } catch {
      return { ok: false, reason: 'unparseable referer' };
    }
  }

  return { ok: false, reason: 'no Origin, Referer or Sec-Fetch-Site on a state-changing request' };
}

/* -------------------------------------------------------- security headers */

/**
 * Applied to every response.
 *
 * The CSP is strict-by-omission: no `unsafe-inline` for scripts, so the UI
 * never inlines one. `form-action 'self'` means even an injected form cannot
 * post the family's session anywhere else.
 */
export function securityHeaders(options: { https: boolean } = { https: true }): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      // Inline styles are permitted only for per-element colour tokens; scripts
      // are not, which is where injection actually hurts.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    // Nothing here needs a camera, a microphone or a location.
    'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    ...(options.https
      ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
      : {}),
  };
}

/* ---------------------------------------------------------------- router */

interface Route {
  method: Method;
  segments: string[];
  handler: Handler;
}

/**
 * A small path router. `:name` captures a segment; `*` captures the rest.
 *
 * Routes are matched in registration order, so a specific path registered
 * before a wildcard wins — which is the behaviour people expect and the one
 * that makes a catch-all safe to register last.
 */
export class Router {
  readonly #routes: Route[] = [];
  #fallback: Handler | null = null;

  add(method: Method, path: string, handler: Handler): this {
    this.#routes.push({ method, segments: path.split('/').filter((s) => s.length > 0), handler });
    return this;
  }

  /**
   * A handler for GET requests that match no route at all.
   *
   * Deliberately NOT a `'/*'` route. A wildcard route matches on path, so
   * registering one made `GET /api/auth/login` — a path that exists under POST
   * — match the wildcard and answer 200 with an HTML page, instead of the 405
   * that tells the client which method to use. The same wildcard swallowed
   * every unknown `/api` path into the app shell, handing `fetch()` a document
   * and a JSON parse error rather than a 404.
   *
   * A fallback is a different thing from a route and is treated as one: it is
   * consulted only after `match` has failed completely, so it can never shadow
   * a real endpoint or a method-not-allowed answer.
   */
  otherwise(handler: Handler): this {
    this.#fallback = handler;
    return this;
  }

  get(path: string, handler: Handler): this { return this.add('GET', path, handler); }
  post(path: string, handler: Handler): this { return this.add('POST', path, handler); }
  put(path: string, handler: Handler): this { return this.add('PUT', path, handler); }
  patch(path: string, handler: Handler): this { return this.add('PATCH', path, handler); }
  delete(path: string, handler: Handler): this { return this.add('DELETE', path, handler); }

  /**
   * Find a handler. Returns `methodNotAllowed` when the path exists under a
   * different method, so the client gets 405 rather than a misleading 404.
   */
  match(method: string, pathname: string):
    | { handler: Handler; params: Record<string, string> }
    | { methodNotAllowed: true; allowed: Method[] }
    | null {
    const segments = pathname.split('/').filter((s) => s.length > 0);
    const pathMatches: Method[] = [];

    for (const route of this.#routes) {
      const params = matchSegments(route.segments, segments);
      if (params === null) continue;
      // HEAD is served by the GET handler; the body is dropped when writing.
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) {
        return { handler: route.handler, params };
      }
      if (!pathMatches.includes(route.method)) pathMatches.push(route.method);
    }

    if (pathMatches.length > 0) return { methodNotAllowed: true, allowed: pathMatches };

    // Only now, with no route matching this path under any method, may the
    // fallback answer — and only for the safe methods a browser uses to ask
    // for a page. A POST to an unknown path is a 404, not an app shell.
    if (this.#fallback !== null && (method === 'GET' || method === 'HEAD')) {
      return { handler: this.#fallback, params: {} };
    }
    return null;
  }
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};

  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i]!;
    if (p === '*') {
      params['rest'] = actual.slice(i).join('/');
      return params;
    }
    const value = actual[i];
    if (value === undefined) return null;
    if (p.startsWith(':')) {
      // An empty segment is not a value: `/events//edit` must not match
      // `/events/:id/edit` with an empty id.
      if (value.length === 0) return null;
      params[p.slice(1)] = decodeURIComponent(value);
    } else if (p !== value) {
      return null;
    }
  }

  return pattern.length === actual.length ? params : null;
}

/* ------------------------------------------------------------- dispatch */

export interface DispatchOptions {
  router: Router;
  allowedOrigins: readonly string[];
  https: boolean;
  /** Called for unexpected throws; returns the reply to send. */
  onError?: (error: unknown, ctx: RequestContext | null) => Reply;
}

/**
 * Turn a Node request into a `Reply`, handling parsing, CSRF and errors.
 *
 * Every unexpected throw becomes a 500 with an opaque body. The detail goes to
 * the server log where an operator can see it, and nowhere near the response.
 */
export async function dispatch(
  req: IncomingMessage,
  options: DispatchOptions,
): Promise<Reply> {
  let ctx: RequestContext | null = null;
  try {
    const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost';
    const url = new URL(req.url ?? '/', `${options.https ? 'https' : 'http'}://${host}`);
    const method = (req.method ?? 'GET').toUpperCase() as Method;

    const matched = options.router.match(method, url.pathname);
    if (matched === null) return problem(404, 'not_found', 'No such page.');
    if ('methodNotAllowed' in matched) {
      return {
        ...problem(405, 'method_not_allowed', 'That method is not allowed here.'),
        headers: { allow: matched.allowed.join(', '), 'content-type': 'application/json; charset=utf-8' },
      };
    }

    let body: Record<string, unknown> | null = null;
    if (UNSAFE.has(method)) {
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          return problem(413, 'body_too_large', 'That request was too large.');
        }
        throw error;
      }
    }

    ctx = {
      method,
      url,
      params: matched.params,
      query: url.searchParams,
      headers: req.headers,
      cookies: parseCookies(req.headers.cookie),
      body,
      raw: req,
      ip: clientIp(req),
    };

    const csrf = checkCsrf(ctx, options.allowedOrigins);
    if (!csrf.ok) {
      return problem(403, 'csrf', 'This request did not come from Michel-OS. Reload the page and try again.');
    }

    return await matched.handler(ctx);
  } catch (error) {
    if (options.onError) return options.onError(error, ctx);
    console.error('[http] unhandled error:', error);
    return problem(500, 'internal', 'Something went wrong. It has been logged.');
  }
}

/**
 * The client address, honouring exactly one `X-Forwarded-For` hop.
 *
 * One hop because there is exactly one reverse proxy in front of this (Caddy).
 * Trusting the whole chain would let a client prepend any address it likes and
 * poison rate limiting or logs.
 */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]!.trim();
    if (first.length > 0) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Write a `Reply` to the socket. */
export function send(res: ServerResponse, reply: Reply, baseHeaders: Record<string, string>): void {
  const headers: Record<string, string | string[]> = { ...baseHeaders, ...(reply.headers ?? {}) };
  if (reply.cookies && reply.cookies.length > 0) {
    headers['set-cookie'] = reply.cookies.map(serialiseCookie);
  }
  res.writeHead(reply.status, headers);
  if (reply.body === undefined || res.req.method === 'HEAD') res.end();
  else res.end(reply.body);
}
