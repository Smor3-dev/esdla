/**
 * Sincronización y tareas de mantenimiento:
 *  - Outbox de stock → Mercado Libre (con reintentos y backoff).
 *  - Procesamiento de notificaciones de Mercado Libre (también reintentos).
 *  - Conciliación: órdenes de MP pendientes y ventas de ML que se hayan perdido.
 */
import { env } from '../config/env.js';
import { db } from '../lib/db.js';
import { log } from '../lib/logger.js';
import { getOrder } from '../integrations/mercadopago/orders.js';
import { getAccessToken, getConnection, MlNotConnectedError } from '../integrations/mercadolibre/oauth.js';
import { getMlOrder, pushMlStock, searchMlOrdersUpdatedSince } from '../integrations/mercadolibre/resources.js';
import { computeAvailability, loadCatalog } from './inventory.js';
import { syncFromMlOrder, syncFromMpOrder } from './orders.js';

const errMsg = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : 'error').slice(0, 300);

/** Empuja a Mercado Libre el stock actual (valor absoluto) de los SKUs encolados. */
export async function processMlOutbox(opts: { limit?: number; onlySkus?: string[] } = {}): Promise<{ pushed: number; failed: number }> {
  const sql = db();
  const rows = opts.onlySkus?.length
    ? await sql<{ sku: string; requested_at: Date; attempts: number }[]>`
        select sku, requested_at, attempts from ml_stock_outbox
        where sku in ${sql(opts.onlySkus)} order by requested_at limit ${opts.limit ?? 20}`
    : await sql<{ sku: string; requested_at: Date; attempts: number }[]>`
        select sku, requested_at, attempts from ml_stock_outbox
        where next_attempt_at <= now() order by requested_at limit ${opts.limit ?? 20}`;
  if (rows.length === 0) return { pushed: 0, failed: 0 };

  const conn = await getConnection();
  if (!conn || conn.status !== 'active') return { pushed: 0, failed: 0 }; // se reintenta cuando se conecte

  const catalog = await loadCatalog(sql);
  const availability = computeAvailability(catalog);
  let pushed = 0;
  let failed = 0;
  for (const row of rows) {
    const product = catalog.products.get(row.sku);
    if (!product?.ml_item_id) {
      await sql`delete from ml_stock_outbox where sku = ${row.sku}`;
      continue;
    }
    try {
      await pushMlStock(product.ml_item_id, product.ml_variation_id, availability.get(row.sku) ?? 0);
      // Si entró otra venta mientras empujábamos, requested_at cambió y la fila queda para la próxima.
      await sql`delete from ml_stock_outbox where sku = ${row.sku} and requested_at = ${row.requested_at}`;
      pushed++;
    } catch (err) {
      failed++;
      const waitMinutes = Math.min(60, 2 ** Math.min(row.attempts, 6));
      await sql`
        update ml_stock_outbox
        set attempts = attempts + 1, last_error = ${errMsg(err)},
            next_attempt_at = now() + make_interval(mins => ${waitMinutes}::int)
        where sku = ${row.sku}`;
      if (err instanceof MlNotConnectedError) break;
    }
  }
  if (pushed || failed) log.info('ml.outbox', { pushed, failed });
  return { pushed, failed };
}

/** Procesa una notificación de Mercado Libre ya registrada en webhook_events. */
export async function processMlEvent(eventKey: string, orderId: string): Promise<void> {
  const sql = db();
  try {
    const { accountId } = await getAccessToken();
    const expected = env().ML_SELLER_USER_ID ?? accountId;
    const order = await getMlOrder(orderId);
    const res = await syncFromMlOrder(order, expected);
    await sql`
      update webhook_events set status = ${res.result === 'mismatch' ? 'ignored' : 'processed'},
        attempts = attempts + 1, processed_at = now(), last_error = null
      where provider = 'mercadolibre' and event_key = ${eventKey}`;
    if (res.changedSkus.length) await processMlOutbox({ onlySkus: res.changedSkus }).catch(() => undefined);
  } catch (err) {
    await sql`
      update webhook_events set status = 'failed', attempts = attempts + 1, last_error = ${errMsg(err)}
      where provider = 'mercadolibre' and event_key = ${eventKey}`;
    throw err;
  }
}

export interface MaintenanceReport {
  tokenRefreshed: boolean;
  mlEventsRetried: number;
  mlOrdersReconciled: number;
  mpOrdersPolled: number;
  outbox: { pushed: number; failed: number };
  errors: string[];
}

/** Tarea programada (cada 5 minutos). Cada paso es independiente y tolera fallas. */
export async function runMaintenance(deadlineMs = Date.now() + 25_000): Promise<MaintenanceReport> {
  const sql = db();
  const report: MaintenanceReport = { tokenRefreshed: false, mlEventsRetried: 0, mlOrdersReconciled: 0, mpOrdersPolled: 0, outbox: { pushed: 0, failed: 0 }, errors: [] };
  const timeLeft = () => deadlineMs - Date.now() > 3000;
  const e = env();
  const mlConfigured = Boolean(e.ML_CLIENT_ID && e.ML_CLIENT_SECRET);
  const conn = mlConfigured ? await getConnection().catch(() => undefined) : undefined;
  const mlActive = conn?.status === 'active';

  // 1. Mantener vivo el token de ML (se refresca si vence antes de la próxima corrida).
  if (mlActive && timeLeft()) {
    try {
      const before = conn!.expires_at.getTime();
      await getAccessToken({ marginMs: 45 * 60 * 1000 });
      report.tokenRefreshed = ((await getConnection())?.expires_at.getTime() ?? before) !== before;
    } catch (err) {
      report.errors.push(`token: ${errMsg(err)}`);
    }
  }

  // 2. Reintentar notificaciones de ML que fallaron o quedaron sin procesar.
  if (mlActive && timeLeft()) {
    const pending = await sql<{ event_key: string; resource: string }[]>`
      select event_key, resource from webhook_events
      where provider = 'mercadolibre' and status in ('received', 'failed') and attempts < 10
        and received_at < now() - interval '30 seconds'
      order by received_at limit 10`;
    for (const ev of pending) {
      if (!timeLeft()) break;
      const id = /^\/orders\/(\d{6,20})$/.exec(ev.resource)?.[1];
      if (!id) continue;
      try {
        await processMlEvent(ev.event_key, id);
        report.mlEventsRetried++;
      } catch (err) {
        report.errors.push(`ml_event: ${errMsg(err)}`);
      }
    }
  }

  // 3. Conciliar ventas de ML por si se perdió alguna notificación.
  if (mlActive && timeLeft()) {
    try {
      const seller = e.ML_SELLER_USER_ID ?? conn!.account_id;
      const cursorRow = await sql<{ value: { from: string } }[]>`select value from app_state where key = 'ml_orders_cursor'`;
      const from = cursorRow[0]?.value.from ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const orders = await searchMlOrdersUpdatedSince(seller, from);
      let maxSeen = from;
      for (const o of orders) {
        if (!timeLeft()) break;
        await syncFromMlOrder(o, seller);
        report.mlOrdersReconciled++;
        if (o.date_last_updated && o.date_last_updated > maxSeen) maxSeen = o.date_last_updated;
      }
      await sql`
        insert into app_state (key, value, updated_at) values ('ml_orders_cursor', ${sql.json({ from: maxSeen })}, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
    } catch (err) {
      report.errors.push(`ml_reconcile: ${errMsg(err)}`);
    }
  }

  // 4. Consultar órdenes de MP pendientes (por si el webhook no llegó).
  if ((e.MP_ACCESS_TOKEN || e.MP_POS_ACCESS_TOKEN) && timeLeft()) {
    const pending = await sql<{ provider_order_id: string; channel: string }[]>`
      select provider_order_id, channel from orders
      where channel in ('web', 'pos') and status in ('pending', 'action_required') and provider_order_id is not null
        and created_at between now() - interval '3 days' and now() - interval '2 minutes'
      order by created_at limit 15`;
    for (const p of pending) {
      if (!timeLeft()) break;
      try {
        await syncFromMpOrder(await getOrder(p.provider_order_id, p.channel === 'pos' ? 'pos' : 'online'));
        report.mpOrdersPolled++;
      } catch (err) {
        report.errors.push(`mp_poll: ${errMsg(err)}`);
      }
    }
  }

  // 5. Empujar stock pendiente a ML.
  if (mlActive && timeLeft()) {
    try {
      report.outbox = await processMlOutbox();
    } catch (err) {
      report.errors.push(`outbox: ${errMsg(err)}`);
    }
  }

  // 6. Limpieza y minimización de datos personales (Ley 18.331): el contacto del
  //    comprador se borra a los 180 días; la orden queda para contabilidad.
  if (timeLeft()) {
    await sql`delete from rate_limits where window_start < now() - interval '1 day'`;
    await sql`update orders set customer_enc = null where customer_enc is not null and created_at < now() - interval '180 days'`;
    await sql`delete from webhook_events where status in ('processed', 'ignored') and received_at < now() - interval '30 days'`;
  }

  if (report.errors.length) log.warn('maintenance.errors', { errors: report.errors });
  return report;
}
