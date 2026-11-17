/**
 * Cliente HTTP mínimo para la API de Mercado Pago.
 * - El Access Token sale de MP_ACCESS_TOKEN (web) o MP_POS_ACCESS_TOKEN (caja) y solo viaja
 *   en el header Authorization.
 * - Timeouts, reintentos con backoff solo cuando es seguro (GET o POST con X-Idempotency-Key).
 * - Los errores se loguean sin cuerpo completo ni credenciales.
 */
import { requireMp, type MpApp } from '../../config/env.js';
import { log } from '../../lib/logger.js';

const MP_BASE = 'https://api.mercadopago.com';

export class MpApiError extends Error {
  override name = 'MpApiError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Mercado Pago respondió ${status} (${code})`);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  app?: MpApp;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => 300 * 2 ** attempt + Math.floor(Math.random() * 200);

export async function mpRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (!/^\/[A-Za-z0-9/_\-.?=&%]*$/.test(path) || path.includes('..')) throw new Error('Ruta de API inválida');
  const { accessToken } = requireMp(opts.app ?? 'online');
  const method = opts.method ?? 'GET';
  const canRetry = method === 'GET' || Boolean(opts.idempotencyKey);
  const maxRetries = canRetry ? (opts.retries ?? 2) : 0;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    ...opts.headers,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(MP_BASE + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
        redirect: 'error',
      });
    } catch {
      if (attempt < maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new MpApiError(0, 'network');
    }

    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      await sleep(backoff(attempt));
      continue;
    }
    let code = `http_${res.status}`;
    try {
      const err = (await res.json()) as { errors?: { code?: string }[]; error?: string; code?: string };
      code = String(err.errors?.[0]?.code ?? err.code ?? err.error ?? code).slice(0, 80);
    } catch {
      /* cuerpo no JSON */
    }
    log.warn('mp.api_error', { path: path.split('?')[0], status: res.status, code });
    throw new MpApiError(res.status, code);
  }
}
