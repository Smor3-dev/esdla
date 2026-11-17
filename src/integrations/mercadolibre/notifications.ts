/**
 * Notificaciones de Mercado Libre. A diferencia de Mercado Pago, NO vienen
 * firmadas. Por eso la defensa es:
 *   1. Filtro por IP de origen (lista publicada por Mercado Libre).
 *   2. Validación estricta del cuerpo: application_id = nuestra app, user_id = nuestro vendedor,
 *      tópico permitido y recurso con formato exacto.
 *   3. Nunca se confía en el contenido: se consulta la orden a la API con nuestro token.
 */
import { z } from 'zod';

const notificationSchema = z.looseObject({
  _id: z.string().max(100).optional(),
  resource: z.string().max(200),
  user_id: z.union([z.number(), z.string()]).transform(String),
  topic: z.string().max(60),
  application_id: z.union([z.number(), z.string()]).transform(String),
  attempts: z.number().int().nonnegative().optional(),
  sent: z.string().max(40).optional(),
});

export type MlNotificationCheck =
  | { ok: true; topic: 'orders_v2'; orderId: string; eventKey: string }
  | { ok: false; reason: 'invalid_body' | 'wrong_app' | 'wrong_user' | 'ignored_topic' | 'bad_resource' };

export function checkMlNotification(body: unknown, expected: { appId: string; sellerId?: string }): MlNotificationCheck {
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: 'invalid_body' };
  const n = parsed.data;
  if (n.application_id !== expected.appId) return { ok: false, reason: 'wrong_app' };
  if (expected.sellerId && n.user_id !== expected.sellerId) return { ok: false, reason: 'wrong_user' };
  if (n.topic !== 'orders_v2') return { ok: false, reason: 'ignored_topic' };
  const m = /^\/orders\/(\d{6,20})$/.exec(n.resource);
  if (!m?.[1]) return { ok: false, reason: 'bad_resource' };
  const eventKey = `orders_v2:${m[1]}:${(n._id ?? n.sent ?? '').replace(/[^A-Za-z0-9:.-]/g, '').slice(0, 60)}`;
  return { ok: true, topic: 'orders_v2', orderId: m[1], eventKey };
}

/** IPv4 exacta contra la lista permitida. null = filtro desactivado. */
export function ipAllowed(ip: string, allowed: string[] | null): boolean {
  if (allowed === null) return true;
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return allowed.includes(normalized);
}
