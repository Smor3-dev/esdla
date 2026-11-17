/**
 * Protección CSRF en dos capas para todo endpoint que cambia estado:
 *  1. Verificación de origen: el header Origin (o Sec-Fetch-Site) debe ser el propio sitio.
 *  2. "Signed double-submit cookie" (OWASP): una cookie HttpOnly con un nonce y un
 *     header X-CSRF-Token = HMAC(CSRF_SECRET, nonce). Otro sitio no puede leer la
 *     cookie ni calcular el HMAC, así que no puede fabricar el header.
 */
import { env } from '../config/env.js';
import { readCookies, serializeCookie } from './cookies.js';
import { hmacB64url, randomToken, safeEqual } from './crypto.js';
import { HttpError } from './http.js';

const COOKIE = '__Host-esdla_csrf';
const TTL_SECONDS = 2 * 60 * 60;

export function issueCsrf(): { token: string; setCookie: string } {
  const nonce = randomToken(32);
  return {
    token: hmacB64url(env().CSRF_SECRET, `csrf:${nonce}`),
    setCookie: serializeCookie(COOKIE, nonce, { maxAge: TTL_SECONDS, sameSite: 'Strict' }),
  };
}

export function verifyCsrf(req: Request): void {
  const nonce = readCookies(req).get(COOKIE);
  const header = req.headers.get('x-csrf-token');
  if (!nonce || !header || header.length > 128 || nonce.length > 128) {
    throw new HttpError(403, 'La sesión de seguridad venció. Recargá la página.', 'csrf');
  }
  if (!safeEqual(header, hmacB64url(env().CSRF_SECRET, `csrf:${nonce}`))) {
    throw new HttpError(403, 'La sesión de seguridad venció. Recargá la página.', 'csrf');
  }
}

export function verifyOrigin(req: Request): void {
  const allowed = new Set([new URL(req.url).origin, new URL(env().SITE_URL).origin]);
  const origin = req.headers.get('origin');
  if (origin) {
    if (allowed.has(origin)) return;
  } else if (req.headers.get('sec-fetch-site') === 'same-origin') {
    return;
  }
  throw new HttpError(403, 'Origen no permitido', 'bad_origin');
}

/** Atajo para endpoints que modifican estado. */
export function assertSameSiteRequest(req: Request): void {
  verifyOrigin(req);
  verifyCsrf(req);
}
