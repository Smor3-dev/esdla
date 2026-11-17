/**
 * Datos del panel admin.
 *   GET  /api/admin/orders                 → pedidos web pagados (con contacto descifrado)
 *   GET  /api/admin/products               → catálogo con stock real y vínculo a Mercado Libre
 *   POST /api/admin/products/:sku/stock    → fijar stock (queda registrado y se sincroniza a ML)
 *   POST /api/admin/products/:sku/ml       → vincular un SKU con una publicación de ML
 *   GET  /api/admin/integrations           → estado de Mercado Libre, caja de MP y sincronización
 *   POST /api/admin/integrations/sync      → correr la sincronización ahora (y refrescar el catálogo de la web)
 */
import type { Config } from '@netlify/functions';
import { env } from '../../src/config/env.js';
import { audit } from '../../src/lib/audit.js';
import { purgeCatalogCache } from '../../src/lib/cdn.js';
import { randomToken } from '../../src/lib/crypto.js';
import { assertSameSiteRequest } from '../../src/lib/csrf.js';
import { db } from '../../src/lib/db.js';
import { handle, HttpError, json, readJson } from '../../src/lib/http.js';
import { requireAdmin } from '../../src/lib/session.js';
import { mlMappingSchema, skuSchema, stockAdjustSchema } from '../../src/lib/validation.js';
import { getConnection } from '../../src/integrations/mercadolibre/oauth.js';
import { getMlItem } from '../../src/integrations/mercadolibre/resources.js';
import { computeAvailability, enqueueMlSync, loadCatalog, setStock } from '../../src/services/inventory.js';
import { listWebOrdersForAdmin } from '../../src/services/orders.js';
import { processMlOutbox, runMaintenance } from '../../src/services/sync.js';

export default handle('admin.data', async (req, context) => {
  requireAdmin(req);
  const { pathname } = new URL(req.url);
  const sql = db();

  if (req.method === 'GET') {
    if (pathname === '/api/admin/orders') return json({ orders: await listWebOrdersForAdmin() });

    if (pathname === '/api/admin/products') {
      const catalog = await loadCatalog(sql);
      const availability = computeAvailability(catalog);
      const outbox = await sql<{ sku: string; attempts: number; last_error: string | null }[]>`select sku, attempts, last_error from ml_stock_outbox`;
      return json({
        products: [...catalog.products.values()].map((p) => ({
          sku: p.sku,
          name: p.name,
          priceCents: p.price_cents,
          stock: p.is_bundle ? null : p.stock,
          available: availability.get(p.sku) ?? 0,
          isBundle: p.is_bundle,
          active: p.active,
          sellOnline: p.sell_online,
          mlItemId: p.ml_item_id,
          mlVariationId: p.ml_variation_id,
          mlPending: outbox.find((o) => o.sku === p.sku) ?? null,
        })),
      });
    }

    if (pathname === '/api/admin/integrations') {
      const e = env();
      const conn = await getConnection();
      const state = await sql<{ key: string; value: unknown }[]>`select key, value from app_state where key in ('mp_pos', 'last_maintenance')`;
      const outbox = await sql<{ n: number }[]>`select count(*)::int as n from ml_stock_outbox`;
      const failed = await sql<{ n: number }[]>`select count(*)::int as n from webhook_events where status = 'failed'`;
      return json({
        mercadolibre: {
          configured: Boolean(e.ML_CLIENT_ID && e.ML_CLIENT_SECRET && e.ML_REDIRECT_URI),
          connected: conn?.status === 'active',
          status: conn?.status ?? 'disconnected',
          accountId: conn?.account_id ?? null,
          tokenExpiresAt: conn?.expires_at ?? null,
        },
        mercadopago: {
          configured: Boolean(e.MP_ACCESS_TOKEN),
          separatePosApp: Boolean(e.MP_POS_ACCESS_TOKEN && e.MP_POS_ACCESS_TOKEN !== e.MP_ACCESS_TOKEN),
          webhookSecrets: e.mpWebhookSecrets.length,
          pos: state.find((s) => s.key === 'mp_pos')?.value ?? null,
          pointTerminal: Boolean(e.MP_POINT_TERMINAL_ID),
          onlineCheckout: e.ONLINE_CHECKOUT_ENABLED,
        },
        sync: {
          pendingStockPushes: outbox[0]?.n ?? 0,
          failedWebhooks: failed[0]?.n ?? 0,
          lastMaintenance: state.find((s) => s.key === 'last_maintenance')?.value ?? null,
        },
      });
    }
    throw new HttpError(404, 'Ruta inexistente', 'not_found');
  }

  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido', 'method_not_allowed');
  assertSameSiteRequest(req);

  if (pathname === '/api/admin/integrations/sync') {
    const report = await runMaintenance(Date.now() + 20_000);
    await purgeCatalogCache(); // también refresca la web si se cambiaron precios a mano
    return json({ report });
  }

  const sku = context.params?.sku ?? '';
  if (!skuSchema.safeParse(sku).success) throw new HttpError(400, 'SKU inválido', 'bad_sku');

  if (pathname.endsWith('/stock')) {
    const { stock } = await readJson(req, stockAdjustSchema, 512);
    const ref = `adj-${randomToken(9)}`;
    const result = await sql.begin(async (tx) => {
      const r = await setStock(tx, sku, stock, ref).catch((err: Error) => {
        throw new HttpError(400, err.message, 'bad_request');
      });
      await enqueueMlSync(tx, [sku]);
      return r;
    });
    await audit('admin', 'stock_set', { sku, from: result.previous, to: stock });
    await purgeCatalogCache();
    await processMlOutbox({ onlySkus: [sku] }).catch(() => undefined);
    return json({ ok: true, sku, stock });
  }

  if (pathname.endsWith('/ml')) {
    const { mlItemId, mlVariationId } = await readJson(req, mlMappingSchema, 512);
    const conn = await getConnection();
    if (conn?.status !== 'active') throw new HttpError(409, 'Conectá Mercado Libre primero', 'ml_not_connected');
    const item = await getMlItem(mlItemId);
    if (item.seller_id !== conn.account_id) throw new HttpError(403, 'Esa publicación no es de tu cuenta', 'not_owner');
    if (mlVariationId && !item.variations.some((v) => v.id === String(mlVariationId))) {
      throw new HttpError(400, 'Esa variación no existe en la publicación', 'bad_variation');
    }
    if (!mlVariationId && item.variations.length > 0) {
      throw new HttpError(400, 'La publicación tiene variaciones: indicá cuál corresponde a este SKU', 'variation_required');
    }
    const permalink = item.permalink?.startsWith('https://') ? item.permalink : null;
    await sql`
      update products set ml_item_id = ${mlItemId}, ml_variation_id = ${mlVariationId ?? null},
        ml_permalink = ${permalink}, updated_at = now()
      where sku = ${sku}`;
    await enqueueMlSync(sql, [sku]);
    await purgeCatalogCache();
    await audit('admin', 'ml_mapped', { sku, mlItemId });
    return json({ ok: true, sku, mlItemId, permalink });
  }

  throw new HttpError(404, 'Ruta inexistente', 'not_found');
});

export const config: Config = {
  path: [
    '/api/admin/orders',
    '/api/admin/products',
    '/api/admin/products/:sku/stock',
    '/api/admin/products/:sku/ml',
    '/api/admin/integrations',
    '/api/admin/integrations/sync',
  ],
};
