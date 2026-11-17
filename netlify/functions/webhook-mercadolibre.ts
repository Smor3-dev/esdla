/**
 * POST /api/webhooks/mercadolibre  (URL de notificaciones de la app en el DevCenter, tópico orders_v2)
 *
 * Mercado Libre exige un 200 en menos de 500 ms. Por eso esta función solo valida
 * (IP de origen + cuerpo) y responde; la consulta a la API y la actualización de
 * stock siguen con context.waitUntil. Si algo falla, la tarea programada reintenta.
 */
import type { Config, Context } from '@netlify/functions';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { clientIp, json, readText, safeJsonParse } from '../../src/lib/http.js';
import { log } from '../../src/lib/logger.js';
import { checkMlNotification, ipAllowed } from '../../src/integrations/mercadolibre/notifications.js';
import { processMlEvent } from '../../src/services/sync.js';

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let e;
  try {
    e = env();
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
  if (!e.ML_CLIENT_ID) return json({ error: 'unavailable' }, 503);

  const ip = clientIp(context);
  if (!ipAllowed(ip, e.mlAllowedIps)) {
    log.security('ml.webhook_ip_rejected', { ip });
    return json({ error: 'forbidden' }, 403);
  }

  let body: unknown;
  try {
    body = safeJsonParse(await readText(req, 8 * 1024));
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const check = checkMlNotification(body, { appId: e.ML_CLIENT_ID, sellerId: e.ML_SELLER_USER_ID });
  if (!check.ok) {
    if (check.reason !== 'ignored_topic') log.security('ml.webhook_rejected', { reason: check.reason });
    return json({ ok: true }); // 200 igual: no hay nada para reintentar
  }

  context.waitUntil(
    (async () => {
      try {
        const inserted = await db()`
          insert into webhook_events (provider, event_key, resource)
          values ('mercadolibre', ${check.eventKey}, ${`/orders/${check.orderId}`})
          on conflict do nothing returning event_key`;
        if (inserted.length === 0) return; // notificación repetida
        await processMlEvent(check.eventKey, check.orderId);
      } catch (err) {
        log.error('ml.webhook_processing_failed', { err, orderId: check.orderId });
      }
    })(),
  );
  return json({ ok: true });
};

export const config: Config = { path: '/api/webhooks/mercadolibre', method: 'POST' };
