import { describe, expect, it } from 'vitest';
import { checkMlNotification, ipAllowed } from '../../src/integrations/mercadolibre/notifications.js';
import { amountToCents, centsToAmount } from '../../src/lib/money.js';
import { checkoutSchema, sanitizeText, uyPhoneSchema } from '../../src/lib/validation.js';
import { computeAvailability, expandToComponents, type Catalog, type ProductRow } from '../../src/services/inventory.js';

const base = { items: [{ sku: 'ZYM-200', quantity: 2 }], customer: { name: 'Ana Pérez', phone: '099 123 456', delivery: 'retiro' } };

describe('checkoutSchema', () => {
  it('acepta un pedido válido y normaliza el celular', () => {
    const r = checkoutSchema.parse(base);
    expect(r.customer.phone).toBe('+59899123456');
  });

  it('rechaza claves extra (no se puede colar un precio)', () => {
    expect(checkoutSchema.safeParse({ ...base, items: [{ sku: 'ZYM-200', quantity: 1, price: 1 }] }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, total: 1 }).success).toBe(false);
  });

  it('rechaza SKUs con formato raro, cantidades fuera de rango y repetidos', () => {
    expect(checkoutSchema.safeParse({ ...base, items: [{ sku: "ZYM'; drop table products;--", quantity: 1 }] }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, items: [{ sku: 'ZYM-200', quantity: 0 }] }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, items: [{ sku: 'ZYM-200', quantity: 1.5 }] }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, items: [{ sku: 'ZYM-200', quantity: 1 }, { sku: 'ZYM-200', quantity: 1 }] }).success).toBe(false);
  });

  it('exige dirección si es envío', () => {
    const envio = { ...base, customer: { ...base.customer, delivery: 'envio' } };
    expect(checkoutSchema.safeParse(envio).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...envio, customer: { ...envio.customer, address: 'Av. Giannattasio km 20, solar 3' } }).success).toBe(true);
  });

  it('rechaza nombres con HTML o scripts', () => {
    expect(checkoutSchema.safeParse({ ...base, customer: { ...base.customer, name: '<script>alert(1)</script>' } }).success).toBe(false);
  });

  it('teléfonos uruguayos', () => {
    expect(uyPhoneSchema.parse('+598 99 501 132')).toBe('+59899501132');
    expect(uyPhoneSchema.parse('099501132')).toBe('+59899501132');
    expect(uyPhoneSchema.parse('2600 1234')).toBe('+59826001234');
    expect(uyPhoneSchema.safeParse('12345').success).toBe(false);
  });

  it('sanitizeText quita caracteres de control, invisibles y < >', () => {
    expect(sanitizeText(`  Ana${String.fromCharCode(0)}${String.fromCharCode(0x202e)} Pérez <b> `)).toBe('Ana Pérez b');
  });
});

describe('dinero', () => {
  it('convierte sin errores de punto flotante', () => {
    expect(centsToAmount(21000)).toBe('210.00');
    expect(centsToAmount(105)).toBe('1.05');
    expect(amountToCents('210.5')).toBe(21050);
    expect(amountToCents(0.1 + 0.2)).toBe(30);
    expect(() => amountToCents('1e3')).toThrow();
    expect(() => amountToCents('-1')).toThrow();
  });
});

describe('inventario con bundles', () => {
  const p = (sku: string, stock: number, is_bundle = false): ProductRow => ({
    sku, name: sku, price_cents: 100, stock, is_bundle, active: true, sell_online: true, ml_item_id: null, ml_variation_id: null, ml_permalink: null,
  });
  const catalog: Catalog = {
    products: new Map([['A', p('A', 5)], ['B', p('B', 2)], ['C', p('C', 9)], ['BOX', p('BOX', 0, true)]].map(([k, v]) => [k as string, v as ProductRow])),
    components: [
      { bundle_sku: 'BOX', component_sku: 'A', quantity: 1 },
      { bundle_sku: 'BOX', component_sku: 'B', quantity: 1 },
      { bundle_sku: 'BOX', component_sku: 'C', quantity: 1 },
    ],
  };

  it('expande el Box en sus componentes', () => {
    const e = expandToComponents([{ sku: 'BOX', quantity: 2 }, { sku: 'A', quantity: 1 }], catalog);
    expect(Object.fromEntries(e)).toEqual({ A: 3, B: 2, C: 2 });
  });

  it('la disponibilidad del Box es el mínimo de sus componentes', () => {
    expect(computeAvailability(catalog).get('BOX')).toBe(2);
  });
});

describe('notificaciones de Mercado Libre', () => {
  const ok = { _id: 'abc-1', resource: '/orders/2000001234567', user_id: 987654321, topic: 'orders_v2', application_id: 1234567890123456, attempts: 1 };
  const expected = { appId: '1234567890123456', sellerId: '987654321' };

  it('acepta una notificación de orden de nuestra app y vendedor', () => {
    expect(checkMlNotification(ok, expected)).toMatchObject({ ok: true, orderId: '2000001234567' });
  });

  it('rechaza otra app, otro vendedor o recursos raros', () => {
    expect(checkMlNotification({ ...ok, application_id: 1 }, expected)).toEqual({ ok: false, reason: 'wrong_app' });
    expect(checkMlNotification({ ...ok, user_id: 1 }, expected)).toEqual({ ok: false, reason: 'wrong_user' });
    expect(checkMlNotification({ ...ok, resource: '/orders/123/../../users/me' }, expected)).toEqual({ ok: false, reason: 'bad_resource' });
    expect(checkMlNotification({ ...ok, topic: 'questions' }, expected)).toEqual({ ok: false, reason: 'ignored_topic' });
    expect(checkMlNotification('basura', expected)).toEqual({ ok: false, reason: 'invalid_body' });
  });

  it('filtro de IP', () => {
    expect(ipAllowed('54.88.218.97', ['54.88.218.97'])).toBe(true);
    expect(ipAllowed('::ffff:54.88.218.97', ['54.88.218.97'])).toBe(true);
    expect(ipAllowed('1.2.3.4', ['54.88.218.97'])).toBe(false);
    expect(ipAllowed('1.2.3.4', null)).toBe(true);
  });
});

describe('variables de entorno', () => {
  it('una variable opcional vacía cuenta como no cargada', async () => {
    const { env, resetEnvCache } = await import('../../src/config/env.js');
    process.env.MP_POINT_TERMINAL_ID = '';
    process.env.MP_POS_ACCESS_TOKEN = '  ';
    resetEnvCache();
    try {
      const e = env();
      expect(e.MP_POINT_TERMINAL_ID).toBeUndefined();
      expect(e.MP_POS_ACCESS_TOKEN).toBeUndefined();
    } finally {
      delete process.env.MP_POINT_TERMINAL_ID;
      delete process.env.MP_POS_ACCESS_TOKEN;
      resetEnvCache();
    }
  });
});
