/**
 * Verificación de la firma de los webhooks de Mercado Pago (header x-signature).
 *
 *   x-signature: ts=<timestamp>,v1=<hmac>
 *   manifest   : "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"  (se omite lo que falte)
 *   v1         : HMAC-SHA256(clave secreta del webhook, manifest) en hexadecimal
 *
 * Mismo algoritmo que WebhookSignatureValidator del SDK oficial (mercadopago v3.6).
 * Diferencias deliberadas, más tolerantes pero igual de seguras (siempre hace falta la clave):
 *  - Prueba data.id tal cual y en minúsculas: la doc de QR de Uruguay pide minúsculas y el SDK no.
 *  - Acepta varias claves a la vez para rotar la clave secreta sin perder notificaciones.
 *  - El ts puede venir en segundos o milisegundos (la doc muestra ambos).
 * Compara todo en tiempo constante y sin cortar antes (no filtra información por tiempos).
 */
import { hmacHex, safeEqual } from '../../lib/crypto.js';

export type SignatureResult =
  | { ok: true; ts: number; secretIndex: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'stale' };

function parseHeader(header: string): { ts?: string; v1?: string } {
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value.toLowerCase();
  }
  return { ts, v1 };
}

export function buildManifest(dataId: string | undefined, requestId: string | undefined, ts: string): string {
  const parts: string[] = [];
  if (dataId) parts.push(`id:${dataId}`);
  if (requestId) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${ts}`);
  return `${parts.join(';')};`;
}

export function verifyMpSignature(args: {
  xSignature: string | null | undefined;
  xRequestId: string | null | undefined;
  dataId: string | null | undefined;
  secrets: string[];
  nowMs?: number;
  /** 0 o undefined = no rechazar por antigüedad (los reintentos de MP pueden traer ts viejos). */
  toleranceSeconds?: number;
}): SignatureResult {
  const header = args.xSignature?.trim();
  if (!header) return { ok: false, reason: 'missing' };
  const { ts, v1 } = parseHeader(header);
  if (!ts || !/^\d{1,16}$/.test(ts) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'malformed' };

  const requestId = args.xRequestId?.trim() || undefined;
  const id = args.dataId?.trim() || undefined;
  const variants = id ? [...new Set([id, id.toLowerCase()])] : [undefined];

  let matched = -1;
  args.secrets.forEach((secret, index) => {
    for (const variant of variants) {
      const equal = safeEqual(hmacHex(secret, buildManifest(variant, requestId, ts)), v1);
      if (equal && matched === -1) matched = index;
    }
  });
  if (matched === -1) return { ok: false, reason: 'mismatch' };

  if (args.toleranceSeconds && args.toleranceSeconds > 0) {
    const tsMs = ts.length >= 13 ? Number(ts) : Number(ts) * 1000;
    const drift = Math.abs((args.nowMs ?? Date.now()) - tsMs) / 1000;
    if (drift > args.toleranceSeconds) return { ok: false, reason: 'stale' };
  }
  return { ok: true, ts: Number(ts), secretIndex: matched };
}
