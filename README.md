# El Secreto de la Abuela · landing + integraciones

Landing de ESDLA (sitio estático) con un backend serverless que conecta:

- **Mercado Pago**: compra online (Checkout Pro, Orders API), cobro en ferias con QR (estático o dinámico) y Point en modo integrado (opcional).
- **Mercado Libre**: conexión OAuth de la cuenta vendedora, ventas que descuentan el stock propio y stock propio que se replica en las publicaciones.

Ninguna credencial llega al navegador: los tokens viven solo en las funciones de Netlify, en variables de entorno, y lo que se guarda en la base va cifrado.

La guía paso a paso (qué credenciales sacar, dónde y cómo configurarlas) está en **[docs/GUIA-INTEGRACION.md](docs/GUIA-INTEGRACION.md)**.

## Stack

| Capa | Tecnología |
|---|---|
| Sitio | HTML/CSS/JS estático en `public/` (sin scripts inline, CSP estricta) |
| Backend | Netlify Functions (API moderna, Node 22, TypeScript, esbuild) |
| Base de datos | Postgres (Neon) con TLS `verify-full`, consultas parametrizadas (`postgres` 3.4.9) |
| Validación | zod 4 (`strictObject` en todo lo que entra) |
| Cifrado | AES-256-GCM con AAD y rotación de claves; scrypt para la contraseña del panel |
| Tests | vitest + PGlite (Postgres real en WASM) + APIs de MP/ML simuladas |

## Estructura

```
public/                      sitio publicado (landing, recetario, gracias, panel /admin)
  js/tienda.js               botón "Comprar online": pide CSRF, valida y redirige solo a Mercado Pago
  admin/                     panel: caja (QR/Point), pedidos web, stock, integraciones
netlify/functions/           una función por grupo de rutas (ver tabla)
src/
  config/env.ts              variables de entorno validadas (falla cerrado si falta algo)
  lib/                       crypto, http, csrf, sesión, cookies, rate limit, logger con redacción, db, cdn
  integrations/mercadopago/  cliente HTTP, orders (online/QR/Point), caja y sucursal, firma de webhooks
  integrations/mercadolibre/ OAuth con PKCE y refresh con candado, cliente, órdenes/ítems, notificaciones
  services/                  órdenes, inventario (combos incluidos), sincronización y mantenimiento
db/schema.sql, db/seed.sql   esquema idempotente y catálogo inicial
scripts/                     migración, generación de secretos y hash de la contraseña del panel
tests/                       unitarios + flujos completos
docs/GUIA-INTEGRACION.md     requisitos, paso a paso, seguridad y operación
```

## Rutas

| Ruta | Método | Quién | Qué hace |
|---|---|---|---|
| `/api/csrf` | GET | público | Entrega token CSRF + cookie `__Host-` firmada |
| `/api/products` | GET | público | Catálogo (sin stock exacto). Cacheado en la CDN, se invalida al cambiar el stock |
| `/api/checkout` | POST | público + CSRF | Crea la compra con precios del servidor y devuelve el link de pago de MP |
| `/api/orders/status?ref=` | GET | público | Estado de una compra (si sigue pendiente, consulta a MP con freno) |
| `/api/webhooks/mercadopago` | POST | Mercado Pago | Verifica la firma, consulta la orden a la API y concilia |
| `/api/webhooks/mercadolibre` | POST | Mercado Libre | Filtra por IP, responde en < 500 ms y procesa en segundo plano |
| `/api/admin/session` | GET/POST/DELETE | panel | Estado, login (scrypt + límite de intentos), logout |
| `/api/admin/ml/connect`, `/callback` | GET | panel | OAuth de Mercado Libre (state + PKCE) |
| `/api/admin/pos/...` | GET/POST | panel + CSRF | Cobros QR/Point, estado, cancelación, alta de caja, terminales |
| `/api/admin/orders`, `/products`, `/integrations` | GET/POST | panel + CSRF | Pedidos, stock, vínculo con ML, estado y sincronización |
| `maintenance` | programada | Netlify | Cada 30 min: token de ML, reintentos, conciliación, stock a ML, limpieza |

## Comandos

```bash
npm ci                    # instala dependencias exactas (package-lock.json)
npm run check             # TypeScript estricto
npm test                  # unitarios + flujos completos (Postgres en memoria; no tocan APIs reales)
npm run gen:secrets       # genera ENCRYPTION_KEYS, SESSION_SECRET y CSRF_SECRET
npm run hash-password     # genera ADMIN_PASSWORD_HASH (pide la contraseña, mínimo 14 caracteres)
DATABASE_URL="..." npm run db:migrate   # crea tablas y catálogo (se puede repetir sin romper nada)
```

Desarrollo local: `npm i -g netlify-cli`, `netlify link` y `netlify dev` (toma las variables del contexto "Local development" de Netlify o de un `.env` basado en `.env.example`). Usá credenciales de **prueba** y una rama de base de datos aparte.

## Deploy

El sitio se publica desde Git en Netlify (Netlify Drop no publica funciones). `netlify.toml` ya define carpeta, comando de build (typecheck), Node 22, funciones y cabeceras de seguridad. Las variables de entorno se cargan en Netlify, nunca en el repo. Detalle completo en la guía.
