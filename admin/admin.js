/**
 * Panel admin (caja, pedidos, stock e integraciones).
 * La sesión vive en una cookie HttpOnly; este script nunca ve ni guarda credenciales.
 * Todo dato se inserta con textContent.
 */
const $ = (id) => document.getElementById(id);
let csrf = null;
const caja = { productos: [], carrito: new Map(), cobro: null, timer: null };

const pesos = (cents) => '$ ' + new Intl.NumberFormat('es-UY', { maximumFractionDigits: 2 }).format(cents / 100);
const el = (tag, props = {}, ...hijos) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const h of hijos) if (h != null) n.append(h);
  return n;
};

function avisar(tipo, texto) {
  const a = $('aviso');
  a.className = `aviso ${tipo}`;
  a.textContent = texto;
  a.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => (a.hidden = true), 7000);
}

async function obtenerCsrf(forzar = false) {
  if (csrf && !forzar) return csrf;
  const r = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
  csrf = (await r.json()).csrfToken;
  return csrf;
}

async function api(ruta, { method = 'GET', body } = {}) {
  const hacer = async (forzar) => {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-CSRF-Token'] = await obtenerCsrf(forzar);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(ruta, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  };
  let r = await hacer(false);
  if (r.status === 403 && method !== 'GET') r = await hacer(true);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    mostrarLogin();
    throw new Error(data.message || 'Sesión vencida');
  }
  if (!r.ok) throw new Error(data.message || `Error ${r.status}`);
  return data;
}

// ---------------------------------------------------------------- sesión
function mostrarLogin() {
  $('vista-app').hidden = true;
  $('salir').hidden = true;
  $('vista-login').hidden = false;
  $('l-pass').focus();
}

async function mostrarApp() {
  $('vista-login').hidden = true;
  $('vista-app').hidden = false;
  $('salir').hidden = false;
  await Promise.allSettled([cargarCaja(), cargarIntegraciones()]);
}

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.hidden = true;
  try {
    await api('/api/admin/session', { method: 'POST', body: { password: $('l-pass').value } });
    $('l-pass').value = '';
    await mostrarApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('salir').addEventListener('click', async () => {
  await api('/api/admin/session', { method: 'DELETE' }).catch(() => undefined);
  mostrarLogin();
});

// ---------------------------------------------------------------- pestañas
document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `panel-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'pedidos') cargarPedidos();
    if (tab.dataset.tab === 'stock') cargarStock();
    if (tab.dataset.tab === 'integraciones') cargarIntegraciones();
  }),
);

// ---------------------------------------------------------------- caja
async function cargarCaja() {
  const { products } = await api('/api/admin/products');
  caja.productos = products.filter((p) => p.active && p.priceCents > 0);
  const cont = $('caja-productos');
  cont.replaceChildren(
    ...caja.productos.map((p) =>
      el('button', { type: 'button', class: 'prod', onclick: () => sumar(p.sku, 1) },
        el('strong', { text: p.name }),
        el('span', { text: `${pesos(p.priceCents)} · disp. ${p.available}` })),
    ),
  );
  pintarCarrito();
}

function sumar(sku, n) {
  const actual = caja.carrito.get(sku) ?? 0;
  const nuevo = Math.max(0, Math.min(20, actual + n));
  if (nuevo === 0) caja.carrito.delete(sku);
  else caja.carrito.set(sku, nuevo);
  pintarCarrito();
}

function pintarCarrito() {
  const lista = $('caja-carrito');
  let total = 0;
  const items = [...caja.carrito].map(([sku, cant]) => {
    const p = caja.productos.find((x) => x.sku === sku);
    total += (p?.priceCents ?? 0) * cant;
    return el('li', {},
      el('span', { text: p?.name ?? sku }),
      el('span', { class: 'cant' },
        el('button', { type: 'button', 'aria-label': 'Restar', text: '−', onclick: () => sumar(sku, -1) }),
        el('strong', { text: String(cant) }),
        el('button', { type: 'button', 'aria-label': 'Sumar', text: '+', onclick: () => sumar(sku, 1) })));
  });
  lista.replaceChildren(...(items.length ? items : [el('li', { text: 'Tocá un producto para agregarlo.' })]));
  $('caja-total').textContent = pesos(total);
  $('caja-cobrar').disabled = items.length === 0 || caja.cobro !== null;
}

$('caja-limpiar').addEventListener('click', () => {
  caja.carrito.clear();
  pintarCarrito();
});

$('caja-cobrar').addEventListener('click', async () => {
  const metodo = document.querySelector('input[name="metodo"]:checked')?.value ?? 'qr_static';
  const items = [...caja.carrito].map(([sku, quantity]) => ({ sku, quantity }));
  $('caja-cobrar').disabled = true;
  try {
    const c = await api('/api/admin/pos/charges', { method: 'POST', body: { items, method: metodo } });
    caja.cobro = c.chargeId;
    $('caja-cobro').hidden = false;
    const img = $('cobro-qr');
    const qr = c.qrImage || c.staticQrImage;
    if (qr && (qr.startsWith('data:image/png;base64,') || qr.startsWith('https://'))) {
      img.src = qr;
      img.hidden = false;
    } else {
      img.hidden = true;
    }
    const estado = $('cobro-estado');
    estado.className = 'cobro-estado';
    estado.textContent =
      metodo === 'point' ? `Cobrando ${pesos(c.totalCents)} en la Point…`
      : metodo === 'qr_dynamic' ? `Escaneá este QR para pagar ${pesos(c.totalCents)}`
      : `El cliente escanea el QR del puesto y paga ${pesos(c.totalCents)}`;
    if (c.lowStock) avisar('error', 'Ojo: según el sistema no hay stock suficiente. Revisá la pestaña Stock.');
    esperarPago(c.chargeId, Date.now());
  } catch (ex) {
    avisar('error', ex.message);
    pintarCarrito();
  }
});

function esperarPago(id, inicio) {
  clearTimeout(caja.timer);
  caja.timer = setTimeout(async () => {
    if (caja.cobro !== id) return;
    try {
      const { status } = await api(`/api/admin/pos/charges/${encodeURIComponent(id)}`);
      if (status === 'paid') return terminarCobro('ok', '¡Pago aprobado!');
      if (['canceled', 'expired', 'failed'].includes(status)) return terminarCobro('error', 'El cobro no se completó.');
    } catch {
      /* reintenta */
    }
    if (Date.now() - inicio < 10 * 60 * 1000) esperarPago(id, inicio);
    else terminarCobro('error', 'Venció el tiempo de espera.');
  }, 2000);
}

function terminarCobro(tipo, texto) {
  const estado = $('cobro-estado');
  estado.className = `cobro-estado ${tipo}`;
  estado.textContent = texto;
  $('cobro-qr').hidden = true;
  if (tipo === 'ok') caja.carrito.clear();
  caja.cobro = null;
  setTimeout(() => ($('caja-cobro').hidden = true), tipo === 'ok' ? 4000 : 6000);
  pintarCarrito();
  cargarCaja().catch(() => undefined);
}

$('cobro-cancelar').addEventListener('click', async () => {
  if (!caja.cobro) return;
  try {
    await api(`/api/admin/pos/charges/${encodeURIComponent(caja.cobro)}/cancel`, { method: 'POST' });
    terminarCobro('error', 'Cobro cancelado.');
  } catch (ex) {
    avisar('error', ex.message);
  }
});

// ---------------------------------------------------------------- pedidos
async function cargarPedidos() {
  const cont = $('pedidos-lista');
  cont.replaceChildren(el('p', { class: 'ayuda', text: 'Cargando…' }));
  try {
    const { orders } = await api('/api/admin/orders');
    if (!orders.length) return cont.replaceChildren(el('p', { class: 'ayuda', text: 'Todavía no hay pedidos pagados.' }));
    cont.replaceChildren(
      ...orders.map((o) => {
        const c = o.customer ?? {};
        const tel = typeof c.phone === 'string' ? c.phone.replace(/\D/g, '') : '';
        const wa = tel ? el('a', { href: `https://wa.me/${tel}`, target: '_blank', rel: 'noopener noreferrer', text: c.phone }) : null;
        return el('article', { class: 'pedido' },
          el('strong', { text: `${c.name ?? 'Sin nombre'} · ${pesos(o.totalCents)}` }),
          el('span', { class: 'meta', text: `${new Date(o.createdAt).toLocaleString('es-UY')} · ${o.status === 'paid' ? 'Pagado' : o.status} · ${o.ref}` }),
          el('span', { text: o.items.map((i) => `${i.quantity} × ${i.sku}`).join(', ') }),
          el('span', {}, 'Celular: ', wa ?? '—'),
          el('span', { text: c.delivery === 'envio' ? `Envío a: ${c.address ?? ''}` : 'Retiro' }),
          c.notes ? el('span', { class: 'meta', text: `Notas: ${c.notes}` }) : null);
      }),
    );
  } catch (ex) {
    cont.replaceChildren(el('p', { class: 'error', text: ex.message }));
  }
}
$('pedidos-recargar').addEventListener('click', cargarPedidos);

// ---------------------------------------------------------------- stock
async function cargarStock() {
  const tbody = $('stock-tabla').querySelector('tbody');
  const { products } = await api('/api/admin/products');
  tbody.replaceChildren(
    ...products.map((p) => {
      const stock = el('input', { type: 'number', min: '0', max: '100000', step: '1', class: 'num', 'aria-label': `Stock de ${p.name}` });
      stock.value = p.stock ?? '';
      if (p.isBundle) stock.disabled = true;
      const ml = el('input', { class: 'ml', placeholder: 'MLU123456789', maxlength: '20', 'aria-label': 'Publicación de Mercado Libre' });
      ml.value = p.mlItemId ?? '';
      const variacion = el('input', { class: 'var', placeholder: 'Variación (opcional)', inputmode: 'numeric', maxlength: '20', 'aria-label': 'Id de variación' });
      variacion.value = p.mlVariationId ?? '';
      const guardar = el('button', { type: 'button', class: 'btn btn-sec', text: 'Guardar' });
      guardar.addEventListener('click', async () => {
        guardar.disabled = true;
        try {
          if (!p.isBundle && stock.value !== '' && Number(stock.value) !== p.stock) {
            await api(`/api/admin/products/${encodeURIComponent(p.sku)}/stock`, { method: 'POST', body: { stock: Number(stock.value) } });
          }
          const nuevoMl = ml.value.trim().toUpperCase();
          if (nuevoMl && (nuevoMl !== p.mlItemId || variacion.value.trim() !== (p.mlVariationId ?? ''))) {
            await api(`/api/admin/products/${encodeURIComponent(p.sku)}/ml`, {
              method: 'POST',
              body: { mlItemId: nuevoMl, mlVariationId: variacion.value.trim() ? Number(variacion.value.trim()) : null },
            });
          }
          avisar('ok', `${p.name}: guardado.`);
          await cargarStock();
        } catch (ex) {
          avisar('error', ex.message);
        } finally {
          guardar.disabled = false;
        }
      });
      const pendiente = p.mlPending ? el('span', { class: 'pill mal', text: p.mlPending.last_error ? 'Error al sincronizar' : 'Sincronizando' }) : null;
      return el('tr', {},
        el('td', {}, el('strong', { text: p.name }), el('br'), el('small', { text: p.sku })),
        el('td', {}, stock),
        el('td', { text: String(p.available) }),
        el('td', {}, ml, ' ', variacion, ' ', pendiente),
        el('td', {}, guardar));
    }),
  );
}

// ---------------------------------------------------------------- integraciones
function fila(dl, k, v) {
  dl.append(el('dt', { text: k }), el('dd', {}, v));
}

async function cargarIntegraciones() {
  const d = await api('/api/admin/integrations');
  const ml = $('int-ml');
  ml.replaceChildren();
  fila(ml, 'Estado', el('span', { class: `pill ${d.mercadolibre.connected ? 'ok' : 'mal'}`, text: d.mercadolibre.connected ? 'Conectado' : d.mercadolibre.status === 'reauth_required' ? 'Hay que reconectar' : 'Sin conectar' }));
  if (d.mercadolibre.accountId) fila(ml, 'Cuenta', d.mercadolibre.accountId);
  if (d.mercadolibre.tokenExpiresAt) fila(ml, 'Token vence', new Date(d.mercadolibre.tokenExpiresAt).toLocaleString('es-UY'));
  $('ml-conectar').textContent = d.mercadolibre.connected ? 'Reconectar Mercado Libre' : 'Conectar Mercado Libre';
  $('ml-conectar').hidden = !d.mercadolibre.configured;

  const mp = $('int-mp');
  mp.replaceChildren();
  fila(mp, 'Credenciales', el('span', { class: `pill ${d.mercadopago.configured ? 'ok' : 'mal'}`, text: d.mercadopago.configured ? 'Cargadas' : 'Faltan' }));
  fila(mp, 'Aplicaciones', d.mercadopago.separatePosApp ? 'Web y caja por separado' : 'Una sola');
  fila(mp, 'Webhook', d.mercadopago.webhookSecrets ? `${d.mercadopago.webhookSecrets} clave(s)` : 'Sin clave secreta');
  fila(mp, 'Compra online', d.mercadopago.onlineCheckout ? 'Activa' : 'En pausa');
  fila(mp, 'Point', d.mercadopago.pointTerminal ? 'Configurada' : 'No');
  $('metodo-point').hidden = !d.mercadopago.pointTerminal;
  if (d.mercadopago.pos) {
    fila(mp, 'Caja', `Sucursal ${d.mercadopago.pos.storeId} · caja ${d.mercadopago.pos.posId}`);
    if (d.mercadopago.pos.qrTemplatePdf?.startsWith('https://')) {
      fila(mp, 'QR para imprimir', el('a', { href: d.mercadopago.pos.qrTemplatePdf, target: '_blank', rel: 'noopener noreferrer', text: 'Descargar PDF' }));
    }
  }
  $('form-pos').hidden = Boolean(d.mercadopago.pos) || !d.mercadopago.configured;

  const sync = $('int-sync');
  sync.replaceChildren();
  fila(sync, 'Stock por enviar a ML', String(d.sync.pendingStockPushes));
  fila(sync, 'Webhooks con error', String(d.sync.failedWebhooks));
  fila(sync, 'Última sincronización', d.sync.lastMaintenance?.at ? new Date(d.sync.lastMaintenance.at).toLocaleString('es-UY') : '—');
}

$('form-pos').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  const body = {
    storeName: String(f.get('storeName') ?? ''),
    streetName: String(f.get('streetName') ?? ''),
    streetNumber: String(f.get('streetNumber') ?? ''),
    cityName: String(f.get('cityName') ?? ''),
    stateName: String(f.get('stateName') ?? ''),
    latitude: Number(String(f.get('latitude') ?? '').replace(',', '.')),
    longitude: Number(String(f.get('longitude') ?? '').replace(',', '.')),
  };
  try {
    await api('/api/admin/pos/setup', { method: 'POST', body });
    avisar('ok', 'Caja creada. Ya podés cobrar con QR.');
    await cargarIntegraciones();
  } catch (ex) {
    avisar('error', ex.message);
  }
});

// Point: listar terminales de la cuenta y pasarlas a modo integrado (PDV).
$('point-buscar').addEventListener('click', async () => {
  const lista = $('point-lista');
  lista.hidden = false;
  lista.replaceChildren(el('li', { text: 'Buscando…' }));
  try {
    const { terminals } = await api('/api/admin/pos/terminals');
    lista.replaceChildren();
    if (!terminals.length) {
      lista.append(el('li', { text: 'No hay terminales vinculadas a esta cuenta de Mercado Pago.' }));
      return;
    }
    for (const t of terminals) {
      const modo = el('span', { class: `pill ${t.operatingMode === 'PDV' ? 'ok' : 'mal'}`, text: t.operatingMode === 'PDV' ? 'Integrada (PDV)' : t.operatingMode || 'Sin integrar' });
      const boton = el('button', { type: 'button', class: 'btn btn-sec', text: 'Pasar a modo PDV' });
      boton.hidden = t.operatingMode === 'PDV';
      boton.addEventListener('click', async () => {
        boton.disabled = true;
        try {
          await api(`/api/admin/pos/terminals/${encodeURIComponent(t.id)}/pdv`, { method: 'POST' });
          modo.className = 'pill ok';
          modo.textContent = 'Integrada (PDV)';
          boton.hidden = true;
          avisar('ok', 'Listo. Copiá el id de la terminal en MP_POINT_TERMINAL_ID (Netlify) y hacé un deploy.');
        } catch (ex) {
          boton.disabled = false;
          avisar('error', ex.message);
        }
      });
      lista.append(el('li', {}, el('code', { text: t.id }), modo, boton));
    }
  } catch (ex) {
    lista.replaceChildren(el('li', { text: ex.message }));
  }
});

$('sync-ahora').addEventListener('click', async () => {
  const pre = $('sync-reporte');
  pre.hidden = false;
  pre.textContent = 'Sincronizando…';
  try {
    const { report } = await api('/api/admin/integrations/sync', { method: 'POST' });
    pre.textContent = JSON.stringify(report, null, 2);
    await cargarIntegraciones();
  } catch (ex) {
    pre.textContent = ex.message;
  }
});

// ---------------------------------------------------------------- inicio
const mensajesMl = {
  conectado: ['ok', 'Mercado Libre quedó conectado.'],
  cancelado: ['error', 'Cancelaste la conexión con Mercado Libre.'],
  'cuenta-incorrecta': ['error', 'Esa no es la cuenta vendedora configurada (ML_SELLER_USER_ID).'],
  'falta-offline-access': ['error', 'La app de Mercado Libre no tiene el permiso offline_access.'],
  'sesion-vencida': ['error', 'Pasaron más de 10 minutos. Volvé a tocar Conectar.'],
  error: ['error', 'No se pudo conectar Mercado Libre. Probá de nuevo.'],
};
const estadoMl = new URLSearchParams(location.search).get('ml');
if (estadoMl && mensajesMl[estadoMl]) {
  avisar(...mensajesMl[estadoMl]);
  history.replaceState(null, '', location.pathname);
}

try {
  const { authenticated } = await (await fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' })).json();
  if (authenticated) await mostrarApp();
  else mostrarLogin();
} catch {
  mostrarLogin();
}
