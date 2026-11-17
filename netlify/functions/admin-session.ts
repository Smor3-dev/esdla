/**
 * /api/admin/session
 *   GET    → { authenticated }
 *   POST   → login con contraseña (scrypt), CSRF + límite de intentos
 *   DELETE → logout
 */
import type { Config } from '@netlify/functions';
import { env } from '../../src/config/env.js';
import { audit } from '../../src/lib/audit.js';
import { verifyPassword } from '../../src/lib/crypto.js';
import { assertSameSiteRequest } from '../../src/lib/csrf.js';
import { db } from '../../src/lib/db.js';
import { assertMethod, clientIp, handle, HttpError, json, readJson } from '../../src/lib/http.js';
import { log } from '../../src/lib/logger.js';
import { rateLimit } from '../../src/lib/rate-limit.js';
import { createSessionCookie, logoutCookie, readSession } from '../../src/lib/session.js';
import { loginSchema } from '../../src/lib/validation.js';

export default handle('admin.session', async (req, context) => {
  assertMethod(req, 'GET', 'POST', 'DELETE');

  if (req.method === 'GET') {
    return json({ authenticated: readSession(req) !== null });
  }

  assertSameSiteRequest(req);

  if (req.method === 'DELETE') {
    return json({ ok: true }, 200, { 'Set-Cookie': logoutCookie() });
  }

  const ip = clientIp(context);
  await rateLimit(db(), 'login', ip, 5, 15 * 60);
  const { password } = await readJson(req, loginSchema, 1024);
  const ok = await verifyPassword(password, env().ADMIN_PASSWORD_HASH);
  if (!ok) {
    log.security('admin.login_failed', { ip });
    await audit('anon', 'login_failed', { ip });
    throw new HttpError(401, 'Contraseña incorrecta', 'bad_credentials');
  }
  await audit('admin', 'login', { ip });
  return json({ ok: true }, 200, { 'Set-Cookie': createSessionCookie() });
});

export const config: Config = {
  path: '/api/admin/session',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
