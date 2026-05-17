// Auth helpers: PBKDF2 password hashing (Web Crypto, no deps) + JWT issue/verify.
//
// Password hash format: `pbkdf2$<iterations>$<base64-salt>$<base64-hash>`.
// We pick PBKDF2 over bcrypt because Web Crypto ships in Workers natively;
// bcrypt would require a JS implementation (slow + cold-start cost).

import jwt from '@tsndr/cloudflare-worker-jwt';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1]!, 10);
  const salt = unb64(parts[2]!);
  const expected = unb64(parts[3]!);
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(password);
  const key = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

// JWT: 7-day expiry, HS256. Payload carries email + role + allowed_apps so
// route handlers can authorize without a second KV read.
export interface JwtPayload {
  sub: string;          // email
  role: 'admin' | 'user';
  apps: string[];       // allowed app keys, or ['all']
  exp: number;          // unix seconds
  iat: number;
}

const JWT_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function issueJwt(secret: string, claims: Omit<JwtPayload, 'exp' | 'iat'>): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + JWT_TTL_SECONDS;
  const payload: JwtPayload = { ...claims, iat, exp };
  const token = await jwt.sign(payload, secret);
  return { token, expiresAt: exp };
}

export async function verifyJwt(secret: string, token: string): Promise<JwtPayload | null> {
  // throwError mode returns the decoded JwtData (header + payload) on success
  // and throws on bad signature / exp / nbf — single parse pass instead of
  // verify-then-decode (which would re-parse and tempt a future refactor to
  // drop the verify call without realizing decode skips signature checks).
  try {
    const data = await jwt.verify<JwtPayload>(token, secret, { throwError: true });
    return data?.payload ?? null;
  } catch {
    return null;
  }
}
