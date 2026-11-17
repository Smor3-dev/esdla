/**
 * OAuth 2.0 de Mercado Libre (authorization code + PKCE S256 + state).
 *
 * - El Client Secret solo se usa acá, del lado del servidor.
 * - access_token y refresh_token se guardan cifrados (AES-256-GCM) en oauth_tokens.
 * - El refresh_token es de un solo uso: el refresco se serializa con un advisory lock
 *   de Postgres para que dos funciones en paralelo no lo quemen.
 */
import { z } from 'zod';
import { env, requireMl } from '../../config/env.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { db, type Db } from '../../lib/db.js';
import { log } from '../../lib/logger.js';

export const ML_API = 'https://api.mercadolibre.com';
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export class MlOAuthError extends Error {
  override name = 'MlOAuthError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`OAuth de Mercado Libre: ${code}`);
  }
}

export class MlNotConnectedError extends Error {
  override name = 'MlNotConnectedError';
  constructor(readonly reason: 'missing' | 'reauth_required' = 'missing') {
    super(reason === 'missing' ? 'Mercado Libre no está conectado' : 'Hay que volver a conectar Mercado Libre');
  }
}

const tokenSchema = z.looseObject({
  access_token: z.string().min(10).max(2048),
  token_type: z.string(),
  expires_in: z.number().int().positive().max(60 * 60 * 24 * 30),
  scope: z.string().optional(),
  user_id: z.union([z.number(), z.string()]),
  refresh_token: z.string().min(10).max(2048).optional(),
});
export type MlTokens = z.infer<typeof tokenSchema>;

const aad = (kind: 'access' | 'refresh', accountId: string) => `oauth:mercadolibre:${kind}:${accountId}`;

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const { clientId, redirectUri } = requireMl();
  const url = new URL('/authorization', env().ML_AUTH_BASE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<MlTokens> {
  let res: Response;
  try {
    res = await fetch(`${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch {
    throw new MlOAuthError(0, 'network');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new MlOAuthError(res.status, String(data.error ?? `http_${res.status}`).slice(0, 60));
  const parsed = tokenSchema.safeParse(data);
  if (!parsed.success) throw new MlOAuthError(502, 'unexpected_response');
  return parsed.data;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<MlTokens> {
  const { clientId, clientSecret, redirectUri } = requireMl();
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

export async function saveTokens(sql: Db, t: MlTokens): Promise<string> {
  if (!t.refresh_token) throw new MlOAuthError(400, 'missing_refresh_token'); // falta el scope offline_access
  const accountId = String(t.user_id);
  if (!/^\d{3,20}$/.test(accountId)) throw new MlOAuthError(502, 'bad_user_id');
  const expiresAt = new Date(Date.now() + t.expires_in * 1000);
  await sql`
    insert into oauth_tokens (provider, account_id, access_token_enc, refresh_token_enc, scope, expires_at, status, updated_at)
    values ('mercadolibre', ${accountId}, ${encrypt(t.access_token, aad('access', accountId))},
            ${encrypt(t.refresh_token, aad('refresh', accountId))}, ${t.scope ?? null}, ${expiresAt}, 'active', now())
    on conflict (provider) do update set
      account_id = excluded.account_id,
      access_token_enc = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      scope = excluded.scope,
      expires_at = excluded.expires_at,
      status = 'active',
      updated_at = now()`;
  return accountId;
}

interface TokenRow {
  account_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: Date;
  status: string;
}

export async function getConnection(sql: Db = db()): Promise<TokenRow | undefined> {
  const rows = await sql<TokenRow[]>`
    select account_id, access_token_enc, refresh_token_enc, expires_at, status
    from oauth_tokens where provider = 'mercadolibre'`;
  return rows[0];
}

/** Devuelve un access token vigente, refrescándolo si vence en menos de 10 minutos. */
export async function getAccessToken(opts: { forceRefresh?: boolean; marginMs?: number } = {}): Promise<{ token: string; accountId: string }> {
  const row = await getConnection();
  if (!row) throw new MlNotConnectedError('missing');
  if (row.status !== 'active') throw new MlNotConnectedError('reauth_required');
  const margin = opts.marginMs ?? REFRESH_MARGIN_MS;
  if (!opts.forceRefresh && new Date(row.expires_at).getTime() - Date.now() > margin) {
    return { token: decrypt(row.access_token_enc, aad('access', row.account_id)), accountId: row.account_id };
  }
  return refreshWithLock(Boolean(opts.forceRefresh), margin);
}

async function refreshWithLock(force: boolean, margin: number): Promise<{ token: string; accountId: string }> {
  const { clientId, clientSecret } = requireMl();
  const result = await db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ml_token_refresh'))`;
    const row = (await tx<TokenRow[]>`
      select account_id, access_token_enc, refresh_token_enc, expires_at, status
      from oauth_tokens where provider = 'mercadolibre' for update`)[0];
    if (!row) return { kind: 'missing' as const };
    if (row.status !== 'active') return { kind: 'reauth' as const };
    // Otra instancia pudo haber refrescado mientras esperábamos el lock.
    if (!force && new Date(row.expires_at).getTime() - Date.now() > margin) {
      return { kind: 'ok' as const, token: decrypt(row.access_token_enc, aad('access', row.account_id)), accountId: row.account_id };
    }
    try {
      const t = await tokenRequest({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: decrypt(row.refresh_token_enc, aad('refresh', row.account_id)),
      });
      if (String(t.user_id) !== row.account_id) return { kind: 'account_changed' as const };
      await saveTokens(tx, t);
      return { kind: 'ok' as const, token: t.access_token, accountId: row.account_id };
    } catch (err) {
      if (err instanceof MlOAuthError && err.code === 'invalid_grant') return { kind: 'invalid_grant' as const };
      throw err;
    }
  });

  if (result.kind === 'ok') return { token: result.token, accountId: result.accountId };
  if (result.kind === 'missing') throw new MlNotConnectedError('missing');
  // invalid_grant: el usuario cambió la contraseña, revocó el permiso, se renovó el secret o pasaron 6 meses.
  await db()`update oauth_tokens set status = 'reauth_required', updated_at = now() where provider = 'mercadolibre'`;
  log.security('ml.token_invalid', { kind: result.kind });
  throw new MlNotConnectedError('reauth_required');
}
