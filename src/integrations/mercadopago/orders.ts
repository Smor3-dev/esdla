/**
 * Orders API de Mercado Pago (POST /v1/orders): un solo modelo para
 *  - Checkout Pro (type "online"): el comprador paga en mercadopago.com.uy y vuelve.
 *  - QR en la caja (type "qr"): modo estático (QR impreso del puesto) o dinámico (QR en pantalla).
 *  - Point (type "point"): la terminal física recibe el monto.
 * Todas notifican por el mismo webhook (evento "Order (Mercado Pago)").
 */
import { z } from 'zod';
import { centsToAmount } from '../../lib/money.js';
import { mpUsesSeparatePosApp, type MpApp } from '../../config/env.js';
import { MpApiError, mpRequest } from './client.js';

export interface LineItem {
  sku: string;
  title: string;
  unitCents: number;
  quantity: number;
}

const mpOrderSchema = z.looseObject({
  id: z.string().min(5).max(80),
  type: z.string(),
  status: z.string(),
  status_detail: z.string().optional(),
  external_reference: z.string().optional(),
  total_amount: z.string().optional(),
  total_paid_amount: z.string().optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  checkout_url: z.string().optional(),
  type_response: z.looseObject({ qr_data: z.string().optional() }).optional(),
  transactions: z
    .looseObject({
      payments: z
        .array(
          z.looseObject({
            id: z.string().optional(),
            amount: z.string().optional(),
            status: z.string().optional(),
            status_detail: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type MpOrder = z.infer<typeof mpOrderSchema>;

function parseOrder(raw: unknown): MpOrder {
  const parsed = mpOrderSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Respuesta de Mercado Pago con formato inesperado');
  return parsed.data;
}

const checkoutHost = /(^|\.)mercadopago\.com(\.[a-z]{2})?$/;

/** Evita redirigir al comprador a un dominio que no sea de Mercado Pago. */
export function assertCheckoutUrl(url: string | undefined): string {
  if (!url) throw new Error('Mercado Pago no devolvió checkout_url');
  const u = new URL(url);
  if (u.protocol !== 'https:' || !checkoutHost.test(u.hostname)) throw new Error('checkout_url con dominio inesperado');
  return u.toString();
}

export async function createOnlineOrder(input: {
  ref: string;
  idempotencyKey: string;
  items: LineItem[];
  totalCents: number;
  siteUrl: string;
}): Promise<{ id: string; checkoutUrl: string }> {
  const back = (estado: string) => `${input.siteUrl}/gracias.html?estado=${estado}`;
  const order = parseOrder(
    await mpRequest('/v1/orders', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        type: 'online',
        processing_mode: 'manual',
        total_amount: centsToAmount(input.totalCents),
        external_reference: input.ref,
        description: 'Compra online · El Secreto de la Abuela',
        expiration_time: 'PT30M',
        items: input.items.map((i) => ({ title: i.title, unit_price: centsToAmount(i.unitCents), quantity: i.quantity })),
        config: {
          online: {
            success_url: back('aprobado'),
            failure_url: back('rechazado'),
            pending_url: back('pendiente'),
            auto_return: 'approved',
          },
        },
      },
    }),
  );
  return { id: order.id, checkoutUrl: assertCheckoutUrl(order.checkout_url) };
}

export async function createQrOrder(input: {
  ref: string;
  idempotencyKey: string;
  items: LineItem[];
  totalCents: number;
  externalPosId: string;
  mode: 'static' | 'dynamic';
}): Promise<{ id: string; qrData?: string }> {
  const amount = centsToAmount(input.totalCents);
  const order = parseOrder(
    await mpRequest('/v1/orders', {
      app: 'pos',
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        type: 'qr',
        total_amount: amount,
        external_reference: input.ref,
        description: 'Venta en puesto · El Secreto de la Abuela',
        expiration_time: 'PT10M',
        config: { qr: { external_pos_id: input.externalPosId, mode: input.mode } },
        transactions: { payments: [{ amount }] },
        items: input.items.map((i) => ({
          title: i.title,
          unit_price: centsToAmount(i.unitCents),
          quantity: i.quantity,
          unit_measure: 'unit',
          external_code: i.sku,
        })),
      },
    }),
  );
  const qrData = order.type_response?.qr_data;
  if (input.mode === 'dynamic' && !qrData) throw new Error('Mercado Pago no devolvió qr_data');
  return { id: order.id, qrData };
}

export async function createPointOrder(input: {
  ref: string;
  idempotencyKey: string;
  totalCents: number;
  terminalId: string;
}): Promise<{ id: string }> {
  const order = parseOrder(
    await mpRequest('/v1/orders', {
      app: 'pos',
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        type: 'point',
        external_reference: input.ref,
        description: 'Venta en puesto · El Secreto de la Abuela',
        expiration_time: 'PT10M',
        transactions: { payments: [{ amount: centsToAmount(input.totalCents) }] },
        config: { point: { terminal_id: input.terminalId, print_on_terminal: 'no_ticket' } },
      },
    }),
  );
  return { id: order.id };
}

/**
 * Consulta una order. Si la caja usa otra aplicación de MP y la order no aparece con
 * el token preferido, prueba con el otro (ambos son de la misma cuenta vendedora).
 */
export async function getOrder(id: string, prefer: MpApp = 'online'): Promise<MpOrder> {
  const path = `/v1/orders/${encodeURIComponent(id)}`;
  try {
    return parseOrder(await mpRequest(path, { app: prefer }));
  } catch (err) {
    const notFound = err instanceof MpApiError && (err.status === 404 || err.status === 403);
    if (!notFound || !mpUsesSeparatePosApp()) throw err;
    return parseOrder(await mpRequest(path, { app: prefer === 'pos' ? 'online' : 'pos' }));
  }
}

export async function cancelOrder(id: string, allowAtTerminal = false): Promise<MpOrder> {
  return parseOrder(
    await mpRequest(`/v1/orders/${encodeURIComponent(id)}/cancel`, {
      app: 'pos',
      method: 'POST',
      idempotencyKey: `cancel-${id}`,
      headers: allowAtTerminal ? { 'x-allow-cancelable-status': 'at_terminal' } : {},
    }),
  );
}
