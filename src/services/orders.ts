/**
 * Ciclo de vida de las órdenes de los tres canales.
 * Regla de oro: los precios y el estado de pago salen SIEMPRE del servidor
 * (catálogo propio + API de Mercado Pago/Libre), nunca del navegador ni del webhook.
 */
import { purgeCatalogCache } from '../lib/cdn.js';
import { decrypt, encrypt, randomRef } from '../lib/crypto.js';
import { db, type Tx } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { amountToCents } from '../lib/money.js';
import type { CheckoutInput, PosChargeInput } from '../lib/validation.js';
import { publicRefSchema } from '../lib/validation.js';
import { getOrder, type LineItem, type MpOrder } from '../integrations/mercadopago/orders.js';
import type { MlOrder } from '../integrations/mercadolibre/resources.js';
import { applyStockMovement, computeAvailability, enqueueMlSync, expandToComponents, loadCatalog } from './inventory.js';

const MAX_ORDER_CENTS = 100_000_00; // $ 100.000 por orden: tope de cordura

export type LocalStatus = 'pending' | 'action_required' | 'paid' | 'canceled' | 'expired' | 'failed' | 'refunded';

interface OrderRow {
  id: string;
  public_ref: string;
  channel: 'web' | 'pos' | 'mercadolibre';
  status: LocalStatus;
  total_cents: number;
  provider_order_id: string | null;
  pos_method: string | null;
  stock_applied: boolean;
  stock_restored: boolean;
}

function priceLines(items: { sku: string; quantity: number }[], catalog: Awaited<ReturnType<typeof loadCatalog>>, online: boolean): LineItem[] {
  return items.map(({ sku, quantity }) => {
    const p = catalog.products.get(sku);
    if (!p || !p.active || p.price_cents <= 0 || (online && !p.sell_online)) {
      throw new HttpError(409, 'Uno de los productos no está disponible', 'unavailable');
    }
    return { sku, title: p.name, unitCents: p.price_cents, quantity };
  });
}

const totalOf = (lines: LineItem[]) => lines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);

/** Crea la orden local de una compra web (pendiente) con los datos del comprador cifrados. */
export async function createWebOrder(input: CheckoutInput): Promise<{ orderId: string; ref: string; totalCents: number; lines: LineItem[] }> {
  return db().begin(async (tx) => {
    const catalog = await loadCatalog(tx);
    const lines = priceLines(input.items, catalog, true);
    const availability = computeAvailability(catalog);
    for (const l of lines) {
      if ((availability.get(l.sku) ?? 0) < l.quantity) throw new HttpError(409, `No queda stock suficiente de ${l.title}`, 'out_of_stock');
    }
    // Un Box y una salsa suelta compiten por el mismo stock físico: se valida también expandido.
    for (const [sku, qty] of expandToComponents(input.items, catalog)) {
      if ((catalog.products.get(sku)?.stock ?? 0) < qty) throw new HttpError(409, 'No queda stock suficiente', 'out_of_stock');
    }
    const total = totalOf(lines);
    if (total <= 0 || total > MAX_ORDER_CENTS) throw new HttpError(400, 'Monto fuera de rango', 'bad_amount');

    const ref = randomRef('W');
    const customerEnc = encrypt(JSON.stringify(input.customer), `order:${ref}:customer`);
    const inserted = await tx<{ id: string }[]>`
      insert into orders (public_ref, channel, status, total_cents, customer_enc)
      values (${ref}, 'web', 'pending', ${total}, ${customerEnc}) returning id`;
    const orderId = inserted[0]!.id;
    for (const l of lines) {
      await tx`insert into order_items (order_id, sku, quantity, unit_price_cents) values (${orderId}, ${l.sku}, ${l.quantity}, ${l.unitCents})`;
    }
    return { orderId, ref, totalCents: total, lines };
  });
}

/** Crea la orden local de un cobro en la caja. En el puesto el stock es físico: no se bloquea la venta. */
export async function createPosOrder(input: PosChargeInput): Promise<{ orderId: string; ref: string; totalCents: number; lines: LineItem[]; lowStock: boolean }> {
  return db().begin(async (tx) => {
    const catalog = await loadCatalog(tx);
    const lines = priceLines(input.items, catalog, false);
    const total = totalOf(lines);
    if (total <= 0 || total > MAX_ORDER_CENTS) throw new HttpError(400, 'Monto fuera de rango', 'bad_amount');
    let lowStock = false;
    for (const [sku, qty] of expandToComponents(input.items, catalog)) {
      if ((catalog.products.get(sku)?.stock ?? 0) < qty) lowStock = true;
    }
    const ref = randomRef('P');
    const inserted = await tx<{ id: string }[]>`
      insert into orders (public_ref, channel, status, total_cents, pos_method)
      values (${ref}, 'pos', 'pending', ${total}, ${input.method}) returning id`;
    const orderId = inserted[0]!.id;
    for (const l of lines) {
      await tx`insert into order_items (order_id, sku, quantity, unit_price_cents) values (${orderId}, ${l.sku}, ${l.quantity}, ${l.unitCents})`;
    }
    return { orderId, ref, totalCents: total, lines, lowStock };
  });
}

export async function attachProviderOrder(orderId: string, providerOrderId: string): Promise<void> {
  await db()`update orders set provider_order_id = ${providerOrderId}, updated_at = now() where id = ${orderId} and provider_order_id is null`;
}

export async function markOrderFailed(orderId: string): Promise<void> {
  await db()`update orders set status = 'failed', updated_at = now() where id = ${orderId} and status = 'pending'`;
}

/** Traduce el estado de una order de Mercado Pago al estado local. */
export function mapMpStatus(order: Pick<MpOrder, 'status' | 'status_detail'>): LocalStatus {
  switch (order.status) {
    case 'processed':
      return order.status_detail === 'refunded' ? 'refunded' : 'paid'; // partially_refunded sigue pagada
    case 'refunded':
      return 'refunded';
    case 'canceled':
      return 'canceled';
    case 'expired':
      return 'expired';
    case 'failed':
      return 'failed';
    case 'action_required':
      return 'action_required';
    default:
      return 'pending'; // created, at_terminal, etc.
  }
}

const parseCents = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  try {
    return amountToCents(v);
  } catch {
    return null;
  }
};

async function applySaleOnce(tx: Tx, o: OrderRow, source: 'web' | 'pos' | 'mercadolibre'): Promise<string[]> {
  if (o.stock_applied) return [];
  const items = await tx<{ sku: string; quantity: number }[]>`select sku, quantity from order_items where order_id = ${o.id}`;
  const changed = await applyStockMovement(tx, { source, sourceRef: o.public_ref, reason: 'sale', items: [...items] });
  await tx`update orders set stock_applied = true where id = ${o.id}`;
  return changed;
}

async function restockOnce(tx: Tx, o: OrderRow, source: 'web' | 'pos' | 'mercadolibre'): Promise<string[]> {
  if (!o.stock_applied || o.stock_restored) return [];
  const items = await tx<{ sku: string; quantity: number }[]>`select sku, quantity from order_items where order_id = ${o.id}`;
  const changed = await applyStockMovement(tx, { source, sourceRef: o.public_ref, reason: 'restock', items: [...items] });
  await tx`update orders set stock_restored = true where id = ${o.id}`;
  return changed;
}

export type SyncResult = { result: 'updated' | 'unchanged' | 'unknown' | 'mismatch'; changedSkus: string[] };

/**
 * Aplica a la orden local el estado REAL de una order de Mercado Pago (obtenida con
 * GET /v1/orders/{id} usando nuestro token). Verifica referencia, id y montos.
 */
export async function syncFromMpOrder(mp: MpOrder): Promise<SyncResult> {
  const res = await applyMpOrder(mp);
  if (res.changedSkus.length) await purgeCatalogCache();
  return res;
}

async function applyMpOrder(mp: MpOrder): Promise<SyncResult> {
  const ref = mp.external_reference;
  if (!ref || !publicRefSchema.safeParse(ref).success) return { result: 'unknown', changedSkus: [] };

  return db().begin(async (tx) => {
    const rows = await tx<OrderRow[]>`
      select id, public_ref, channel, status, total_cents, provider_order_id, pos_method, stock_applied, stock_restored
      from orders where public_ref = ${ref} and channel in ('web', 'pos') for update`;
    const o = rows[0];
    if (!o) return { result: 'unknown', changedSkus: [] };
    if (o.provider_order_id && o.provider_order_id !== mp.id) {
      log.security('mp.order_id_mismatch', { ref, expected: o.provider_order_id, got: mp.id });
      return { result: 'mismatch', changedSkus: [] };
    }
    const amount = parseCents(mp.total_amount ?? mp.transactions?.payments?.[0]?.amount);
    if (amount !== o.total_cents) {
      log.security('mp.amount_mismatch', { ref, expected: o.total_cents, got: amount });
      return { result: 'mismatch', changedSkus: [] };
    }
    if (!o.provider_order_id) await tx`update orders set provider_order_id = ${mp.id} where id = ${o.id}`;

    const next = mapMpStatus(mp);
    let changed: string[] = [];
    let updated = false;

    if (next === 'paid' && o.status !== 'paid' && o.status !== 'refunded') {
      const paid = parseCents(mp.total_paid_amount);
      if (paid !== null && paid < o.total_cents) {
        log.security('mp.underpaid', { ref, expected: o.total_cents, paid });
        return { result: 'mismatch', changedSkus: [] };
      }
      await tx`update orders set status = 'paid', paid_at = now(), updated_at = now() where id = ${o.id}`;
      changed = await applySaleOnce(tx, o, o.channel === 'pos' ? 'pos' : 'web');
      updated = true;
    } else if (next === 'refunded' && o.status === 'paid') {
      await tx`update orders set status = 'refunded', updated_at = now() where id = ${o.id}`;
      changed = await restockOnce(tx, o, o.channel === 'pos' ? 'pos' : 'web');
      updated = true;
    } else if (
      (next === 'canceled' || next === 'expired' || next === 'failed' || next === 'action_required') &&
      (o.status === 'pending' || o.status === 'action_required') &&
      next !== o.status
    ) {
      await tx`update orders set status = ${next}, updated_at = now() where id = ${o.id}`;
      updated = true;
    }

    if (changed.length) await enqueueMlSync(tx, changed);
    return { result: updated ? 'updated' : 'unchanged', changedSkus: changed };
  });
}

/** Registra una venta de Mercado Libre (ya pagada) y descuenta el stock propio. */
export async function syncFromMlOrder(ml: MlOrder, sellerId: string): Promise<SyncResult> {
  const res = await applyMlOrder(ml, sellerId);
  if (res.changedSkus.length) await purgeCatalogCache();
  return res;
}

async function applyMlOrder(ml: MlOrder, sellerId: string): Promise<SyncResult> {
  if (ml.seller.id !== sellerId) {
    log.security('ml.seller_mismatch', { orderId: ml.id });
    return { result: 'mismatch', changedSkus: [] };
  }
  const ref = `ML-${ml.id}`;

  return db().begin(async (tx) => {
    const rows = await tx<OrderRow[]>`
      select id, public_ref, channel, status, total_cents, provider_order_id, pos_method, stock_applied, stock_restored
      from orders where public_ref = ${ref} for update`;
    let o = rows[0];

    if (ml.status === 'paid') {
      if (o?.status === 'paid' && o.stock_applied) return { result: 'unchanged', changedSkus: [] };
      const catalog = await loadCatalog(tx);
      const bySku = new Map<string, { quantity: number; unitCents: number }>();
      for (const line of ml.order_items) {
        const variation = line.item.variation_id == null ? null : String(line.item.variation_id);
        const product =
          [...catalog.products.values()].find(
            (p) => p.ml_item_id === line.item.id && (p.ml_variation_id === null || p.ml_variation_id === variation),
          ) ?? (line.item.seller_sku ? catalog.products.get(line.item.seller_sku.toUpperCase()) : undefined);
        if (!product) {
          log.warn('ml.unmapped_item', { orderId: ml.id, itemId: line.item.id });
          continue;
        }
        const prev = bySku.get(product.sku);
        bySku.set(product.sku, {
          quantity: (prev?.quantity ?? 0) + line.quantity,
          unitCents: Math.round(line.unit_price * 100),
        });
      }
      if (bySku.size === 0) return { result: 'unknown', changedSkus: [] };

      if (!o) {
        const total = ml.total_amount !== undefined ? Math.round(ml.total_amount * 100) : 0;
        const inserted = await tx<OrderRow[]>`
          insert into orders (public_ref, channel, status, total_cents, provider_order_id, paid_at)
          values (${ref}, 'mercadolibre', 'paid', ${total}, ${ml.id}, now())
          returning id, public_ref, channel, status, total_cents, provider_order_id, pos_method, stock_applied, stock_restored`;
        o = inserted[0]!;
        for (const [sku, v] of bySku) {
          await tx`insert into order_items (order_id, sku, quantity, unit_price_cents) values (${o.id}, ${sku}, ${v.quantity}, ${v.unitCents})`;
        }
      } else {
        await tx`update orders set status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now() where id = ${o.id}`;
      }
      const changed = await applySaleOnce(tx, o, 'mercadolibre');
      if (changed.length) await enqueueMlSync(tx, changed);
      return { result: 'updated', changedSkus: changed };
    }

    if (ml.status === 'cancelled' && o && o.status === 'paid') {
      await tx`update orders set status = 'canceled', updated_at = now() where id = ${o.id}`;
      const changed = await restockOnce(tx, o, 'mercadolibre');
      if (changed.length) await enqueueMlSync(tx, changed);
      return { result: 'updated', changedSkus: changed };
    }
    return { result: 'unchanged', changedSkus: [] };
  });
}

/**
 * Compra web todavía pendiente: el webhook puede demorar, así que la página de gracias
 * pide consultar a Mercado Pago directamente. Como máximo una consulta cada 20 s por
 * compra (el UPDATE condicional hace de candado). Nunca lanza.
 */
export async function recheckPendingWebOrder(ref: string): Promise<boolean> {
  const rows = await db()<{ provider_order_id: string }[]>`
    update orders set mp_checked_at = now()
    where public_ref = ${ref} and channel = 'web' and status = 'pending' and provider_order_id is not null
      and created_at < now() - interval '15 seconds'
      and (mp_checked_at is null or mp_checked_at < now() - interval '20 seconds')
    returning provider_order_id`;
  const id = rows[0]?.provider_order_id;
  if (!id) return false;
  try {
    return (await syncFromMpOrder(await getOrder(id, 'online'))).result === 'updated';
  } catch (err) {
    log.warn('order.recheck_failed', { err });
    return false;
  }
}

export async function getPublicStatus(ref: string): Promise<LocalStatus | null> {
  const rows = await db()<{ status: LocalStatus }[]>`select status from orders where public_ref = ${ref} and channel = 'web'`;
  return rows[0]?.status ?? null;
}

export interface AdminOrderView {
  ref: string;
  status: LocalStatus;
  totalCents: number;
  createdAt: Date;
  paidAt: Date | null;
  items: { sku: string; quantity: number }[];
  customer: unknown;
}

/** Pedidos web pagados para preparar y entregar (descifra el contacto solo para el admin). */
export async function listWebOrdersForAdmin(limit = 50): Promise<AdminOrderView[]> {
  const rows = await db()<{
    id: string;
    public_ref: string;
    status: LocalStatus;
    total_cents: number;
    customer_enc: string | null;
    created_at: Date;
    paid_at: Date | null;
  }[]>`
    select id, public_ref, status, total_cents, customer_enc, created_at, paid_at
    from orders where channel = 'web' and status in ('paid', 'refunded', 'action_required')
    order by created_at desc limit ${limit}`;
  if (rows.length === 0) return [];
  const items = await db()<{ order_id: string; sku: string; quantity: number }[]>`
    select order_id, sku, quantity from order_items where order_id in ${db()(rows.map((r) => r.id))}`;
  return rows.map((r) => {
    let customer: unknown = null;
    try {
      customer = r.customer_enc ? JSON.parse(decrypt(r.customer_enc, `order:${r.public_ref}:customer`)) : null;
    } catch {
      customer = { error: 'No se pudo descifrar' };
    }
    return {
      ref: r.public_ref,
      status: r.status,
      totalCents: r.total_cents,
      createdAt: r.created_at,
      paidAt: r.paid_at,
      items: items.filter((i) => i.order_id === r.id).map((i) => ({ sku: i.sku, quantity: i.quantity })),
      customer,
    };
  });
}
