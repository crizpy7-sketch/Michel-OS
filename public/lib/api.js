/**
 * The API client (Agent L).
 *
 * Every request the app makes goes through `request()`, which exists so that
 * three things are handled in one place rather than at eighty call sites:
 *
 *   1. `credentials: 'same-origin'` and the JSON headers, so no call can
 *      accidentally omit the session cookie and get a confusing 401;
 *   2. the error taxonomy — a 401 is not a failure, it is "sign in", and a 403
 *      is not an error message, it is a permission-denied state (§9);
 *   3. `Sec-Fetch-Site` is set by the browser and cannot be forged from here,
 *      so nothing in this file has to think about CSRF at all.
 */

/** A failed request, carrying enough for a view to choose a state. */
export class ApiError extends Error {
  constructor(status, code, message, issues = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  /** Should the app show the sign-in screen rather than an error? */
  get isAuth() { return this.status === 401; }

  /** Should the view render the permission-denied state (§9)? */
  get isDenied() { return this.status === 403; }

  get isMissing() { return this.status === 404; }

  /** Field-level problems from a form submission, keyed by field name. */
  get fieldErrors() {
    const map = new Map();
    for (const issue of this.issues) {
      if (!map.has(issue.path)) map.set(issue.path, issue.message);
    }
    return map;
  }
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    // A network failure is not a server error and must not be reported as one:
    // "Something went wrong" sends people to look for a bug that is not there,
    // when the answer is that the phone left the wifi.
    throw new ApiError(0, 'offline', 'No connection. This will work again when you are back online.', []);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  if (text.length > 0) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (response.ok) return payload;

  const error = payload?.error ?? {};
  throw new ApiError(
    response.status,
    error.code ?? 'error',
    error.message ?? 'That did not work.',
    Array.isArray(error.issues) ? error.issues : [],
  );
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path) => request('DELETE', path),
};

/** URL-encode a query object, dropping empty values. */
export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : '';
}
