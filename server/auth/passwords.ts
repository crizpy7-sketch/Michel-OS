/**
 * Password hashing (Agent E — Household/Auth).
 *
 * ADR-001 accepted that self-hosting means we own authentication. Owning auth
 * is only defensible if it stays small and boring, so this file is deliberately
 * both. It uses `node:crypto` scrypt and nothing else: no dependency to audit,
 * no native build step, no supply chain.
 *
 * scrypt rather than bcrypt or argon2 because it is in the standard library and
 * is memory-hard. The parameters below are the cost this deployment pays per
 * login; they are recorded IN the hash string so that raising them later does
 * not invalidate everybody's password.
 *
 * The properties that matter, each of which has a test:
 *
 *   - Two identical passwords produce different hashes (per-hash salt).
 *   - Verification is constant-time (`timingSafeEqual`), so an attacker cannot
 *     learn the hash a byte at a time by measuring.
 *   - A malformed or unknown-algorithm hash fails closed rather than throwing,
 *     because an exception in a login handler is an information leak and a 500.
 *   - Verifying against a nonexistent user still does the work, so "no such
 *     email" and "wrong password" take the same time and cannot be told apart.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Cost parameters. N is the work factor; 2^16 lands around 100ms on a modest
 * VPS core, which is the usual balance between "an attacker must spend real
 * money" and "a family can log in".
 *
 * `maxmem` must be raised alongside N: scrypt needs roughly 128 * N * r bytes,
 * and Node's default 32MB ceiling rejects N=65536 outright. That failure mode
 * is an exception at login time, which is exactly the sort of thing that is
 * discovered in production, so it is pinned here with the arithmetic visible.
 */
const PARAMS = { N: 65_536, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** `scrypt$N$r$p$salt$key`, all base64url. Self-describing so cost can change. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword: a non-empty password is required.');
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Check a password against a stored hash.
 *
 * Never throws. A corrupt hash, an unknown algorithm, a truncated field — all
 * return false, because the alternative is a 500 that tells an attacker their
 * input reached something interesting.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;

    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [algorithm, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts as [string, string, string, string, string, string];
    if (algorithm !== 'scrypt') return false;

    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    // A hash claiming an absurd work factor would let a crafted row turn one
    // login attempt into a denial of service against our own CPU.
    if (N < 1024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

    const salt = Buffer.from(saltRaw, 'base64url');
    const expected = Buffer.from(keyRaw, 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N, r, p, maxmem: Math.max(PARAMS.maxmem, 256 * N * r),
    });
    // Lengths are equal by construction above; timingSafeEqual throws if not.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Burn the same work as a real verification, for logins whose email does not
 * exist.
 *
 * Without this, "no such account" returns in microseconds while "wrong
 * password" takes ~100ms, and anyone can enumerate which of a list of emails
 * has an account here by timing alone. The value is discarded; the CPU time is
 * the entire point.
 */
export async function burnVerificationTime(): Promise<void> {
  await scrypt('timing-equalizer', randomBytes(SALT_LENGTH), KEY_LENGTH, PARAMS);
}

/**
 * Should this hash be re-hashed on next successful login?
 *
 * True when it was made with weaker parameters than we now use. Lets the cost
 * be raised over time without a forced password reset — the upgrade happens
 * silently the next time each person logs in.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

/**
 * Reject passwords that are trivially guessable.
 *
 * Deliberately not a complexity ruleset: forcing a symbol and a digit produces
 * `Password1!` and a sticky note. Length is what actually resists guessing, so
 * the floor is 10 characters, plus a small blocklist of the passwords that
 * appear at the top of every breach corpus.
 */
const OBVIOUS = new Set([
  'password', 'password1', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'letmein123', 'iloveyou1', 'admin1234', 'welcome123', 'michelos',
]);

export interface PasswordProblem {
  code: 'too_short' | 'too_common' | 'too_long';
  message: string;
}

export function checkPasswordStrength(password: string): PasswordProblem | null {
  if (typeof password !== 'string') {
    return { code: 'too_short', message: 'Use at least 10 characters. A short phrase works well.' };
  }

  // The blocklist is checked BEFORE the length rule on purpose. Most entries in
  // it are under ten characters, so a length-first order would make them
  // unreachable and would answer "password1" with "too short" — which is true,
  // unhelpful, and invites the user to try "password12".
  if (OBVIOUS.has(password.toLowerCase().replace(/\s+/g, ''))) {
    return { code: 'too_common', message: 'That password appears in every breach list. Pick another.' };
  }
  if (password.length < 10) {
    return { code: 'too_short', message: 'Use at least 10 characters. A short phrase works well.' };
  }
  // scrypt hashes the whole input, so a megabyte password is a free way to make
  // the server do a megabyte of work per attempt.
  if (password.length > 200) {
    return { code: 'too_long', message: 'That password is longer than 200 characters.' };
  }
  return null;
}
