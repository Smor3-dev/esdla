/**
 * Inventario único para los tres canales (web, caja y Mercado Libre).
 * - Los bundles (Box ESDLA) se expanden a sus componentes.
 * - Cada movimiento es idempotente: (canal, referencia, sku, motivo) es único.
 * - Después de mover stock se encola la actualización hacia Mercado Libre.
 */
import type { Db, Tx } from '../lib/db.js';
import { log } from '../lib/logger.js';

export interface ProductRow {
  sku: string;
  name: string;
  price_cents: number;
  stock: number;
  is_bundle: boolean;
  active: boolean;
  sell_online: boolean;
  ml_item_id: string | null;
  ml_variation_id: string | null;
  ml_permalink: string | null;
}

export interface ComponentRow {
  bundle_sku: string;
  component_sku: string;
  quantity: number;
}

export interface Catalog {
  products: Map<string, ProductRow>;
  components: ComponentRow[];
}

export async function loadCatalog(sql: Db, opts: { lock?: boolean } = {}): Promise<Catalog> {
  const rows = opts.lock
    ? await sql<ProductRow[]>`
        select sku, name, price_cents, stock, is_bundle, active, sell_online,
               ml_item_id, ml_variation_id::text as ml_variation_id, ml_permalink
        from products order by sku for update`
    : await sql<ProductRow[]>`
        select sku, name, price_cents, stock, is_bundle, active, sell_online,
               ml_item_id, ml_variation_id::text as ml_variation_id, ml_permalink
        from products order by sku`;
  const components = await sql<ComponentRow[]>`select bundle_sku, component_sku, quantity from bundle_components`;
  return { products: new Map(rows.map((r) => [r.sku, r])), components: [...components] };
}

/** Convierte una lista de ítems (con bundles) en cantidades por SKU físico. */
export function expandToComponents(
  items: { sku: string; quantity: number }[],
  catalog: Catalog,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const { sku, quantity } of items) {
    const product = catalog.products.get(sku);
    if (!product) throw new Error(`SKU desconocido: ${sku}`);
    if (product.is_bundle) {
      const parts = catalog.components.filter((c) => c.bundle_sku === sku);
      if (parts.length === 0) throw new Error(`El bundle ${sku} no tiene componentes`);
      for (const part of parts) out.set(part.component_sku, (out.get(part.component_sku) ?? 0) + part.quantity * quantity);
    } else {
      out.set(sku, (out.get(sku) ?? 0) + quantity);
    }
  }
  return out;
}

/** Unidades vendibles: stock propio, o para un bundle cuántos se pueden armar. */
export function computeAvailability(catalog: Catalog): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of catalog.products.values()) {
    if (!p.is_bundle) {
      out.set(p.sku, Math.max(0, p.stock));
      continue;
    }
    const parts = catalog.components.filter((c) => c.bundle_sku === p.sku);
    const possible = parts.map((c) => Math.floor(Math.max(0, catalog.products.get(c.component_sku)?.stock ?? 0) / c.quantity));
    out.set(p.sku, parts.length ? Math.min(...possible) : 0);
  }
  return out;
}

export type StockSource = 'web' | 'pos' | 'mercadolibre' | 'admin';

/**
 * Aplica una venta o una reposición. Si ya se aplicó para esa referencia, no hace nada.
 * Devuelve los SKUs físicos que efectivamente cambiaron.
 */
export async function applyStockMovement(
  tx: Tx,
  args: { source: StockSource; sourceRef: string; reason: 'sale' | 'restock'; items: { sku: string; quantity: number }[] },
): Promise<string[]> {
  if (args.items.length === 0) return [];
  const catalog = await loadCatalog(tx, { lock: true });
  const expanded = expandToComponents(args.items, catalog);
  const changed: string[] = [];
  for (const [sku, qty] of expanded) {
    const delta = args.reason === 'sale' ? -qty : qty;
    const inserted = await tx`
      insert into stock_movements (sku, delta, reason, source, source_ref)
      values (${sku}, ${delta}, ${args.reason}, ${args.source}, ${args.sourceRef})
      on conflict (source, source_ref, sku, reason) do nothing
      returning id`;
    if (inserted.length === 0) continue;
    const updated = await tx<{ stock: number }[]>`
      update products set stock = stock + ${delta}, updated_at = now() where sku = ${sku} returning stock`;
    const stock = updated[0]?.stock ?? 0;
    if (stock < 0) log.warn('stock.negative', { sku, stock, source: args.source });
    changed.push(sku);
  }
  return changed;
}

/** Ajuste manual desde el panel: fija el stock absoluto y deja registro. */
export async function setStock(tx: Tx, sku: string, newStock: number, ref: string): Promise<{ previous: number }> {
  const rows = await tx<{ stock: number; is_bundle: boolean }[]>`select stock, is_bundle from products where sku = ${sku} for update`;
  const row = rows[0];
  if (!row) throw new Error('SKU inexistente');
  if (row.is_bundle) throw new Error('El stock de un bundle se calcula desde sus componentes');
  const delta = newStock - row.stock;
  if (delta !== 0) {
    await tx`insert into stock_movements (sku, delta, reason, source, source_ref) values (${sku}, ${delta}, 'adjustment', 'admin', ${ref})`;
    await tx`update products set stock = ${newStock}, updated_at = now() where sku = ${sku}`;
  }
  return { previous: row.stock };
}

/** Encola la actualización a Mercado Libre de los SKUs afectados y de los bundles que los contienen. */
export async function enqueueMlSync(sql: Db, skus: string[]): Promise<void> {
  if (skus.length === 0) return;
  await sql`
    insert into ml_stock_outbox (sku)
    select p.sku from products p
    where p.ml_item_id is not null
      and (p.sku in ${sql(skus)}
           or p.sku in (select bundle_sku from bundle_components where component_sku in ${sql(skus)}))
    on conflict (sku) do update set requested_at = now(), next_attempt_at = now(), attempts = 0, last_error = null`;
}
