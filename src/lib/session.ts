/**
 * Sesión del panel admin: cookie HttpOnly + Secure + SameSite=Strict firmada con
 * HMAC-SHA256 (no se puede leer desde JS ni falsificar). Vence a las 8 horas.
 */
import { env } from '../config/env.js';
import { clearCookie, readCookies, serializeCookie } from './cookies.js';
import { b64url, fromB64url, hmacB64url, randomToken, safeEqual } from './crypto.js';
import { HttpError } from './http.js';

const COOKIE = '__Host-esdla_admin';
const TTL_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  sub: 'admin';
  iat: number;
  exp: number;
  jti: string;
}

function sign(payloadB64: string): string {
  return hmacB64url(env().SESSION_SECRET, `session:${payloadB64}`);
}

export function createSessionCookie(now = Date.now()): string {
  const payload: SessionPayload = {
    sub: 'admin',
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + TTL_SECONDS,
    jti: randomToken(16),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return serializeCookie(COOKIE, `${body}.${sign(body)}`, { maxAge: TTL_SECONDS, sameSite: 'Strict' });
}

export function readSession(req: Request, now = Date.now()): SessionPayload | null {
  const raw = readCookies(req).get(COOKIE);
  if (!raw || raw.length > 1024) return null;
  const [body, sig, extra] = raw.split('.');
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, sign(body))) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as SessionPayload;
    if (payload.sub !== 'admin' || typeof payload.exp !== 'number') return null;
    if (payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function requireAdmin(req: Request): SessionPayload {
  const session = readSession(req);
  if (!session) throw new HttpError(401, 'Iniciá sesión para continuar', 'unauthorized');
  return session;
}

export const logoutCookie = () => clearCookie(COOKIE);
