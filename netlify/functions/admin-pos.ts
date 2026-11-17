/**
 * Caja (POS) para ferias y puesto. Todas las rutas exigen sesión admin; las que
 * cambian estado exigen además origen propio + token CSRF.
 *
 *   POST /api/admin/pos/charges            → nuevo cobro (QR impreso, QR en pantalla o Point)
 *   GET  /api/admin/pos/charges/:id        → estado del cobro (con consulta a MP si demora)
 *   POST /api/admin/pos/charges/:id/cancel → cancelar un cobro pendiente
 *   POST /api/admin/pos/setup              → crear sucursal + caja en Mercado Pago (una vez)
 *   GET  /api/admin/pos/terminals          → terminales Point de la cuenta
 *   POST /api/admin/pos/terminals/:id/pdv  → pasar una Point a modo integrado (PDV)
 */
import type { Config } from '@netlify/functions';
import QRCode from 'qrcode';
import { env } from '../../src/config/env.js';
import { audit } from '../../src/lib/audit.js';
import { assertSameSiteRequest } from '../../src/lib/csrf.js';
import { db } from '../../src/lib/db.js';
import { handle, HttpError, json, readJson } from '../../src/lib/http.js';
import { log } from '../../src/lib/logger.js';
import { requireAdmin } from '../../src/lib/session.js';
import { posChargeSchema, posSetupSchema, uuidSchema } from '../../src/lib/validation.js';
import { MpApiError } from '../../src/integrations/mercadopago/client.js';
import { cancelOrder, createPointOrder, createQrOrder, getOrder } from '../../src/integrations/mercadopago/orders.js';
import { createPos, createStore, getMe, listTerminals, setTerminalPdv } from '../../src/integrations/mercadopago/pos.js';
import { attachProviderOrder, createPosOrder, markOrderFailed, syncFromMpOrder } from '../../src/services/orders.js';

interface PosState {
  storeId: string;
  posId: string;
  qrImage?: string;
  qrTemplatePdf?: string;
}

async function posState(): Promise<PosState | null> {
  const rows = await db()<{ value: PosState }[]>`select value from app_state where key = 'mp_pos'`;
  return rows[0]?.value ?? null;
}

async function cancelStaleQrCharges(): Promise<void> {
  // Mercado Pago admite una sola orden activa por caja: se cancelan las pendientes anteriores.
  const stale = await db()<{ id: string; provider_order_id: string }[]>`
    select id, provider_order_id from orders
    where channel = 'pos' and status = 'pending' and pos_method in ('qr_static', 'qr_dynamic')
      and provider_order_id is not null and created_at > now() - interval '30 minutes'`;
  for (const s of stale) {
    try {
      await cancelOrder(s.provider_order_id);
      await db()`update orders set status = 'canceled', updated_at = now() where id = ${s.id} and status = 'pending'`;
    } catch (err) {
      // Si ya se pagó o venció, la conciliación lo actualiza.
      log.warn('pos.cancel_stale_failed', { err });
    }
  }
}

export default handle('admin.pos', async (req, context) => {
  requireAdmin(req);
  const url = new URL(req.url);
  const id = context.params?.id;

  // ---- Estado de un cobro
  if (req.method === 'GET' && url.pathname.startsWith('/api/admin/pos/charges/') && id) {
    if (!uuidSchema.safeParse(id).success) throw new HttpError(400, 'Id inválido', 'bad_id');
    const read = async () =>
      (await db()<{ status: string; total_cents: number; provider_order_id: string | null; created_at: Date }[]>`
        select status, total_cents, provider_order_id, created_at from orders where id = ${id} and channel = 'pos'`)[0];
    let row = await read();
    if (!row) throw new HttpError(404, 'Cobro inexistente', 'not_found');
    if (row.status === 'pending' && row.provider_order_id && Date.now() - row.created_at.getTime() > 15_000) {
      try {
        await syncFromMpOrder(await getOrder(row.provider_order_id, 'pos'));
        row = (await read()) ?? row;
      } catch (err) {
        log.warn('pos.poll_failed', { err });
      }
    }
    return json({ status: row.status, totalCents: row.total_cents });
  }

  // ---- Terminales Point
  if (req.method === 'GET' && url.pathname === '/api/admin/pos/terminals') {
    return json({ terminals: await listTerminals() });
  }

  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido', 'method_not_allowed');
  assertSameSiteRequest(req);

  if (url.pathname.startsWith('/api/admin/pos/terminals/') && url.pathname.endsWith('/pdv') && id) {
    if (!/^[A-Za-z0-9_]{5,80}$/.test(id)) throw new HttpError(400, 'Terminal inválida', 'bad_id');
    await setTerminalPdv(id);
    await audit('admin', 'point_pdv', { terminalId: id });
    return json({ ok: true });
  }

  // ---- Crear sucursal y caja (una sola vez)
  if (url.pathname === '/api/admin/pos/setup') {
    if (await posState()) throw new HttpError(409, 'La caja ya está configurada', 'already_configured');
    const input = await readJson(req, posSetupSchema, 4 * 1024);
    const e = env();
    try {
      const me = await getMe();
      const store = await createStore(me.id, { ...input, name: input.storeName, externalId: e.MP_STORE_EXTERNAL_ID });
      const pos = await createPos({ storeId: store.id, externalId: e.MP_POS_EXTERNAL_ID, name: 'Caja ESDLA' });
      const state: PosState = { storeId: store.id, posId: pos.id, qrImage: pos.qrImage, qrTemplatePdf: pos.qrTemplatePdf };
      await db()`
        insert into app_state (key, value) values ('mp_pos', ${db().json({ ...state })})
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
      await audit('admin', 'mp_pos_created', { storeId: store.id, posId: pos.id });
      return json(state, 201);
    } catch (err) {
      if (err instanceof MpApiError) throw new HttpError(502, `Mercado Pago rechazó la configuración (${err.code})`, 'mp_error');
      throw err;
    }
  }

  // ---- Cancelar un cobro
  if (url.pathname.endsWith('/cancel') && id) {
    if (!uuidSchema.safeParse(id).success) throw new HttpError(400, 'Id inválido', 'bad_id');
    const row = (await db()<{ status: string; provider_order_id: string | null; pos_method: string | null }[]>`
      select status, provider_order_id, pos_method from orders where id = ${id} and channel = 'pos'`)[0];
    if (!row) throw new HttpError(404, 'Cobro inexistente', 'not_found');
    if (row.status !== 'pending') return json({ status: row.status });
    if (row.provider_order_id) await cancelOrder(row.provider_order_id, row.pos_method === 'point');
    await db()`update orders set status = 'canceled', updated_at = now() where id = ${id} and status = 'pending'`;
    return json({ status: 'canceled' });
  }

  // ---- Nuevo cobro
  if (url.pathname === '/api/admin/pos/charges') {
    const input = await readJson(req, posChargeSchema, 4 * 1024);
    const e = env();
    if (input.method === 'point' && !e.MP_POINT_TERMINAL_ID) throw new HttpError(400, 'No hay una terminal Point configurada', 'no_point');
    const state = input.method === 'point' ? null : await posState();
    if (input.method !== 'point' && !state) throw new HttpError(409, 'Primero configurá la caja en Integraciones', 'pos_not_configured');
    if (input.method !== 'point') await cancelStaleQrCharges();

    const order = await createPosOrder(input);
    try {
      let qrImage: string | undefined;
      let providerId: string;
      if (input.method === 'point') {
        providerId = (await createPointOrder({ ref: order.ref, idempotencyKey: order.orderId, totalCents: order.totalCents, terminalId: e.MP_POINT_TERMINAL_ID! })).id;
      } else {
        const qr = await createQrOrder({
          ref: order.ref,
          idempotencyKey: order.orderId,
          items: order.lines,
          totalCents: order.totalCents,
          externalPosId: e.MP_POS_EXTERNAL_ID,
          mode: input.method === 'qr_dynamic' ? 'dynamic' : 'static',
        });
        providerId = qr.id;
        if (qr.qrData) qrImage = await QRCode.toDataURL(qr.qrData, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
      }
      await attachProviderOrder(order.orderId, providerId);
      return json(
        {
          chargeId: order.orderId,
          totalCents: order.totalCents,
          method: input.method,
          qrImage: qrImage ?? null,
          staticQrImage: input.method === 'qr_static' ? (state?.qrImage ?? null) : null,
          lowStock: order.lowStock,
        },
        201,
      );
    } catch (err) {
      await markOrderFailed(order.orderId);
      log.error('pos.charge_failed', { err });
      throw new HttpError(502, 'Mercado Pago no aceptó el cobro. Probá de nuevo.', 'mp_error');
    }
  }

  throw new HttpError(404, 'Ruta inexistente', 'not_found');
});

export const config: Config = {
  path: [
    '/api/admin/pos/charges',
    '/api/admin/pos/charges/:id',
    '/api/admin/pos/charges/:id/cancel',
    '/api/admin/pos/setup',
    '/api/admin/pos/terminals',
    '/api/admin/pos/terminals/:id/pdv',
  ],
};
