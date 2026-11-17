/** GET /api/csrf → entrega el token anti-CSRF y setea su cookie HttpOnly. */
import type { Config } from '@netlify/functions';
import { issueCsrf } from '../../src/lib/csrf.js';
import { assertMethod, handle, json } from '../../src/lib/http.js';

export default handle('csrf', async (req) => {
  assertMethod(req, 'GET');
  const { token, setCookie } = issueCsrf();
  return json({ csrfToken: token }, 200, { 'Set-Cookie': setCookie });
});

export const config: Config = { path: '/api/csrf', method: 'GET' };
