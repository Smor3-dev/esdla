/**
 * POST /api/webhooks/mercadopago  (configurar en Tus integraciones → Webhooks, evento "Order (Mercado Pago)")
 *
 * 1. Verifica la firma x-signature (HMAC-SHA256 con la clave secreta del webhook).
 * 2. Ignora eventos que no son de órdenes.
 * 3. NO confía en el cuerpo: consulta la order a la API con nuestro token y concilia.
 * 4. Responde 200 si todo salió bien; 5xx si hubo un error transitorio para que MP reintente.
 */
import type { Config } from '@netlify/functions';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { assertMethod, handle, json, readText, safeJsonParse } from '../../src/lib/http.js';
import { log } from '../../src/lib/logger.js';
import { mpOrderIdSchema } from '../../src/lib/validation.js';
import { MpApiError } from '../../src/integrations/mercadopago/client.js';
import { getOrder } from '../../src/integrations/mercadopago/orders.js';
import { verifyMpSignature } from '../../src/integrations/mercadopago/webhook-signature.js';
import { syncFromMpOrder } from '../../src/services/orders.js';
import { processMlOutbox } from '../../src/services/sync.js';

interface MpNotificationBody {
  type?: unknown;
  action?: unknown;
  data?: { id?: unknown };
}

export default handle('webhook.mercadopago', async (req) => {
  assertMethod(req, 'POST');
  const e = env();
  const url = new URL(req.url);
  const raw = await readText(req, 64 * 1024);
  const body = (raw ? safeJsonParse(raw) : {}) as MpNotificationBody;

  const type = url.searchParams.get('type') ?? url.searchParams.get('topic') ?? (typeof body.type === 'string' ? body.type : '');
  const dataId = url.searchParams.get('data.id') ?? (typeof body.data?.id === 'string' ? body.data.id : undefined);
  const requestId = req.headers.get('x-request-id');

  const sig = verifyMpSignature({
    xSignature: req.headers.get('x-signature'),
    xRequestId: requestId,
    dataId,
    secrets: e.mpWebhookSecrets,
  });
  if (!sig.ok) {
    if (sig.reason !== 'missing' || e.MP_REQUIRE_SIGNATURE) {
      log.security('mp.webhook_rejected', { reason: sig.reason, requestId });
      return json({ error: 'invalid_signature' }, 401);
    }
    // Sin firma y MP_REQUIRE_SIGNATURE=false: se trata como un simple aviso (se verifica contra la API).
    log.warn('mp.webhook_unsigned', { requestId });
  }

  if (type !== 'order' || !dataId || !mpOrderIdSchema.safeParse(dataId).success) {
    return json({ ok: true, ignored: true });
  }

  const action = typeof body.action === 'string' ? body.action.slice(0, 40) : '';
  const eventKey = `${dataId}:${action}:${(requestId ?? '').slice(0, 80)}`;
  await db()`
    insert into webhook_events (provider, event_key, resource)
    values ('mercadopago', ${eventKey}, ${dataId}) on conflict do nothing`;

  const local = await db()<{ channel: string }[]>`select channel from orders where provider_order_id = ${dataId}`;
  let order;
  try {
    order = await getOrder(dataId, local[0]?.channel === 'pos' ? 'pos' : 'online');
  } catch (err) {
    if (err instanceof MpApiError && (err.status === 404 || err.status === 403)) {
      await db()`update webhook_events set status = 'ignored', processed_at = now() where provider = 'mercadopago' and event_key = ${eventKey}`;
      return json({ ok: true, ignored: true });
    }
    throw err; // 5xx → Mercado Pago reintenta
  }

  const res = await syncFromMpOrder(order);
  await db()`
    update webhook_events
    set status = ${res.result === 'updated' || res.result === 'unchanged' ? 'processed' : 'ignored'},
        attempts = attempts + 1, processed_at = now()
    where provider = 'mercadopago' and event_key = ${eventKey}`;
  if (res.result !== 'unchanged') log.info('mp.webhook', { orderId: dataId, result: res.result });
  if (res.changedSkus.length) await processMlOutbox({ onlySkus: res.changedSkus }).catch(() => undefined);
  return json({ ok: true });
});

export const config: Config = { path: '/api/webhooks/mercadopago', method: 'POST' };
