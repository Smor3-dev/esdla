/**
 * Vectores generados y validados con WebhookSignatureValidator del SDK oficial
 * de Mercado Pago (paquete npm "mercadopago" 3.6.1).
 */
import { describe, expect, it } from 'vitest';
import { buildManifest, verifyMpSignature } from '../../src/integrations/mercadopago/webhook-signature.js';

const SECRET = 'test-webhook-secret-0123456789abcdef';
const ID = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';
const REQ = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';

describe('firma x-signature de Mercado Pago', () => {
  it('arma el manifest igual que el SDK', () => {
    expect(buildManifest(ID, REQ, '1742505638')).toBe(`id:${ID};request-id:${REQ};ts:1742505638;`);
    expect(buildManifest(ID, undefined, '1')).toBe(`id:${ID};ts:1;`);
  });

  it('acepta una firma válida (vector del SDK)', () => {
    const r = verifyMpSignature({
      xSignature: 'ts=1742505638,v1=55d7911c70c8b000d3f70a1d2a58e56f355c51dc5225d5ae3a63b7bb423c1a26',
      xRequestId: REQ,
      dataId: ID,
      secrets: [SECRET],
    });
    expect(r).toEqual({ ok: true, ts: 1742505638, secretIndex: 0 });
  });

  it('acepta firma sin x-request-id y con ts en milisegundos (vector del SDK)', () => {
    const r = verifyMpSignature({
      xSignature: 'ts=1742505638683,v1=d1f6a697d625c6c145a21083d446883c6e9d4acd2734ac6285dbc9184110fd57',
      xRequestId: null,
      dataId: ID,
      secrets: [SECRET],
    });
    expect(r.ok).toBe(true);
  });

  it('acepta la variante con data.id en minúsculas (doc de QR Uruguay)', () => {
    const r = verifyMpSignature({
      xSignature: 'ts=1742505638,v1=f73feae6997c2bda5c2498f9e9b15d7a86e08188b45a16594d5f8f46ff3989d0',
      xRequestId: REQ,
      dataId: ID,
      secrets: [SECRET],
    });
    expect(r.ok).toBe(true);
  });

  it('rotación: valida con la segunda clave configurada', () => {
    const r = verifyMpSignature({
      xSignature: 'ts=1742505638,v1=55d7911c70c8b000d3f70a1d2a58e56f355c51dc5225d5ae3a63b7bb423c1a26',
      xRequestId: REQ,
      dataId: ID,
      secrets: ['clave-nueva-0123456789abcdef', SECRET],
    });
    expect(r).toMatchObject({ ok: true, secretIndex: 1 });
  });

  it('rechaza clave incorrecta, id cambiado o request-id cambiado', () => {
    const base = { xSignature: 'ts=1742505638,v1=55d7911c70c8b000d3f70a1d2a58e56f355c51dc5225d5ae3a63b7bb423c1a26', xRequestId: REQ, dataId: ID };
    expect(verifyMpSignature({ ...base, secrets: ['otra-clave-0123456789abcdef'] })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyMpSignature({ ...base, dataId: 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D4', secrets: [SECRET] })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyMpSignature({ ...base, xRequestId: 'otro', secrets: [SECRET] })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('distingue header ausente de header mal formado', () => {
    expect(verifyMpSignature({ xSignature: null, xRequestId: REQ, dataId: ID, secrets: [SECRET] })).toEqual({ ok: false, reason: 'missing' });
    expect(verifyMpSignature({ xSignature: 'v1=abc', xRequestId: REQ, dataId: ID, secrets: [SECRET] })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyMpSignature({ xSignature: 'ts=abc,v1=' + 'a'.repeat(64), xRequestId: REQ, dataId: ID, secrets: [SECRET] })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('opcional: rechaza firmas viejas si se configura tolerancia', () => {
    const r = verifyMpSignature({
      xSignature: 'ts=1742505638,v1=55d7911c70c8b000d3f70a1d2a58e56f355c51dc5225d5ae3a63b7bb423c1a26',
      xRequestId: REQ,
      dataId: ID,
      secrets: [SECRET],
      toleranceSeconds: 300,
      nowMs: (1742505638 + 3600) * 1000,
    });
    expect(r).toEqual({ ok: false, reason: 'stale' });
  });
});
