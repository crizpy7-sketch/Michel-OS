/**
 * The app shell (Agent L).
 *
 * The shell is the one piece of HTML this codebase generates by string
 * concatenation, so the tests that matter are about what it does NOT contain:
 * no inline script (the CSP has no `unsafe-inline`, so one would silently fail
 * to run and the app would never boot), and no unescaped interpolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, renderManifest, renderShell } from '../../server/ui/shell.ts';

/* --------------------------------------------------------------- escaping */

test('escapeHtml covers attribute context as well as text', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  // Quotes matter because the same helper is used inside attribute values, and
  // one that is safe in text but not in attributes is one somebody will
  // eventually use in the wrong place.
  assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('the ampersand is escaped first, so nothing is double-escaped', () => {
  // Escaping `<` before `&` would turn `<` into `&lt;` and then into
  // `&amp;lt;`, which renders as the literal text "&lt;".
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

/* ------------------------------------------------------------------ shell */

test('the shell has no inline script and no inline event handler', () => {
  const shell = renderShell({ version: 'abc123' });

  // The CSP is `script-src 'self'`. An inline script would not run, and the
  // app would boot to a permanently empty page — the kind of failure that
  // looks like a server problem and is not.
  assert.doesNotMatch(shell, /<script(?![^>]*\ssrc=)/i, 'found a script without a src');
  assert.doesNotMatch(shell, /\son[a-z]+\s*=/i, 'found an inline event handler');
  assert.doesNotMatch(shell, /javascript:/i);
});

test('the shell loads its assets with the version stamp', () => {
  const shell = renderShell({ version: 'abc123' });
  assert.match(shell, /<link rel="stylesheet" href="\/app\.css\?v=abc123">/);
  assert.match(shell, /<script type="module" src="\/app\.js\?v=abc123">/);
});

test('a version stamp cannot break out of the attribute', () => {
  const shell = renderShell({ version: '"><script>alert(1)</script>' });
  assert.doesNotMatch(shell, /<script>alert/);
  // URL-encoded rather than merely HTML-escaped: this value lands in a URL, and
  // `&quot;` inside an href would be a real character in the request path.
  assert.match(shell, /app\.css\?v=%22%3E/);
});

test('a title is escaped and the product name is appended', () => {
  const shell = renderShell({ version: 'v1', title: 'Leila & <b>Piano</b>' });
  assert.match(shell, /<title>Leila &amp; &lt;b&gt;Piano&lt;\/b&gt; · Michel-OS<\/title>/);
});

test('the shell carries the accessibility furniture', () => {
  const shell = renderShell({ version: 'v1' });
  assert.match(shell, /class="skip-link"/, 'no skip link');
  assert.match(shell, /<main[^>]+id="main"/, 'no main landmark');
  assert.match(shell, /<main[^>]+tabindex="-1"/, 'main is not focusable after navigation');
  assert.match(shell, /aria-live="polite"/, 'no polite live region for toasts');
  assert.match(shell, /aria-modal="true"/, 'the sheet is not a modal dialog');
  assert.match(shell, /<noscript>/, 'no message for a browser without JavaScript');
});

test('both navigations render the same five destinations', () => {
  const shell = renderShell({ version: 'v1' });
  for (const href of ['/', '/schedule', '/add', '/assistant', '/more']) {
    // Twice: once in the tab bar, once in the rail. CSS shows one of them.
    const count = shell.split(`data-nav="${href}"`).length - 1;
    assert.equal(count, 2, `${href} appears ${count} times, expected 2`);
  }
});

test('the shell pre-renders a skeleton rather than an empty page', () => {
  const shell = renderShell({ version: 'v1' });
  // A blank screen while the JavaScript loads reads as a broken app. The
  // skeleton is also `aria-hidden`, so it is not announced as content.
  assert.match(shell, /skeleton--tile/);
  assert.match(shell, /aria-hidden="true"/);
});

test('the viewport allows zoom', () => {
  const shell = renderShell({ version: 'v1' });
  // `user-scalable=no` and `maximum-scale=1` both stop someone pinching to read
  // a small label. UI_RESPONSIVE_SPEC §8 requires readable text.
  assert.doesNotMatch(shell, /user-scalable\s*=\s*no/);
  assert.doesNotMatch(shell, /maximum-scale/);
  assert.match(shell, /viewport-fit=cover/, 'no safe-area support on a notched phone');
});

/* --------------------------------------------------------------- manifest */

test('the manifest is valid JSON with the icons it was given', () => {
  const parsed = JSON.parse(renderManifest([
    { src: '/icons/derived/appointments-192-abc.png', sizes: '192x192' },
    { src: '/icons/derived/appointments-512-abc.png', sizes: '512x512' },
  ]));

  assert.equal(parsed.display, 'standalone');
  assert.equal(parsed.start_url, '/');
  assert.equal(parsed.icons.length, 2);
  assert.equal(parsed.icons[0].type, 'image/png');
});

test('a manifest with no icons is still valid', () => {
  // The icon script may not have been run yet. The app must still load; it just
  // cannot be installed to a home screen.
  const parsed = JSON.parse(renderManifest([]));
  assert.deepEqual(parsed.icons, []);
  assert.equal(parsed.name, 'Michel-OS — Family Scheduling');
});
