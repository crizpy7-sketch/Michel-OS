/**
 * Boot configuration (Agent B3).
 *
 * This is the only layer whose input is a person typing into a `.env` file, so
 * it has more ways to be wrong than anything else in the codebase and each one
 * should fail in a hundred milliseconds with a sentence naming the variable —
 * not sixty seconds later as a connection timeout, and never as a login that
 * silently never sticks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, readConfig } from '../../server/main.ts';

const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://michel:pw@db:5432/michel',
  BASE_URL: 'https://michel.example.com',
  ...extra,
} as NodeJS.ProcessEnv);

test('a complete configuration reads through', () => {
  const config = readConfig(base({ PORT: '8080' }));
  assert.equal(config.port, 8080);
  assert.equal(config.https, true);
  assert.deepEqual(config.allowedOrigins, ['https://michel.example.com']);
});

test('the port defaults rather than being required', () => {
  assert.equal(readConfig(base()).port, 3000);
});

test('a missing DATABASE_URL names the variable and the fix', () => {
  assert.throws(() => readConfig({ BASE_URL: 'https://x.example' } as NodeJS.ProcessEnv), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /DATABASE_URL/);
    assert.match(error.message, /\.env/);
    return true;
  });
});

test('a missing BASE_URL is refused', () => {
  assert.throws(
    () => readConfig({ DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv),
    /BASE_URL/,
  );
});

test('a BASE_URL that is not a URL is refused', () => {
  assert.throws(() => readConfig(base({ BASE_URL: 'michel.example.com' })), /not a valid URL/);
});

test('a non-http scheme is refused', () => {
  assert.throws(() => readConfig(base({ BASE_URL: 'ftp://michel.example.com' })), /http or https/);
});

test('a nonsense PORT is refused rather than silently becoming NaN', () => {
  for (const port of ['', 'eighty', '0', '-1', '70000', '8080.5']) {
    assert.throws(() => readConfig(base({ PORT: port })), /PORT/, `accepted ${JSON.stringify(port)}`);
  }
});

test('an http BASE_URL is refused unless the insecurity is confirmed', () => {
  // http means the session cookie cannot be Secure. That is fine on a laptop
  // and not fine on the internet, and the difference cannot be guessed from
  // the URL — so it has to be stated.
  assert.throws(() => readConfig(base({ BASE_URL: 'http://localhost:3000' })), /ALLOW_INSECURE/);

  const config = readConfig(base({ BASE_URL: 'http://localhost:3000', ALLOW_INSECURE: 'true' }));
  assert.equal(config.https, false);
});

test('extra origins are normalised and de-duplicated', () => {
  const config = readConfig(base({
    EXTRA_ORIGINS: 'https://192.168.1.20:8443/, https://MICHEL.example.com, https://michel.example.com',
  }));
  // Each one through `new URL(...).origin`, so a trailing slash or an uppercase
  // host cannot produce an entry that never matches a real Origin header.
  assert.deepEqual(config.allowedOrigins, ['https://michel.example.com', 'https://192.168.1.20:8443']);
});

test('an empty EXTRA_ORIGINS is not an error', () => {
  assert.deepEqual(readConfig(base({ EXTRA_ORIGINS: '  ,  ' })).allowedOrigins,
    ['https://michel.example.com']);
});

test('a broken EXTRA_ORIGINS entry is named rather than skipped', () => {
  // Skipping it would leave a family who added their LAN address wondering why
  // login works on the domain and nowhere else.
  assert.throws(() => readConfig(base({ EXTRA_ORIGINS: 'https://ok.example, not a url' })),
    /EXTRA_ORIGINS/);
});

test('schema verification is on unless it is explicitly turned off', () => {
  assert.equal(readConfig(base()).verifySchema, true);
  assert.equal(readConfig(base({ SKIP_SCHEMA_VERIFY: 'true' })).verifySchema, false);
  // Anything other than the exact word leaves the check on: a footgun should
  // need the whole word, not a truthy-looking one.
  assert.equal(readConfig(base({ SKIP_SCHEMA_VERIFY: '1' })).verifySchema, true);
});
