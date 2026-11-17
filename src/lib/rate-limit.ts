/**
 * Límite de pedidos por IP (ventana fija) guardado en Postgres, para que valga
 * entre todas las instancias serverless. La IP se guarda hasheada.
 * Complementa el rate limiting nativo de Netlify (config.rateLimit).
 */
import { sha256Hex } from './crypto.js';
import type { Db } from './db.js';
import { HttpError } from './http.js';

export async function rateLimit(sql: Db, name: string, ip: string, limit: number, windowSeconds: number): Promise<void> {
  const bucket = `${name}:${sha256Hex(`rl:${ip}`).slice(0, 32)}`;
  const rows = await sql<{ count: number }[]>`
    insert into rate_limits (bucket, window_start, count)
    values (${bucket}, now(), 1)
    on conflict (bucket) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}::float8)
                   then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}::float8)
                   then now() else rate_limits.window_start end
    returning count`;
  if ((rows[0]?.count ?? 0) > limit) {
    throw new HttpError(429, 'Demasiados intentos. Probá de nuevo en unos minutos.', 'rate_limited');
  }
}
