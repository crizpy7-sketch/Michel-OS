import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the auth view parses and exports both account setup entry points', async () => {
  // Import through a runtime URL so TypeScript does not need declarations for
  // the browser-only JS module. This is deliberately small: its job is to make
  // a syntax error in the first screen of the app block the merge gate.
  const moduleUrl = new URL('../../public/views/auth.js', import.meta.url).href;
  const auth = await import(moduleUrl);

  assert.equal(typeof auth.render, 'function');
  assert.equal(typeof auth.renderOnboarding, 'function');
});
