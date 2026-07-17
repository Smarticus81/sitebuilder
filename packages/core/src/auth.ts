// Single-operator authentication (Phase E). Password from env → stateless
// signed session token (HMAC, 7-day expiry). No user table, no external IdP.
// In production the password is REQUIRED (validateEnv enforces it).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function secretFrom(env: NodeJS.ProcessEnv): string {
  // Dedicated secret preferred; falls back to the password itself so a bare
  // DASHBOARD_PASSWORD setup still gets signed tokens.
  return env.AUTH_SESSION_SECRET?.trim() || env.DASHBOARD_PASSWORD?.trim() || '';
}

export function authEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.DASHBOARD_PASSWORD?.trim();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verify the operator password (constant-time). */
export function checkPassword(password: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.DASHBOARD_PASSWORD?.trim() ?? '';
  if (!expected) return false;
  return safeEqual(password, expected);
}

/** Mint a session token: base64(exp.nonce).hmac */
export function issueToken(env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const exp = now + TOKEN_TTL_MS;
  const payload = `${exp}.${randomBytes(8).toString('hex')}`;
  const sig = createHmac('sha256', secretFrom(env)).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

/** Validate a session token (signature + expiry). */
export function verifyToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return false;
  let payload: string;
  try {
    payload = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const expected = createHmac('sha256', secretFrom(env)).update(payload).digest('hex');
  if (!safeEqual(sig, expected)) return false;
  const exp = Number(payload.split('.')[0]);
  return Number.isFinite(exp) && now < exp;
}
