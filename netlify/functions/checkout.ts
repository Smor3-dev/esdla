/**
 * POST /api/checkout → crea la compra y devuelve la URL de pago de Mercado Pago.
 * El navegador solo manda SKU, cantidades y contacto; el precio lo pone el servidor.
 */
import type { Config } from '@netlify/functions';
import { env } from '../../src/config/env.js';
import { assertSameSiteRequest } from '../../src/lib/csrf.js';
import { db } from '../../src/lib/db.js';
import { assertMethod, clientIp, handle, HttpError, json, readJson } from '../../src/lib/http.js';
import { log } from '../../src/lib/logger.js';
import { rateLimit } from '../../src/lib/rate-limit.js';
import { checkoutSchema } from '../../src/lib/validation.js';
import { createOnlineOrder } from '../../src/integrations/mercadopago/orders.js';
import { attachProviderOrder, createWebOrder, markOrderFailed } from '../../src/services/orders.js';

export default handle('checkout', async (req, context) => {
  assertMethod(req, 'POST');
  assertSameSiteRequest(req);
  const e = env();
  if (!e.ONLINE_CHECKOUT_ENABLED) throw new HttpError(503, 'La compra online está en pausa. Escribinos por WhatsApp.', 'disabled');
  await rateLimit(db(), 'checkout', clientIp(context), 10, 600);

  const input = await readJson(req, checkoutSchema, 8 * 1024);
  const order = await createWebOrder(input);
  try {
    const mp = await createOnlineOrder({
      ref: order.ref,
      idempotencyKey: order.orderId,
      items: order.lines,
      totalCents: order.totalCents,
      siteUrl: e.SITE_URL,
    });
    await attachProviderOrder(order.orderId, mp.id);
    log.info('checkout.created', { ref: order.ref, totalCents: order.totalCents });
    return json({ checkoutUrl: mp.checkoutUrl, ref: order.ref }, 201);
  } catch (err) {
    await markOrderFailed(order.orderId);
    log.error('checkout.mp_failed', { ref: order.ref, err });
    throw new HttpError(502, 'No pudimos iniciar el pago. Probá de nuevo en un rato.', 'payment_unavailable');
  }
});

export const config: Config = {
  path: '/api/checkout',
  method: 'POST',
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
