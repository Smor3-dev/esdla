/**
 * Recursos de Mercado Libre que usa la integración: órdenes (ventas) y
 * publicaciones (stock). Las respuestas se validan antes de usarse.
 */
import { z } from 'zod';
import { mlRequest } from './client.js';

const mlOrderSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  status: z.string(),
  total_amount: z.number().nonnegative().optional(),
  date_last_updated: z.string().optional(),
  seller: z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) }),
  order_items: z
    .array(
      z.looseObject({
        item: z.looseObject({
          id: z.string(),
          title: z.string().optional(),
          variation_id: z.union([z.number(), z.string()]).nullable().optional(),
          seller_sku: z.string().nullable().optional(),
        }),
        quantity: z.number().int().positive(),
        unit_price: z.number().nonnegative(),
      }),
    )
    .default([]),
});
export type MlOrder = z.infer<typeof mlOrderSchema>;

export async function getMlOrder(orderId: string): Promise<MlOrder> {
  if (!/^\d{6,20}$/.test(orderId)) throw new Error('Id de orden inválido');
  return mlOrderSchema.parse(await mlRequest(`/orders/${orderId}`));
}

export async function searchMlOrdersUpdatedSince(sellerId: string, fromIso: string): Promise<MlOrder[]> {
  if (!/^\d{3,20}$/.test(sellerId)) throw new Error('seller inválido');
  const params = new URLSearchParams({
    seller: sellerId,
    'order.date_last_updated.from': fromIso,
    sort: 'date_asc',
    limit: '50',
  });
  const res = z
    .looseObject({ results: z.array(z.unknown()).default([]) })
    .parse(await mlRequest(`/orders/search?${params.toString()}`));
  return res.results.flatMap((r) => {
    const p = mlOrderSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

const mlItemSchema = z.looseObject({
  id: z.string(),
  seller_id: z.union([z.number(), z.string()]).transform(String),
  title: z.string(),
  permalink: z.string().optional(),
  available_quantity: z.number().int().optional(),
  status: z.string().optional(),
  variations: z.array(z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) })).default([]),
});
export type MlItem = z.infer<typeof mlItemSchema>;

export async function getMlItem(itemId: string): Promise<MlItem> {
  if (!/^MLU\d{6,15}$/.test(itemId)) throw new Error('Id de publicación inválido');
  return mlItemSchema.parse(await mlRequest(`/items/${itemId}`));
}

/**
 * Fija el stock de una publicación. En 0 Mercado Libre la pausa (out_of_stock)
 * y al volver a > 0 la reactiva. Con variaciones se actualiza la variación indicada.
 */
export async function pushMlStock(itemId: string, variationId: string | null, quantity: number): Promise<void> {
  if (!/^MLU\d{6,15}$/.test(itemId)) throw new Error('Id de publicación inválido');
  const qty = Math.max(0, Math.floor(quantity));
  const body = variationId
    ? { variations: [{ id: Number(variationId), available_quantity: qty }] }
    : { available_quantity: qty };
  await mlRequest(`/items/${itemId}`, { method: 'PUT', body });
}
