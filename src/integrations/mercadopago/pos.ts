/**
 * Sucursal (store) y caja (POS) de Mercado Pago para cobrar con QR en ferias,
 * y configuración opcional de una terminal Point en modo PDV (integrado).
 */
import { z } from 'zod';
import { mpRequest } from './client.js';

export async function getMe(): Promise<{ id: string }> {
  const me = z.looseObject({ id: z.union([z.number(), z.string()]) }).parse(await mpRequest('/users/me', { app: 'pos' }));
  return { id: String(me.id) };
}

export interface StoreInput {
  name: string;
  externalId: string;
  streetName: string;
  streetNumber: string;
  cityName: string;
  stateName: string;
  latitude: number;
  longitude: number;
  reference?: string;
}

export async function createStore(userId: string, s: StoreInput): Promise<{ id: string }> {
  if (!/^\d+$/.test(userId)) throw new Error('user_id inválido');
  const res = z.looseObject({ id: z.union([z.number(), z.string()]) }).parse(
    await mpRequest(`/users/${userId}/stores`, {
      app: 'pos',
      method: 'POST',
      body: {
        name: s.name,
        external_id: s.externalId,
        location: {
          street_name: s.streetName,
          street_number: s.streetNumber,
          city_name: s.cityName,
          state_name: s.stateName,
          latitude: s.latitude,
          longitude: s.longitude,
          reference: s.reference ?? '',
        },
      },
    }),
  );
  return { id: String(res.id) };
}

const posResponse = z.looseObject({
  id: z.union([z.number(), z.string()]),
  external_id: z.string().optional(),
  qr_response: z
    .looseObject({
      image: z.string().optional(),
      template_document: z.string().optional(),
      template_image: z.string().optional(),
    })
    .optional(),
});

export async function createPos(input: { storeId: string; externalId: string; name: string }) {
  const res = posResponse.parse(
    await mpRequest('/v2/pos', {
      app: 'pos',
      method: 'POST',
      idempotencyKey: `pos-${input.externalId}`,
      body: {
        name: input.name,
        store_id: input.storeId,
        external_id: input.externalId,
        config: { qr: { operating_mode: 'pdv' } }, // modo atendido: la caja carga el monto
      },
    }),
  );
  const httpsOnly = (u?: string) => (u && u.startsWith('https://') ? u : undefined);
  return {
    id: String(res.id),
    qrImage: httpsOnly(res.qr_response?.image),
    qrTemplatePdf: httpsOnly(res.qr_response?.template_document),
    qrTemplateImage: httpsOnly(res.qr_response?.template_image),
  };
}

export async function listTerminals(): Promise<{ id: string; operatingMode?: string }[]> {
  const res = z
    .looseObject({
      data: z.looseObject({
        terminals: z.array(z.looseObject({ id: z.string(), operating_mode: z.string().optional() })).default([]),
      }),
    })
    .parse(await mpRequest('/terminals/v1/list?limit=50&offset=0', { app: 'pos' }));
  return res.data.terminals.map((t) => ({ id: t.id, operatingMode: t.operating_mode }));
}

export async function setTerminalPdv(terminalId: string): Promise<void> {
  await mpRequest('/terminals/v1/setup', {
    app: 'pos',
    method: 'PATCH',
    body: { terminals: [{ id: terminalId, operating_mode: 'PDV' }] },
  });
}
