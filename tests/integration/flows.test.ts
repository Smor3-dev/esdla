/**
 * Flujos completos contra Postgres real (PGlite) con las APIs de Mercado Pago y
 * Mercado Libre simuladas (fetch mockeado). Cubren: compra web, webhooks firmados,
 * idempotencia, montos alterados, notificaciones de ML, refresh de tokens, caja POS,
 * login y OAuth.
 */
import { createHmac } from 'node:crypto';
import type { Context } from '@netlify/functions';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import adminData from '../../netlify/functions/admin-data.js';
import adminMlOauth from '../../netlify/functions/admin-ml-oauth.js';
import adminPos from '../../netlify/functions/admin-pos.js';
import adminSession from '../../netlify/functions/admin-session.js';
import checkout from '../../netlify/functions/checkout.js';
import csrf from '../../netlify/functions/csrf.js';
import orderStatus from '../../netlify/functions/order-status.js';
import products from '../../netlify/functions/products.js';
import webhookMl from '../../netlify/functions/webhook-mercadolibre.js';
import webhookMp from '../../netlify/functions/webhook-mercadopago.js';
import { resetEnvCache } from '../../src/config/env.js';
import { decrypt } from '../../src/lib/crypto.js';
import { closeDb, db } from '../../src/lib/db.js';
import { getAccessToken, MlNotConnectedError, saveTokens } from '../../src/integrations/mercadolibre/oauth.js';
import { getOrder } from '../../src/integrations/mercadopago/orders.js';
import { runMaintenance } from '../../src/services/sync.js';

const SITE = 'https://esdla.test';
const MP_SECRET = 'test-webhook-secret-0123456789abcdef';
const SELLER = '987654321';
const ML_ITEM = 'MLU123456789';

// ------------------------------------------------------------------ helpers
let waits: Promise<unknown>[] = [];
const ctx = (extra: Record<string, unknown> = {}) =>
  ({ ip: '200.40.10.10', params: {}, requestId: 'test', waitUntil: (p: Promise<unknown>) => void waits.push(p), ...extra }) as unknown as Context;

type Reply = (url: URL, init: RequestInit) => Response | Promise<Response>;
let routes: { method: string; match: RegExp; reply: Reply }[] = [];
let calls: { method: string; url: string; body?: string; headers: Headers }[] = [];
const route = (method: string, match: RegExp, reply: Reply) => routes.push({ method, match, reply });
const jsonRes = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  calls.push({ method, url: url.toString(), body: typeof init.body === 'string' ? init.body : init.body?.toString(), headers: new Headers(init.headers) });
  const r = routes.find((x) => x.method === method && x.match.test(url.toString()));
  if (!r) throw new Error(`fetch sin mock: ${method} ${url}`);
  return r.reply(url, init);
});

const cookiePart = (setCookie: string | null) => (setCookie ?? '').split(';')[0]!;

async function csrfPair() {
  const res = await csrf(new Request(`${SITE}/api/csrf`), ctx());
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie: cookiePart(res.headers.get('set-cookie')), token: csrfToken };
}

async function loginCookies(): Promise<string> {
  const c = await csrfPair();
  const res = await adminSession(
    new Request(`${SITE}/api/admin/session`, {
      method: 'POST',
      headers: { origin: SITE, cookie: c.cookie, 'x-csrf-token': c.token, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'frase-larga-de-prueba-123' }),
    }),
    ctx({ ip: '10.0.0.1' }),
  );
  expect(res.status).toBe(200);
  return `${c.cookie}; ${cookiePart(res.headers.get('set-cookie'))}|${c.token}`;
}

function signMp(id: string, requestId: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const v1 = createHmac('sha256', MP_SECRET).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
  return `ts=${ts},v1=${v1}`;
}

function mpWebhook(id: string, opts: { signature?: string | null; requestId?: string } = {}) {
  const requestId = opts.requestId ?? `req-${Math.random().toString(36).slice(2)}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': requestId };
  const sig = opts.signature === undefined ? signMp(id, requestId) : opts.signature;
  if (sig) headers['x-signature'] = sig;
  return webhookMp(
    new Request(`${SITE}/api/webhooks/mercadopago?data.id=${id}&type=order`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'order.processed', type: 'order', data: { id } }),
    }),
    ctx(),
  );
}

async function crearCompra(sku = 'ZYM-200', quantity = 2) {
  const mpId = `ORDTST01KS5AJ6HTK2HRQ3XJ${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  route('POST', /api\.mercadopago\.com\/v1\/orders$/, async (_u, init) => {
    const body = JSON.parse(String(init.body));
    return jsonRes({ id: mpId, type: 'online', status: 'created', external_reference: body.external_reference, total_amount: body.total_amount,
      checkout_url: `https://www.mercadopago.com.uy/checkout/v1/redirect?order_id=${mpId}` }, 201);
  });
  const c = await csrfPair();
  const res = await checkout(
    new Request(`${SITE}/api/checkout`, {
      method: 'POST',
      headers: { origin: SITE, cookie: c.cookie, 'x-csrf-token': c.token, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ sku, quantity }], customer: { name: 'Ana Pérez', phone: '099 123 456', delivery: 'retiro' } }),
    }),
    ctx(),
  );
  return { res, mpId };
}

const stockOf = async (sku: string) => (await db()<{ stock: number }[]>`select stock from products where sku = ${sku}`)[0]!.stock;

async function conectarMl(expiresIn = 21600) {
  await saveTokens(db(), { access_token: 'APP_USR-acceso-viejo-123', token_type: 'bearer', expires_in: expiresIn, user_id: Number(SELLER), refresh_token: 'TG-refresh-viejo-123', scope: 'offline_access read write' });
}

beforeEach(async () => {
  routes = [];
  calls = [];
  waits = [];
  const sql = db();
  await sql`truncate order_items, orders, stock_movements, webhook_events, ml_stock_outbox, rate_limits, oauth_tokens, app_state, audit_log`;
  await sql`update products set stock = 10, ml_item_id = null, ml_variation_id = null, ml_permalink = null`;
});

afterAll(async () => {
  await closeDb();
});

// ------------------------------------------------------------------ compra web
describe('compra online (Checkout Pro / Orders API)', () => {
  it('crea la orden con precio del servidor y datos del comprador cifrados', async () => {
    const { res, mpId } = await crearCompra();
    expect(res.status).toBe(201);
    const data = (await res.json()) as { checkoutUrl: string; ref: string };
    expect(data.checkoutUrl).toMatch(/^https:\/\/www\.mercadopago\.com\.uy\//);

    const mpCall = calls.find((c) => c.url.endsWith('/v1/orders'))!;
    const body = JSON.parse(mpCall.body!);
    expect(body.total_amount).toBe('420.00'); // 2 × $210 desde la base, no desde el navegador
    expect(body.type).toBe('online');
    expect(mpCall.headers.get('x-idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(mpCall.headers.get('authorization')).toMatch(/^Bearer APP_USR-/);

    const [o] = await db()<{ status: string; total_cents: number; provider_order_id: string; customer_enc: string }[]>`select * from orders where public_ref = ${data.ref}`;
    expect(o).toMatchObject({ status: 'pending', total_cents: 42000, provider_order_id: mpId });
    expect(o!.customer_enc).not.toContain('Ana');
    expect(JSON.parse(decrypt(o!.customer_enc, `order:${data.ref}:customer`))).toMatchObject({ name: 'Ana Pérez', phone: '+59899123456' });
  });

  it('sin token CSRF o desde otro origen → 403, y no llama a Mercado Pago', async () => {
    const r1 = await checkout(new Request(`${SITE}/api/checkout`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: '{}' }), ctx());
    const c = await csrfPair();
    const r2 = await checkout(new Request(`${SITE}/api/checkout`, { method: 'POST', headers: { origin: 'https://otro.example', cookie: c.cookie, 'x-csrf-token': c.token, 'content-type': 'application/json' }, body: '{}' }), ctx());
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(calls.filter((x) => x.url.includes('mercadopago'))).toHaveLength(0);
  });

  it('sin stock suficiente → 409', async () => {
    await db()`update products set stock = 1 where sku = 'ZYM-200'`;
    const { res } = await crearCompra('ZYM-200', 2);
    expect(res.status).toBe(409);
  });

  it('el catálogo público no expone el stock exacto', async () => {
    const res = await products(new Request(`${SITE}/api/products`), ctx());
    const { products: list } = (await res.json()) as { products: Record<string, unknown>[] };
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) expect(p).not.toHaveProperty('stock');
    expect(list.find((p) => p.sku === 'BOX-3')).toMatchObject({ available: true, buyOnline: true });
  });
});

// ------------------------------------------------------------------ webhook MP
describe('webhook de Mercado Pago', () => {
  async function pagada(mpId: string, ref: string, amount = '420.00') {
    route('GET', new RegExp(`/v1/orders/${mpId}$`), () =>
      jsonRes({ id: mpId, type: 'online', status: 'processed', status_detail: 'accredited', external_reference: ref, total_amount: amount, total_paid_amount: amount }));
  }

  it('firma válida → consulta la API, marca pagada, descuenta stock y sincroniza ML', async () => {
    await conectarMl();
    await db()`update products set ml_item_id = ${ML_ITEM} where sku = 'ZYM-200'`;
    const { res, mpId } = await crearCompra();
    const { ref } = (await res.json()) as { ref: string };
    await pagada(mpId, ref);
    route('PUT', /api\.mercadolibre\.com\/items\/MLU123456789$/, () => jsonRes({}));

    const r = await mpWebhook(mpId);
    expect(r.status).toBe(200);
    expect((await db()`select status from orders where public_ref = ${ref}`)[0]!.status).toBe('paid');
    expect(await stockOf('ZYM-200')).toBe(8);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(put.body!)).toEqual({ available_quantity: 8 });
    expect(put.headers.get('authorization')).toBe('Bearer APP_USR-acceso-viejo-123');
    expect(await db()`select * from ml_stock_outbox`).toHaveLength(0);

    // El Box (que contiene ZYM-200) no está vinculado a ML: no se empuja nada más.
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('el mismo webhook repetido no descuenta dos veces', async () => {
    const { res, mpId } = await crearCompra();
    const { ref } = (await res.json()) as { ref: string };
    await pagada(mpId, ref);
    expect((await mpWebhook(mpId)).status).toBe(200);
    expect((await mpWebhook(mpId)).status).toBe(200);
    expect((await mpWebhook(mpId, { requestId: 'otra-entrega' })).status).toBe(200);
    expect(await stockOf('ZYM-200')).toBe(8);
    expect(await db()`select * from stock_movements where source_ref = ${ref}`).toHaveLength(1);
  });

  it('monto distinto en Mercado Pago → no se marca como pagada', async () => {
    const { res, mpId } = await crearCompra();
    const { ref } = (await res.json()) as { ref: string };
    await pagada(mpId, ref, '1.00');
    expect((await mpWebhook(mpId)).status).toBe(200);
    expect((await db()`select status from orders where public_ref = ${ref}`)[0]!.status).toBe('pending');
    expect(await stockOf('ZYM-200')).toBe(10);
  });

  it('firma inválida o ausente → 401 sin consultar la API', async () => {
    const { mpId } = await crearCompra();
    calls = [];
    expect((await mpWebhook(mpId, { signature: `ts=1742505638,v1=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await mpWebhook(mpId, { signature: null })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('reembolso total → devuelve el stock', async () => {
    const { res, mpId } = await crearCompra();
    const { ref } = (await res.json()) as { ref: string };
    await pagada(mpId, ref);
    await mpWebhook(mpId);
    routes = routes.filter((r) => !r.match.test(`https://api.mercadopago.com/v1/orders/${mpId}`));
    route('GET', new RegExp(`/v1/orders/${mpId}$`), () =>
      jsonRes({ id: mpId, type: 'online', status: 'refunded', status_detail: 'refunded', external_reference: ref, total_amount: '420.00' }));
    await mpWebhook(mpId);
    expect((await db()`select status from orders where public_ref = ${ref}`)[0]!.status).toBe('refunded');
    expect(await stockOf('ZYM-200')).toBe(10);
  });
});

// ------------------------------------------------------------------ notificaciones ML
describe('notificaciones de Mercado Libre', () => {
  const body = (id = 'n-1') => JSON.stringify({ _id: id, resource: '/orders/2000001234567', user_id: Number(SELLER), topic: 'orders_v2', application_id: 1234567890123456, attempts: 1 });
  const mlOrder = (status: string) => ({
    id: 2000001234567, status, total_amount: 420, seller: { id: Number(SELLER) },
    order_items: [{ item: { id: ML_ITEM, variation_id: null, seller_sku: null, title: 'Salsa' }, quantity: 2, unit_price: 210 }],
  });
  const notify = (ip: string, id?: string) =>
    webhookMl(new Request(`${SITE}/api/webhooks/mercadolibre`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(id) }), ctx({ ip }));

  it('venta pagada en ML → responde 200 enseguida y descuenta el stock propio', async () => {
    await conectarMl();
    await db()`update products set ml_item_id = ${ML_ITEM} where sku = 'ZYM-200'`;
    route('GET', /api\.mercadolibre\.com\/orders\/2000001234567$/, () => jsonRes(mlOrder('paid')));
    route('PUT', /api\.mercadolibre\.com\/items\/MLU123456789$/, () => jsonRes({}));

    const r = await notify('54.88.218.97');
    expect(r.status).toBe(200);
    expect(waits).toHaveLength(1); // el trabajo pesado sigue en segundo plano
    await Promise.all(waits);
    expect(await stockOf('ZYM-200')).toBe(8);
    expect((await db()`select status, channel from orders where public_ref = 'ML-2000001234567'`)[0]).toMatchObject({ status: 'paid', channel: 'mercadolibre' });

    // Repetida (mismo _id) y otra notificación de la misma orden: no descuenta de nuevo.
    await notify('54.88.218.97');
    await notify('54.88.218.97', 'n-2');
    await Promise.all(waits);
    expect(await stockOf('ZYM-200')).toBe(8);
  });

  it('cancelación posterior → devuelve el stock', async () => {
    await conectarMl();
    await db()`update products set ml_item_id = ${ML_ITEM} where sku = 'ZYM-200'`;
    route('PUT', /api\.mercadolibre\.com\/items\//, () => jsonRes({}));
    route('GET', /api\.mercadolibre\.com\/orders\/2000001234567$/, () => jsonRes(mlOrder('paid')));
    await notify('54.88.218.97', 'a');
    await Promise.all(waits);
    routes = routes.filter((r) => r.method !== 'GET');
    route('GET', /api\.mercadolibre\.com\/orders\/2000001234567$/, () => jsonRes(mlOrder('cancelled')));
    await notify('54.88.218.97', 'b');
    await Promise.all(waits);
    expect(await stockOf('ZYM-200')).toBe(10);
  });

  it('IP no permitida → 403 y no hace nada', async () => {
    const r = await notify('1.2.3.4');
    expect(r.status).toBe(403);
    expect(waits).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ tokens ML
describe('tokens de Mercado Libre', () => {
  it('se guardan cifrados', async () => {
    await conectarMl();
    const [row] = await db()<{ access_token_enc: string; refresh_token_enc: string }[]>`select * from oauth_tokens`;
    expect(row!.access_token_enc).not.toContain('acceso-viejo');
    expect(row!.refresh_token_enc).not.toContain('refresh-viejo');
  });

  it('refresca una sola vez aunque lo pidan dos funciones a la vez (refresh token de un solo uso)', async () => {
    await conectarMl();
    await db()`update oauth_tokens set expires_at = now() - interval '1 minute'`;
    route('POST', /api\.mercadolibre\.com\/oauth\/token$/, (_u, init) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('TG-refresh-viejo-123');
      return jsonRes({ access_token: 'APP_USR-acceso-nuevo-456', token_type: 'bearer', expires_in: 21600, user_id: Number(SELLER), refresh_token: 'TG-refresh-nuevo-456', scope: 'offline_access read write' });
    });
    const [a, b] = await Promise.all([getAccessToken(), getAccessToken()]);
    expect(a.token).toBe('APP_USR-acceso-nuevo-456');
    expect(b.token).toBe('APP_USR-acceso-nuevo-456');
    expect(calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(1);
  });

  it('refresh rechazado (invalid_grant) → marca "reconectar"', async () => {
    await conectarMl();
    await db()`update oauth_tokens set expires_at = now() - interval '1 minute'`;
    route('POST', /api\.mercadolibre\.com\/oauth\/token$/, () => jsonRes({ error: 'invalid_grant' }, 400));
    await expect(getAccessToken()).rejects.toBeInstanceOf(MlNotConnectedError);
    expect((await db()`select status from oauth_tokens`)[0]!.status).toBe('reauth_required');
  });
});

// ------------------------------------------------------------------ panel admin
describe('panel admin', () => {
  it('login: contraseña incorrecta → 401; al sexto intento → 429', async () => {
    const c = await csrfPair();
    const intento = () =>
      adminSession(new Request(`${SITE}/api/admin/session`, {
        method: 'POST',
        headers: { origin: SITE, cookie: c.cookie, 'x-csrf-token': c.token, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'incorrecta' }),
      }), ctx({ ip: '10.9.9.9' }));
    for (let i = 0; i < 5; i++) expect((await intento()).status).toBe(401);
    expect((await intento()).status).toBe(429);
  });

  it('rutas admin sin sesión → 401', async () => {
    const r = await adminData(new Request(`${SITE}/api/admin/orders`), ctx());
    expect(r.status).toBe(401);
  });

  it('caja: cobro con QR dinámico y pago confirmado por webhook', async () => {
    const [cookies, token] = (await loginCookies()).split('|') as [string, string];
    await db()`insert into app_state (key, value) values ('mp_pos', ${db().json({ storeId: '1', posId: '2', qrImage: 'https://www.mercadopago.com/instore/merchant/qr/1/a.png' })})`;
    let mpId = '';
    route('POST', /api\.mercadopago\.com\/v1\/orders$/, async (_u, init) => {
      const b = JSON.parse(String(init.body));
      expect(b.type).toBe('qr');
      expect(b.config.qr).toEqual({ external_pos_id: 'ESDLAPOS001', mode: 'dynamic' });
      mpId = 'ORDTST01QRDYNAMICO00000001';
      return jsonRes({ id: mpId, type: 'qr', status: 'created', external_reference: b.external_reference, total_amount: b.total_amount, type_response: { qr_data: '00020101021243650016COM.MERCADOLIBRE0201306361234' } }, 201);
    });
    const res = await adminPos(
      new Request(`${SITE}/api/admin/pos/charges`, {
        method: 'POST',
        headers: { origin: SITE, cookie: cookies, 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ sku: 'SWJ-200', quantity: 1 }], method: 'qr_dynamic' }),
      }),
      ctx(),
    );
    expect(res.status).toBe(201);
    const charge = (await res.json()) as { chargeId: string; qrImage: string; totalCents: number };
    expect(charge.qrImage).toMatch(/^data:image\/png;base64,/);
    expect(charge.totalCents).toBe(21000);

    const [o] = await db()<{ public_ref: string }[]>`select public_ref from orders where id = ${charge.chargeId}`;
    route('GET', new RegExp(`/v1/orders/${mpId}$`), () =>
      jsonRes({ id: mpId, type: 'qr', status: 'processed', status_detail: 'accredited', external_reference: o!.public_ref, total_amount: '210.00' }));
    expect((await mpWebhook(mpId)).status).toBe(200);

    const st = await adminPos(new Request(`${SITE}/api/admin/pos/charges/${charge.chargeId}`, { headers: { cookie: cookies } }), ctx({ params: { id: charge.chargeId } }));
    expect(await st.json()).toMatchObject({ status: 'paid' });
    expect(await stockOf('SWJ-200')).toBe(9);
  });

  it('OAuth de ML: state y PKCE; cuenta conectada con tokens cifrados', async () => {
    const [cookies] = (await loginCookies()).split('|') as [string, string];
    const start = await adminMlOauth(new Request(`${SITE}/api/admin/ml/connect`, { headers: { cookie: cookies } }), ctx());
    expect(start.status).toBe(302);
    const auth = new URL(start.headers.get('location')!);
    expect(auth.origin).toBe('https://auth.mercadolibre.com.uy');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const flowCookie = cookiePart(start.headers.get('set-cookie'));
    expect(start.headers.get('set-cookie')).toContain('SameSite=Lax');

    // state alterado → error
    const bad = await adminMlOauth(new Request(`${SITE}/api/admin/ml/callback?code=TG-abcdefghijk&state=otro`, { headers: { cookie: flowCookie } }), ctx());
    expect(bad.headers.get('location')).toBe(`${SITE}/admin/?ml=error`);

    route('POST', /api\.mercadolibre\.com\/oauth\/token$/, (_u, init) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code_verifier')).toHaveLength(43);
      expect(form.get('client_secret')).toBe('ml-client-secret-de-prueba');
      return jsonRes({ access_token: 'APP_USR-nuevo', token_type: 'bearer', expires_in: 21600, user_id: Number(SELLER), refresh_token: 'TG-r-nuevo-123', scope: 'offline_access read write' });
    });
    const ok = await adminMlOauth(
      new Request(`${SITE}/api/admin/ml/callback?code=TG-abcdefghijk&state=${auth.searchParams.get('state')}`, { headers: { cookie: flowCookie } }),
      ctx(),
    );
    expect(ok.headers.get('location')).toBe(`${SITE}/admin/?ml=conectado`);
    expect((await db()`select account_id, status from oauth_tokens`)[0]).toMatchObject({ account_id: SELLER, status: 'active' });
  });
});

// ------------------------------------------------------------------ panel: datos y mantenimiento
describe('panel admin: pedidos, stock y vínculo con ML', () => {
  const adminReq = (path: string, cookies: string, token: string, body?: unknown) =>
    new Request(`${SITE}${path}`, body === undefined
      ? { headers: { cookie: cookies } }
      : { method: 'POST', headers: { origin: SITE, cookie: cookies, 'x-csrf-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('lista pedidos pagados con el contacto descifrado', async () => {
    const { res, mpId } = await crearCompra();
    const { ref } = (await res.json()) as { ref: string };
    route('GET', new RegExp(`/v1/orders/${mpId}$`), () => jsonRes({ id: mpId, type: 'online', status: 'processed', external_reference: ref, total_amount: '420.00' }));
    await mpWebhook(mpId);
    const [cookies, token] = (await loginCookies()).split('|') as [string, string];
    const r = await adminData(adminReq('/api/admin/orders', cookies, token), ctx());
    const { orders } = (await r.json()) as { orders: { ref: string; customer: { phone: string }; items: unknown[] }[] };
    expect(orders[0]).toMatchObject({ ref, customer: { phone: '+59899123456' }, items: [{ sku: 'ZYM-200', quantity: 2 }] });
  });

  it('ajuste de stock con registro y vínculo verificado contra la cuenta de ML', async () => {
    await conectarMl();
    const [cookies, token] = (await loginCookies()).split('|') as [string, string];
    route('GET', /api\.mercadolibre\.com\/items\/MLU123456789$/, () =>
      jsonRes({ id: ML_ITEM, seller_id: Number(SELLER), title: 'Salsa', permalink: 'https://articulo.mercadolibre.com.uy/MLU-123456789-salsa', variations: [] }));
    route('PUT', /api\.mercadolibre\.com\/items\/MLU123456789$/, () => jsonRes({}));

    const map = await adminData(adminReq('/api/admin/products/ZYM-200/ml', cookies, token, { mlItemId: ML_ITEM }), ctx({ params: { sku: 'ZYM-200' } }));
    expect(map.status).toBe(200);
    const adj = await adminData(adminReq('/api/admin/products/ZYM-200/stock', cookies, token, { stock: 25 }), ctx({ params: { sku: 'ZYM-200' } }));
    expect(adj.status).toBe(200);
    expect(await stockOf('ZYM-200')).toBe(25);
    expect(await db()`select * from stock_movements where reason = 'adjustment' and sku = 'ZYM-200'`).toHaveLength(1);
    const puts = calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body!));
    expect(puts.at(-1)).toEqual({ available_quantity: 25 });

    // Publicación de otra cuenta → rechazada
    routes = routes.filter((r) => r.method !== 'GET');
    route('GET', /api\.mercadolibre\.com\/items\/MLU999999999$/, () => jsonRes({ id: 'MLU999999999', seller_id: 111, title: 'Ajena', variations: [] }));
    const ajena = await adminData(adminReq('/api/admin/products/SWJ-200/ml', cookies, token, { mlItemId: 'MLU999999999' }), ctx({ params: { sku: 'SWJ-200' } }));
    expect(ajena.status).toBe(403);
  });

  it('el mantenimiento consulta órdenes pendientes si el webhook no llegó', async () => {
    const { res, mpId } = await crearCompra();
    const { ref } = (await res.json()) as { ref: string };
    await db()`update orders set created_at = now() - interval '10 minutes' where public_ref = ${ref}`;
    route('GET', new RegExp(`/v1/orders/${mpId}$`), () => jsonRes({ id: mpId, type: 'online', status: 'processed', external_reference: ref, total_amount: '420.00' }));
    const report = await runMaintenance(Date.now() + 15_000);
    expect(report.mpOrdersPolled).toBe(1);
    expect((await db()`select status from orders where public_ref = ${ref}`)[0]!.status).toBe('paid');
    expect(await stockOf('ZYM-200')).toBe(8);
  });
});

// ------------------------------------------------------------------ dos aplicaciones de Mercado Pago
describe('Mercado Pago con dos aplicaciones (Checkout Pro y Código QR)', () => {
  const WEB_TOKEN = 'APP_USR-0000000000000000-000000-test-token-no-real';
  const POS_TOKEN = 'APP_USR-1111111111111111-111111-pos-token-no-real';
  const auth = (init: RequestInit) => new Headers(init.headers).get('authorization');

  it('la caja usa su propio token y el webhook consulta la orden con el token de su canal', async () => {
    process.env.MP_POS_ACCESS_TOKEN = POS_TOKEN;
    resetEnvCache();
    try {
      const [cookies, token] = (await loginCookies()).split('|') as [string, string];
      await db()`insert into app_state (key, value) values ('mp_pos', ${db().json({ storeId: '1', posId: '2' })})`;
      const mpId = 'ORDTST01QRDOSAPPS000000001';
      route('POST', /api\.mercadopago\.com\/v1\/orders$/, async (_u, init) => {
        expect(auth(init)).toBe(`Bearer ${POS_TOKEN}`);
        const b = JSON.parse(String(init.body));
        return jsonRes({ id: mpId, type: 'qr', status: 'created', external_reference: b.external_reference, total_amount: b.total_amount }, 201);
      });
      const res = await adminPos(
        new Request(`${SITE}/api/admin/pos/charges`, {
          method: 'POST',
          headers: { origin: SITE, cookie: cookies, 'x-csrf-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ items: [{ sku: 'VDH-200', quantity: 1 }], method: 'qr_static' }),
        }),
        ctx(),
      );
      expect(res.status).toBe(201);
      const { chargeId } = (await res.json()) as { chargeId: string };
      const [o] = await db()<{ public_ref: string }[]>`select public_ref from orders where id = ${chargeId}`;

      // Solo la aplicación de la caja "ve" la orden.
      route('GET', new RegExp(`/v1/orders/${mpId}$`), (_u, init) =>
        auth(init) === `Bearer ${POS_TOKEN}`
          ? jsonRes({ id: mpId, type: 'qr', status: 'processed', external_reference: o!.public_ref, total_amount: '210.00' })
          : jsonRes({ message: 'not found' }, 404));
      expect((await mpWebhook(mpId)).status).toBe(200);
      const gets = calls.filter((c) => c.method === 'GET' && c.url.includes(mpId));
      expect(gets.map((c) => c.headers.get('authorization'))).toEqual([`Bearer ${POS_TOKEN}`]);
      expect((await db()`select status from orders where id = ${chargeId}`)[0]!.status).toBe('paid');

      // Si se consulta con el token equivocado, prueba con el otro.
      calls = [];
      const order = await getOrder(mpId, 'online');
      expect(order.status).toBe('processed');
      expect(calls.map((c) => c.headers.get('authorization'))).toEqual([`Bearer ${WEB_TOKEN}`, `Bearer ${POS_TOKEN}`]);
    } finally {
      delete process.env.MP_POS_ACCESS_TOKEN;
      resetEnvCache();
    }
  });

  it('con una sola aplicación no hay segundo intento', async () => {
    route('GET', /\/v1\/orders\/ORDTST01NOEXISTE0000000001$/, () => jsonRes({ message: 'not found' }, 404));
    await expect(getOrder('ORDTST01NOEXISTE0000000001', 'pos')).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ caché del catálogo y página de gracias
describe('catálogo en la CDN y estado de la compra', () => {
  it('el catálogo se cachea en la CDN (durable) con etiqueta para invalidarlo', async () => {
    const res = await products(new Request(`${SITE}/api/products`), ctx());
    expect(res.headers.get('netlify-cdn-cache-control')).toContain('durable');
    expect(res.headers.get('netlify-cache-tag')).toBe('esdla-catalogo');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  });

  it('una venta confirmada invalida el catálogo cacheado', async () => {
    process.env.NETLIFY_PURGE_API_TOKEN = 'token-de-purga-de-prueba';
    process.env.SITE_ID = '3970e0fe-8564-4903-9a55-c5f8de49fb8b';
    try {
      const { res, mpId } = await crearCompra();
      const { ref } = (await res.json()) as { ref: string };
      route('GET', new RegExp(`/v1/orders/${mpId}$`), () => jsonRes({ id: mpId, type: 'online', status: 'processed', external_reference: ref, total_amount: '420.00' }));
      route('POST', /api\.netlify\.com\/api\/v1\/purge$/, () => jsonRes({}, 202));
      expect((await mpWebhook(mpId)).status).toBe(200);
      const purge = calls.find((c) => c.url.includes('api.netlify.com'))!;
      expect(JSON.parse(purge.body!)).toMatchObject({ cache_tags: ['esdla-catalogo'], site_id: '3970e0fe-8564-4903-9a55-c5f8de49fb8b' });
      expect(purge.headers.get('authorization')).toBe('Bearer token-de-purga-de-prueba');
    } finally {
      delete process.env.NETLIFY_PURGE_API_TOKEN;
      delete process.env.SITE_ID;
    }
  });

  it('si el webhook demora, la página de gracias hace que el servidor consulte a MP (con freno)', async () => {
    const { res, mpId } = await crearCompra();
    const { ref } = (await res.json()) as { ref: string };
    await db()`update orders set created_at = now() - interval '1 minute' where public_ref = ${ref}`;
    let mpStatus = 'created';
    route('GET', new RegExp(`/v1/orders/${mpId}$`), () => jsonRes({ id: mpId, type: 'online', status: mpStatus, external_reference: ref, total_amount: '420.00' }));
    const estado = async () => (await (await orderStatus(new Request(`${SITE}/api/orders/status?ref=${ref}`), ctx())).json()) as { status: string };
    const getsMp = () => calls.filter((c) => c.method === 'GET' && c.url.includes(mpId)).length;

    expect(await estado()).toEqual({ status: 'pending' });
    expect(getsMp()).toBe(1);
    expect(await estado()).toEqual({ status: 'pending' }); // dentro de los 20 s: no vuelve a consultar
    expect(getsMp()).toBe(1);

    mpStatus = 'processed';
    await db()`update orders set mp_checked_at = now() - interval '1 minute' where public_ref = ${ref}`;
    expect(await estado()).toEqual({ status: 'paid' });
    expect(await stockOf('ZYM-200')).toBe(8);
  });
});
