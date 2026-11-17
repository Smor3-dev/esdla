/**
 * Conexión de la cuenta de Mercado Libre (una sola vez, desde el panel).
 *   GET /api/admin/ml/connect  → exige sesión admin; genera state + PKCE y redirige a Mercado Libre.
 *   GET /api/admin/ml/callback → valida state, canjea el code y guarda los tokens cifrados.
 *
 * El state y el code_verifier viajan en una cookie cifrada (AES-256-GCM), HttpOnly,
 * SameSite=Lax (tiene que sobrevivir la redirección desde mercadolibre.com.uy) y de 10 minutos.
 */
import type { Config } from '@netlify/functions';
import { env } from '../../src/config/env.js';
import { audit } from '../../src/lib/audit.js';
import { clearCookie, readCookies, serializeCookie } from '../../src/lib/cookies.js';
import { decrypt, encrypt, pkcePair, randomToken, safeEqual } from '../../src/lib/crypto.js';
import { db } from '../../src/lib/db.js';
import { assertMethod, handle, redirect } from '../../src/lib/http.js';
import { log } from '../../src/lib/logger.js';
import { requireAdmin } from '../../src/lib/session.js';
import { buildAuthorizeUrl, exchangeCode, MlOAuthError, saveTokens } from '../../src/integrations/mercadolibre/oauth.js';
import { processMlOutbox } from '../../src/services/sync.js';

const COOKIE = '__Host-esdla_ml_oauth';
const AAD = 'ml-oauth-flow';

export default handle('admin.ml_oauth', async (req) => {
  assertMethod(req, 'GET');
  const path = new URL(req.url).pathname;
  const panel = (estado: string) => `${env().SITE_URL}/admin/?ml=${estado}`;

  if (path.endsWith('/connect')) {
    requireAdmin(req);
    const state = randomToken(24);
    const { verifier, challenge } = pkcePair();
    const flow = encrypt(JSON.stringify({ state, verifier, exp: Date.now() + 10 * 60 * 1000 }), AAD);
    return redirect(buildAuthorizeUrl(state, challenge), {
      'Set-Cookie': serializeCookie(COOKIE, flow, { maxAge: 600, sameSite: 'Lax' }),
    });
  }

  // Callback
  const params = new URL(req.url).searchParams;
  const clear = { 'Set-Cookie': clearCookie(COOKIE) };
  const raw = readCookies(req).get(COOKIE);
  if (!raw) return redirect(panel('sesion-vencida'), clear);

  let flow: { state: string; verifier: string; exp: number };
  try {
    flow = JSON.parse(decrypt(raw, AAD));
  } catch {
    log.security('ml.oauth_bad_cookie', {});
    return redirect(panel('error'), clear);
  }
  const state = params.get('state') ?? '';
  if (Date.now() > flow.exp || state.length > 100 || !safeEqual(state, flow.state)) {
    log.security('ml.oauth_state_mismatch', {});
    return redirect(panel('error'), clear);
  }
  if (params.get('error')) return redirect(panel('cancelado'), clear);

  const code = params.get('code') ?? '';
  if (!/^[A-Za-z0-9._-]{10,400}$/.test(code)) return redirect(panel('error'), clear);

  try {
    const tokens = await exchangeCode(code, flow.verifier);
    const expected = env().ML_SELLER_USER_ID;
    if (expected && String(tokens.user_id) !== expected) {
      log.security('ml.oauth_wrong_account', {});
      return redirect(panel('cuenta-incorrecta'), clear);
    }
    const accountId = await saveTokens(db(), tokens);
    await audit('admin', 'ml_connected', { accountId });
    await processMlOutbox().catch(() => undefined);
    return redirect(panel('conectado'), clear);
  } catch (err) {
    const code = err instanceof MlOAuthError ? err.code : 'error';
    log.error('ml.oauth_exchange_failed', { code });
    return redirect(panel(code === 'missing_refresh_token' ? 'falta-offline-access' : 'error'), clear);
  }
});

export const config: Config = { path: ['/api/admin/ml/connect', '/api/admin/ml/callback'], method: 'GET' };
