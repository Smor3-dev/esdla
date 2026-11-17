/**
 * Utilidades HTTP comunes a todas las funciones: respuestas JSON con cabeceras
 * de seguridad, lectura acotada del body, validación con zod y manejo de errores
 * sin filtrar detalles internos al cliente.
 */
import type { Context } from '@netlify/functions';
import { z } from 'zod';
import { ConfigError } from '../config/env.js';
import { log } from './logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly code = 'error',
  ) {
    super(publicMessage);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

/** Las cabeceras extra reemplazan a las base, salvo Set-Cookie que se acumula. */
function merge(base: Headers, extra: HeadersInit): Headers {
  const cookies: string[] = [];
  if (Array.isArray(extra)) {
    for (const [k, v] of extra) (k.toLowerCase() === 'set-cookie' ? cookies.push(v) : base.set(k, v));
  } else if (extra instanceof Headers) {
    extra.forEach((v, k) => (k === 'set-cookie' ? cookies.push(v) : base.set(k, v)));
  } else {
    for (const [k, v] of Object.entries(extra)) (k.toLowerCase() === 'set-cookie' ? cookies.push(v) : base.set(k, v));
  }
  for (const c of cookies) base.append('Set-Cookie', c);
  return base;
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: merge(new Headers(BASE_HEADERS), headers) });
}

export function redirect(location: string, headers: HeadersInit = {}): Response {
  const base = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  return new Response(null, { status: 302, headers: merge(base, headers) });
}

export function assertMethod(req: Request, ...allowed: string[]): void {
  if (!allowed.includes(req.method)) throw new HttpError(405, 'Método no permitido', 'method_not_allowed');
}

/** Lee el body como texto con un tope de tamaño (por defecto 16 KB). */
export async function readText(req: Request, maxBytes = 16 * 1024): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'Solicitud demasiado grande', 'too_large');
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new HttpError(413, 'Solicitud demasiado grande', 'too_large');
  return text;
}

/** JSON.parse que descarta claves peligrosas para prototype pollution. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text, (key, value) => (key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value));
  } catch {
    throw new HttpError(400, 'JSON inválido', 'invalid_json');
  }
}

/** Exige Content-Type JSON, limita tamaño y valida contra el esquema (estricto). */
export async function readJson<T extends z.ZodType>(req: Request, schema: T, maxBytes?: number): Promise<z.output<T>> {
  const type = req.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new HttpError(415, 'Se espera application/json', 'unsupported_media_type');
  const parsed = schema.safeParse(safeJsonParse(await readText(req, maxBytes)));
  if (!parsed.success) {
    throw new HttpError(400, 'Datos inválidos', 'validation_error');
  }
  return parsed.data;
}

export function clientIp(context: Context): string {
  return typeof context.ip === 'string' && context.ip.length > 0 ? context.ip : '0.0.0.0';
}

type Handler = (req: Request, context: Context) => Promise<Response>;

/** Envuelve un handler: errores controlados → JSON genérico; errores inesperados → 500 sin detalles. */
export function handle(name: string, fn: Handler): Handler {
  return async (req, context) => {
    try {
      return await fn(req, context);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status >= 500) log.error(`${name}.http_error`, { status: err.status, code: err.code });
        return json({ error: err.code, message: err.publicMessage }, err.status);
      }
      if (err instanceof ConfigError) {
        log.error(`${name}.config_error`, { message: err.message });
        return json({ error: 'unavailable', message: 'Servicio no disponible' }, 503);
      }
      log.error(`${name}.unhandled`, { err, requestId: context?.requestId });
      return json({ error: 'internal', message: 'Error interno' }, 500);
    }
  };
}
