/**
 * Tienda online de la landing.
 *  - Consulta /api/products y muestra "Comprar online" solo si hay stock.
 *  - El formulario manda SKU, cantidad y contacto. El precio lo calcula el servidor.
 *  - Antes de redirigir, verifica que la URL de pago sea de Mercado Pago.
 *  - Todo texto se inserta con textContent (nunca innerHTML con datos externos).
 */
const API = '/api';
const estado = { csrf: null, productos: new Map(), actual: null };
const $ = (id) => document.getElementById(id);

const formatoPrecio = (monto) =>
  '$ ' + new Intl.NumberFormat('es-UY', { maximumFractionDigits: 2 }).format(Number(monto));

async function obtenerCsrf(forzar = false) {
  if (estado.csrf && !forzar) return estado.csrf;
  const r = await fetch(`${API}/csrf`, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error('csrf');
  estado.csrf = (await r.json()).csrfToken;
  return estado.csrf;
}

async function cargarProductos() {
  try {
    const r = await fetch(`${API}/products`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const { products } = await r.json();
    for (const p of products) estado.productos.set(p.sku, p);
  } catch {
    /* sin backend (ej. vista previa): la web sigue funcionando con WhatsApp */
  }
}

const esUrlMercadoLibre = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)mercadolibre\.com\.uy$/.test(url.hostname);
  } catch {
    return false;
  }
};

const esUrlMercadoPago = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)mercadopago\.com(\.[a-z]{2})?$/.test(url.hostname);
  } catch {
    return false;
  }
};

function decorar() {
  document.querySelectorAll('[data-comprar]').forEach((btn) => {
    const p = estado.productos.get(btn.dataset.comprar);
    if (!p || !p.buyOnline) return;
    btn.hidden = false;
    btn.textContent = `Comprar online · ${formatoPrecio(p.price)}`;
    btn.addEventListener('click', () => abrir(p.sku));
  });
  document.querySelectorAll('[data-sin-online]').forEach((el) => {
    const p = estado.productos.get(el.dataset.sinOnline);
    if (p && p.buyOnline) el.hidden = true;
  });
  document.querySelectorAll('[data-ml-link]').forEach((a) => {
    const p = estado.productos.get(a.dataset.mlLink);
    if (!p || !p.mercadoLibreUrl || !esUrlMercadoLibre(p.mercadoLibreUrl)) return;
    a.href = p.mercadoLibreUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.hidden = false;
  });
}

function mostrarEstado(tipo, texto) {
  const el = $('compra-estado');
  el.className = `form-estado ${tipo}`;
  el.textContent = texto;
  el.hidden = false;
}

function actualizarTotal() {
  const p = estado.productos.get(estado.actual);
  if (!p) return;
  const cantidad = Number($('c-cantidad').value) || 1;
  $('compra-total').textContent = formatoPrecio(Number(p.price) * cantidad);
}

function abrir(sku) {
  const p = estado.productos.get(sku);
  const dialogo = $('compra');
  if (!p || !dialogo || typeof dialogo.showModal !== 'function') return;
  estado.actual = sku;
  $('compra-nombre').textContent = p.name;
  $('compra-precio').textContent = ` · ${formatoPrecio(p.price)} c/u`;
  const select = $('c-cantidad');
  select.replaceChildren();
  const max = p.lowStock ? 3 : 6;
  for (let i = 1; i <= max; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = String(i);
    select.append(opt);
  }
  $('compra-estado').hidden = true;
  actualizarTotal();
  dialogo.showModal();
  $('c-nombre').focus();
}

function datosDelFormulario(form) {
  const f = new FormData(form);
  const entrega = f.get('entrega') === 'envio' ? 'envio' : 'retiro';
  const customer = {
    name: String(f.get('nombre') ?? '').trim(),
    phone: String(f.get('telefono') ?? '').trim(),
    delivery: entrega,
  };
  const direccion = String(f.get('direccion') ?? '').trim();
  const notas = String(f.get('notas') ?? '').trim();
  if (entrega === 'envio') customer.address = direccion;
  if (notas) customer.notes = notas;
  return { items: [{ sku: estado.actual, quantity: Number(f.get('cantidad')) || 1 }], customer };
}

function validarLocal(datos) {
  if (datos.customer.name.length < 2) return 'Completá tu nombre.';
  if (!/^[\d\s+()-]{8,20}$/.test(datos.customer.phone)) return 'Revisá el celular (ej: 099 123 456).';
  if (datos.customer.delivery === 'envio' && (datos.customer.address ?? '').length < 5) return 'Completá la dirección de envío.';
  return null;
}

async function enviar(evento) {
  evento.preventDefault();
  const form = evento.currentTarget;
  const boton = $('compra-pagar');
  const datos = datosDelFormulario(form);
  const error = validarLocal(datos);
  if (error) return mostrarEstado('error', error);

  boton.disabled = true;
  boton.textContent = 'Preparando el pago…';
  try {
    const intentar = async (forzarCsrf) =>
      fetch(`${API}/checkout`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await obtenerCsrf(forzarCsrf) },
        body: JSON.stringify(datos),
      });
    let r = await intentar(false);
    if (r.status === 403) r = await intentar(true); // token vencido: se renueva una vez
    const cuerpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(cuerpo.message || 'No pudimos iniciar el pago.');
    if (!esUrlMercadoPago(cuerpo.checkoutUrl)) throw new Error('Respuesta de pago inesperada.');
    try {
      sessionStorage.setItem('esdla_ref', cuerpo.ref);
    } catch {
      /* almacenamiento bloqueado: la página de gracias usa el parámetro de Mercado Pago */
    }
    window.location.assign(cuerpo.checkoutUrl);
  } catch (err) {
    mostrarEstado('error', err instanceof Error ? err.message : 'No pudimos iniciar el pago.');
    boton.disabled = false;
    boton.textContent = 'Ir a pagar con Mercado Pago';
  }
}

function conectarDialogo() {
  const dialogo = $('compra');
  const form = $('compra-form');
  if (!dialogo || !form) return;
  $('compra-cerrar').addEventListener('click', () => dialogo.close());
  $('c-cantidad').addEventListener('change', actualizarTotal);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'entrega') $('c-direccion-campo').hidden = e.target.value !== 'envio';
  });
  form.addEventListener('submit', enviar);
  dialogo.addEventListener('click', (e) => {
    if (e.target === dialogo) dialogo.close(); // clic fuera del cuadro
  });
}

conectarDialogo();
await cargarProductos();
decorar();
