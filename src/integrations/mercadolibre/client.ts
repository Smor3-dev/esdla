/** Cliente para la API de Mercado Libre con el token del vendedor conectado. */
import { log } from '../../lib/logger.js';
import { getAccessToken, ML_API } from './oauth.js';

export class MlApiError extends Error {
  override name = 'MlApiError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Mercado Libre respondió ${status} (${code})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mlRequest<T = unknown>(path: string, opts: { method?: 'GET' | 'PUT' | 'POST'; body?: unknown } = {}): Promise<T> {
  if (!/^\/[A-Za-z0-9/_\-.?=&%:,]*$/.test(path) || path.includes('..')) throw new Error('Ruta de API inválida');
  const method = opts.method ?? 'GET';
  let { token } = await getAccessToken();

  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(ML_API + path, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch {
      if (attempt < 2 && method === 'GET') {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new MlApiError(0, 'network');
    }

    if (res.status === 401 && attempt === 0) {
      token = (await getAccessToken({ forceRefresh: true })).token;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const e = (await res.json()) as { error?: string; message?: string; cause?: { code?: string }[] };
        code = String(e.cause?.[0]?.code ?? e.error ?? code).slice(0, 80);
      } catch {
        /* sin cuerpo JSON */
      }
      log.warn('ml.api_error', { path: path.split('?')[0], status: res.status, code });
      throw new MlApiError(res.status, code);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new MlApiError(0, 'retries_exhausted');
}
