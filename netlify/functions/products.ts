/**
 * GET /api/products → catálogo público para la landing.
 * No expone el stock exacto: solo si hay y si quedan pocas unidades.
 * Se cachea en la CDN y se invalida cuando cambia el stock (ver src/lib/cdn.ts).
 */
import type { Config } from '@netlify/functions';
import { env } from '../../src/config/env.js';
import { catalogCacheHeaders } from '../../src/lib/cdn.js';
import { db } from '../../src/lib/db.js';
import { assertMethod, handle, json } from '../../src/lib/http.js';
import { centsToAmount } from '../../src/lib/money.js';
import { computeAvailability, loadCatalog } from '../../src/services/inventory.js';

export default handle('products', async (req) => {
  assertMethod(req, 'GET');
  const catalog = await loadCatalog(db());
  const availability = computeAvailability(catalog);
  const onlineEnabled = env().ONLINE_CHECKOUT_ENABLED;
  const products = [...catalog.products.values()]
    .filter((p) => p.active)
    .map((p) => {
      const units = availability.get(p.sku) ?? 0;
      return {
        sku: p.sku,
        name: p.name,
        price: p.price_cents > 0 ? centsToAmount(p.price_cents) : null,
        available: units > 0,
        lowStock: units > 0 && units <= 3,
        buyOnline: onlineEnabled && p.sell_online && p.price_cents > 0 && units > 0,
        mercadoLibreUrl: p.ml_permalink,
      };
    });
  return json({ products }, 200, catalogCacheHeaders);
});

export const config: Config = { path: '/api/products', method: 'GET' };
