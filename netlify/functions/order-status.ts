/**
 * GET /api/orders/status?ref=W-... → estado de una compra web para la página de gracias.
 * La referencia tiene 128 bits aleatorios: no se puede adivinar ni enumerar.
 * Si la compra sigue pendiente, el servidor consulta a Mercado Pago (máx. cada 20 s).
 */
import type { Config } from '@netlify/functions';
import { db } from '../../src/lib/db.js';
import { assertMethod, clientIp, handle, HttpError, json } from '../../src/lib/http.js';
import { rateLimit } from '../../src/lib/rate-limit.js';
import { publicRefSchema } from '../../src/lib/validation.js';
import { getPublicStatus, recheckPendingWebOrder } from '../../src/services/orders.js';

export default handle('order-status', async (req, context) => {
  assertMethod(req, 'GET');
  await rateLimit(db(), 'order-status', clientIp(context), 120, 600);
  const ref = new URL(req.url).searchParams.get('ref') ?? '';
  if (!publicRefSchema.safeParse(ref).success) throw new HttpError(400, 'Referencia inválida', 'bad_ref');
  let status = await getPublicStatus(ref);
  if (!status) throw new HttpError(404, 'No encontramos esa compra', 'not_found');
  if (status === 'pending' && (await recheckPendingWebOrder(ref))) status = (await getPublicStatus(ref)) ?? status;
  return json({ status });
});

export const config: Config = { path: '/api/orders/status', method: 'GET' };
