# Guía de integración · Mercado Pago + Mercado Libre

**El Secreto de la Abuela** · qué hay que sacar, dónde, y cómo dejarlo andando sin exponer ninguna credencial.

Tiempo estimado: una tarde para dejar todo en **pruebas** y otra para pasar a **producción**.

---

## 0. Qué hace el sistema

- **Compra online**: el botón "Comprar online" de la landing crea la compra en el servidor (con precios del servidor) y manda al cliente a pagar a Mercado Pago (Checkout Pro). Cuando MP confirma, se descuenta el stock.
- **Caja para ferias**: desde `/admin` → *Caja* cobran con el QR impreso del puesto, con un QR en pantalla o con una Point integrada (opcional). Al pagar, se descuenta el stock.
- **Mercado Libre**: cuando venden por ML, el sistema se entera, descuenta el stock propio, y cada cambio de stock propio se copia a las publicaciones de ML. **Un solo stock para los tres canales.**

```
 Navegador ──HTTPS──▶ Netlify (sitio estático, CSP estricta)
                         │
                         └─ /api/* ──▶ Funciones de Netlify (Node 22)
                                          │  tokens de MP/ML solo acá (variables de entorno)
                                          ├──TLS verify-full──▶ Postgres (Neon) · datos sensibles cifrados AES-256-GCM
                                          ├──HTTPS──▶ API de Mercado Pago   ◀── webhooks firmados (HMAC)
                                          └──HTTPS──▶ API de Mercado Libre  ◀── notificaciones (IPs de ML)
```

Lo que el sistema **nunca** hace: mandar un token al navegador, aceptar un precio que venga del navegador, ni dar por pagado algo porque lo diga un webhook (siempre lo confirma consultando la API con su propio token).

---

## 1. Lista de lo que necesitan

| # | Qué | Dónde se saca | Variable(s) en Netlify | Costo |
|---|---|---|---|---|
| 1 | Repositorio privado | github.com | — | Gratis |
| 2 | Proyecto en Netlify | netlify.com | — | Gratis (300 créditos/mes, ver §4.4) |
| 3 | Dominio (opcional al principio) | Registrador de .uy / .com.uy | `SITE_URL`, `ML_REDIRECT_URI` | Según registrador |
| 4 | Certificado HTTPS | Automático en Netlify (Let's Encrypt) | — | Gratis |
| 5 | Base Postgres | neon.com | `DATABASE_URL`, `DATABASE_SSL` | Gratis (100 CU-hora/mes, ver §4.4) |
| 6 | Claves propias de la app | `npm run gen:secrets` | `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY`, `SESSION_SECRET`, `CSRF_SECRET` | — |
| 7 | Contraseña del panel | `npm run hash-password` | `ADMIN_PASSWORD_HASH` | — |
| 8 | App de MP para la web (Checkout Pro) | MP Developers → Tus integraciones | `MP_ACCESS_TOKEN` | Comisión de MP por venta |
| 9 | App de MP para la caja (Código QR) | Ídem | `MP_POS_ACCESS_TOKEN` | Ídem |
| 10 | Claves secretas de webhooks MP | Cada app → Webhooks | `MP_WEBHOOK_SECRETS` | — |
| 11 | App de Mercado Libre | DevCenter de ML | `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI` | — |
| 12 | Id de la cuenta vendedora de ML | Aparece en `/admin` al conectar | `ML_SELLER_USER_ID` | — |
| 13 | Point Smart (opcional) | App de Mercado Pago + `/admin` | `MP_POINT_TERMINAL_ID` | Compra de la terminal |

Necesitan además, en la compu desde donde hagan el paso 5: **Node.js 22** (nodejs.org) y **Git**.

> **Regla de oro de las credenciales:** se pegan *solo* en Netlify (o en un gestor de contraseñas). Nunca en el código, en un mail, en WhatsApp ni en una captura de pantalla.

---

## 2. Paso a paso

### Paso 1 · Subir el código a GitHub

1. Creen un repositorio **privado** en GitHub (por ejemplo `esdla-web`).
2. Descompriman el ZIP y, dentro de la carpeta:
   ```bash
   git init
   git add .
   git commit -m "ESDLA: landing + integraciones"
   git branch -M main
   git remote add origin https://github.com/USUARIO/esdla-web.git
   git push -u origin main
   ```
3. Creen también la rama de pruebas: `git checkout -b pruebas && git push -u origin pruebas && git checkout main`.

`.gitignore` ya excluye `.env` y `node_modules`: si algún día crean un `.env` local, no se sube.

### Paso 2 · Crear el proyecto en Netlify

1. En Netlify: **Add new project → Import an existing project → GitHub** y elegí el repo.
2. La configuración de build ya viene en `netlify.toml` (carpeta `public`, comando `npm run build`, funciones en `netlify/functions`, Node 22). No cambien nada.
3. Netlify hace un primer deploy apenas crean el proyecto: la landing se ve, pero la tienda y el panel responden "no disponible" hasta cargar las variables (Paso 8). Es normal. El nombre del proyecto define la URL `https://NOMBRE.netlify.app`, que van a necesitar en los pasos 6 y 7.
4. **Rama de pruebas**: *Project configuration → Build & deploy → Branches and deploy contexts → Branch deploys* → agregá la rama `pruebas`. Va a quedar publicada en `https://pruebas--NOMBRE-DEL-PROYECTO.netlify.app`. Los deploys de rama no consumen créditos.
5. **Formulario de contacto** (Netlify Forms): en *Forms* activen la detección de formularios (*Enable form detection*; corre desde el próximo deploy). Después, en *Project configuration → Notifications → Emails and webhooks*, agreguen un aviso por email de envíos del formulario a `elsecretodelaabuela.uy@gmail.com`.

> **Ojo**: *Netlify Drop* (arrastrar la carpeta) **no publica funciones**. Tiene que ser desde Git (o con `netlify deploy` de la CLI).

### Paso 3 · Dominio y certificados

1. *Domain management → Add a domain* → sigan el asistente (usar los DNS de Netlify es lo más simple).
2. **HTTPS**: Netlify emite y renueva solo un certificado de Let's Encrypt. No hay que comprar ni instalar certificados.
3. Hasta tener dominio pueden usar el `https://NOMBRE.netlify.app` en `SITE_URL` y `ML_REDIRECT_URI`. Cuando cambien al dominio, actualicen esas dos variables, la URI en el DevCenter de ML y las URLs de webhooks en MP.

Qué certificados intervienen y quién se encarga:

| Tramo | Certificado | Quién lo gestiona |
|---|---|---|
| Visitante ↔ sitio y APIs propias | Let's Encrypt para su dominio + HSTS de 2 años | Netlify, automático |
| Funciones ↔ base de datos | Certificado público de Neon, verificado completo (`DATABASE_SSL=verify-full`) | Neon; la app rechaza cualquier certificado inválido |
| Funciones ↔ Mercado Pago / Mercado Libre | HTTPS de cada plataforma, validado por Node | Ellos; la app además bloquea redirecciones |
| MP/ML ↔ webhooks | El mismo HTTPS de su dominio (MP y ML exigen https) | Netlify |

No hace falta certificado de cliente (mTLS) para ninguna de las dos plataformas.

> El HSTS va con `includeSubDomains`: si algún día usan un subdominio (ej. `tienda.`), tiene que tener HTTPS también.

### Paso 4 · Base de datos (Neon)

1. Creen la cuenta en **neon.com** → *New project*. Región: **AWS US East 2 (Ohio)**, la misma donde Netlify corre las funciones por defecto (menos latencia).
2. En la configuración del cómputo dejen el mínimo en **0.25 CU** (es lo que hace rendir el plan gratis).
3. Botón **Connect** → activá *Connection pooling* → copiá la cadena (tiene `-pooler` en el host). Esa es `DATABASE_URL` de **producción**.
4. Creen una **rama** de base para pruebas (*Branches → New branch*, nombre `pruebas`) y copien su cadena *pooled*: es `DATABASE_URL` de la **rama pruebas**. Así las compras de prueba nunca tocan el stock real.
5. Creen las tablas y el catálogo en **las dos** ramas. Cualquiera de estas dos formas:
   - **Desde la compu** (con Node 22): `npm ci` y después `DATABASE_URL="postgres://...pooler..." npm run db:migrate`.
   - **Sin instalar nada**: en Neon, *SQL Editor* → peguen el contenido de `db/schema.sql` → *Run*; después `db/seed.sql` → *Run*.

   Se puede repetir sin romper nada (no duplica ni pisa datos).

Neon cifra el almacenamiento; además la app cifra por su cuenta los tokens de ML y el contacto de los compradores, así que un volcado de la base no los expone.

### Paso 5 · Claves propias y contraseña del panel

En la carpeta del proyecto (después de `npm ci`):

```bash
npm run gen:secrets      # imprime ENCRYPTION_KEYS, ENCRYPTION_ACTIVE_KEY, SESSION_SECRET y CSRF_SECRET
npm run hash-password    # pide la contraseña del panel (mínimo 14 caracteres) e imprime ADMIN_PASSWORD_HASH
```

- Generen **un juego para producción y otro distinto para pruebas** (corran los comandos dos veces).
- Guarden todo en un gestor de contraseñas (Bitwarden, 1Password). **Si se pierde `ENCRYPTION_KEYS`, lo cifrado no se recupera**: habría que reconectar ML y se perderían los contactos de compradores guardados.
- La contraseña del panel no se guarda en ningún lado del sistema: solo su hash.

### Paso 6 · Mercado Pago

#### 6.1 Cuenta

Usen la cuenta de Mercado Pago **del negocio** (la que va a recibir la plata), con los datos validados. Entren a **mercadopago.com.uy/developers** con esa cuenta y vayan a **Tus integraciones**.

#### 6.2 Aplicación para la web (Checkout Pro)

1. **Crear aplicación** → en la solución a integrar elegí **Checkout Pro**.
2. En el tipo de API elegí **Orders** (no "Preferencias").
3. Nombre: `ESDLA Web` → aceptá los términos → **Crear aplicación**.

#### 6.3 Aplicación para la caja (Código QR)

Mercado Pago asocia cada aplicación a una solución, así que la caja va en una segunda aplicación:

1. **Crear aplicación** → solución **Código QR** → nombre `ESDLA Caja` → **Crear aplicación**.
2. Su Access Token va en `MP_POS_ACCESS_TOKEN`. Si dejan esa variable sin cargar, la caja usa `MP_ACCESS_TOKEN` (sirve solo si MP les deja operar QR con la app de la web).

#### 6.4 Credenciales de prueba y de producción

Dentro de cada aplicación, el selector de arriba cambia entre **Prueba** y **Producción**. Antes de copiar, fíjense en cuál están.

- **Prueba**: ya vienen creadas. *Credenciales* → copiá el **Access Token** (empieza con `APP_USR-`). Va en `MP_ACCESS_TOKEN` / `MP_POS_ACCESS_TOKEN` de la **rama pruebas**. Los pagos de prueba se ven en la pestaña *Pagos de prueba* de la aplicación.
- **Producción**: *Credenciales* → **Producción** → *Activar* → completá **rubro** y **sitio web** (su dominio) → aceptá → *Activar*. Copiá el **Access Token** de producción: va en las mismas variables pero del contexto **Production**.
- La **Public Key** no se usa: el cliente paga en la página de Mercado Pago, no en un formulario propio.
- **Client ID / Client Secret** de MP tampoco: son para integradores que cobran a nombre de terceros.

#### 6.5 Webhooks (los avisos de pago)

En **cada** aplicación (web y caja):

1. **Webhooks → Configurar notificaciones**.
2. URL: `https://SU-DOMINIO/api/webhooks/mercadopago`. Si el panel separa modo de prueba y modo productivo, en prueba usen la de la rama: `https://pruebas--NOMBRE.netlify.app/api/webhooks/mercadopago`.
3. Evento: **Order (Mercado Pago)**. Nada más.
4. Guardar. MP genera la **clave secreta** de esa aplicación: copiala.
5. `MP_WEBHOOK_SECRETS` lleva las claves de las dos aplicaciones separadas por coma: `claveWeb,claveCaja`.
6. Si el panel ofrece **simular una notificación**, úsenlo: respuesta **200** = URL y clave bien; **401** = la clave cargada no coincide.

`MP_REQUIRE_SIGNATURE=true` rechaza cualquier aviso sin firma válida. Si en pruebas los cobros por **QR** no se confirman y en los logs aparece `mp.webhook_rejected` con `reason: "missing"`, pónganla en `false`: el sistema igual consulta cada orden a la API antes de darla por paga, y el panel de caja y el mantenimiento también consultan solos.

#### 6.6 Dar de alta la caja (una sola vez por entorno)

1. Con la app ya desplegada: `/admin` → **Integraciones** → tarjeta *Mercado Pago* → **Configurar la caja (una sola vez)**.
2. Completen la dirección del local o cocina (calle, número, ciudad, departamento) y las coordenadas (en Google Maps, clic derecho sobre el lugar) → **Crear sucursal y caja**.
3. El sistema crea la **sucursal** y la **caja** en Mercado Pago; en la misma tarjeta aparece **QR para imprimir → Descargar PDF**: ese es el cartel del puesto.
4. Repitan esto en producción: la caja de pruebas y la de producción son distintas.

En la feria: `/admin` → **Caja** → marcan los productos → eligen **QR impreso** (el cliente escanea el cartel), **QR en pantalla** (muestran el celu/tablet) o **Point** → el panel avisa cuando se acreditó.

#### 6.7 Point (opcional)

Mercado Pago lanzó la Point Smart en Uruguay en 2026, pero no pude confirmar en la documentación de Uruguay que su API de integración esté habilitada. Si tienen una:

1. Vincúlenla a la cuenta desde la app de Mercado Pago.
2. `/admin` → **Integraciones** → **Buscar terminales Point** → en la suya, **Pasar a modo PDV**.
3. Copien el id que muestra en `MP_POINT_TERMINAL_ID` y hagan deploy: aparece la opción **Point (tarjeta)** en la caja.

Si MP responde con error, sigan cobrando con QR: no depende de la Point.

### Paso 7 · Mercado Libre

#### 7.1 Requisitos

- Entren con la cuenta **dueña** de las publicaciones (no con un operador o colaborador): la aplicación queda a nombre de esa cuenta.
- La URI de redirección y la de notificaciones tienen que ser **https** (por eso primero el Paso 2/3).

#### 7.2 Crear la aplicación

**developers.mercadolibre.com.uy** → DevCenter → **Crear nueva aplicación**:

| Campo | Qué poner |
|---|---|
| Nombre | `ESDLA Stock` (tiene que ser único) |
| Descripción | Hasta 150 caracteres; la ven al autorizar. Ej.: "Sincroniza ventas y stock de El Secreto de la Abuela." |
| Logo | El logo de ESDLA |
| URIs de redirect | `https://SU-DOMINIO/api/admin/ml/callback` (exacta, la misma que `ML_REDIRECT_URI`) |
| PKCE | **Activado** |
| Scopes / permisos | **Lectura y escritura**, y **acceso offline** (sin esto ML no entrega refresh token y la conexión se corta a las horas) |
| Tópicos | Solo **Orders** (`orders_v2`) |
| URL de notificaciones | `https://SU-DOMINIO/api/webhooks/mercadolibre` |

Guarden. En **Mis aplicaciones** aparecen el **App ID** (`ML_CLIENT_ID`) y la **Secret Key** (`ML_CLIENT_SECRET`).

Mercado Libre se configura **solo en producción** (no tiene entorno de pruebas para ventas): en la rama `pruebas` dejen las variables `ML_*` sin cargar.

#### 7.3 Conectar la cuenta

1. Con las variables cargadas y el deploy hecho: `/admin` → **Integraciones** → **Conectar Mercado Libre**.
2. Autoricen con la cuenta vendedora. Vuelve al panel con "conectado".
   - `falta-offline-access`: falta el acceso offline en la app (7.2).
   - `cuenta-incorrecta`: autorizaron con otra cuenta.
3. Copien el número de cuenta que muestra el panel en `ML_SELLER_USER_ID` y hagan deploy: desde ahí el sistema rechaza cualquier otra cuenta.

#### 7.4 Vincular publicaciones y stock

1. `/admin` → **Stock** → en cada producto peguen el código de su publicación (`MLU...`; si la publicación tiene variaciones, también la variación).
2. El sistema verifica que la publicación sea de su cuenta antes de aceptarla.
3. Carguen el **stock real** de cada producto. Ese número **manda**: se copia a Mercado Libre y pisa lo que haya allá.
4. El **Box** no lleva stock propio: su disponibilidad es la del sabor que menos tenga.

### Paso 8 · Cargar las variables en Netlify

*Project configuration → Environment variables → Add a variable*. Pueden importar un bloque tipo `.env` (*Import from a .env file*) y después ajustar.

- Las marcadas como **secreto** van con **Contains secret values**: Netlify las vuelve de solo escritura, no las muestra más, y **frena el deploy** si su valor aparece en el sitio publicado.
- Elijan **valores distintos por contexto**: *Production* (el sitio real) y *Branch deploys* / *Deploy Previews* (pruebas).
- **Después de cambiar variables hay que hacer un deploy nuevo** (*Deploys → Trigger deploy*). Si no, siguen los valores viejos.
- En el plan gratis no se puede limitar el alcance a "Functions": no es problema, el build no usa ninguna variable.

| Variable | ¿Secreto? | Production | Rama `pruebas` |
|---|---|---|---|
| `SITE_URL` | No | `https://SU-DOMINIO` | `https://pruebas--NOMBRE.netlify.app` |
| `DATABASE_URL` | **Sí** | Rama `main` de Neon (pooled) | Rama `pruebas` de Neon |
| `DATABASE_SSL` | No | `verify-full` | `verify-full` |
| `ENCRYPTION_KEYS` | **Sí** | Juego de producción | Juego de pruebas |
| `ENCRYPTION_ACTIVE_KEY` | No | `k1` | `k1` |
| `SESSION_SECRET` | **Sí** | Producción | Pruebas |
| `CSRF_SECRET` | **Sí** | Producción | Pruebas |
| `ADMIN_PASSWORD_HASH` | **Sí** | Hash de la contraseña real | Otro hash |
| `MP_ACCESS_TOKEN` | **Sí** | Token de producción (app web) | Token de prueba (app web) |
| `MP_POS_ACCESS_TOKEN` | **Sí** | Token de producción (app caja) | Token de prueba (app caja) |
| `MP_WEBHOOK_SECRETS` | **Sí** | `claveWeb,claveCaja` | Ídem |
| `MP_REQUIRE_SIGNATURE` | No | `true` | `true` |
| `MP_STORE_EXTERNAL_ID` / `MP_POS_EXTERNAL_ID` | No | `ESDLA001` / `ESDLAPOS001` | Ídem |
| `MP_POINT_TERMINAL_ID` | No | Solo si hay Point | — |
| `ONLINE_CHECKOUT_ENABLED` | No | `true` (`false` pausa la compra online) | `true` |
| `ML_CLIENT_ID` | No | App ID | — |
| `ML_CLIENT_SECRET` | **Sí** | Secret Key | — |
| `ML_REDIRECT_URI` | No | `https://SU-DOMINIO/api/admin/ml/callback` | — |
| `ML_SELLER_USER_ID` | No | Después de conectar (7.3) | — |

`ML_AUTH_BASE` y `ML_WEBHOOK_ALLOWED_IPS` ya tienen valores por defecto correctos para Uruguay: no hace falta cargarlas.

Si una variable obligatoria falta o está mal, las funciones responden "servicio no configurado" y en *Logs → Functions* aparece `config_error` con el **nombre** de la variable (nunca el valor).

### Paso 9 · Probar todo en la rama `pruebas`

Hagan un push a `pruebas` (o *Trigger deploy* de esa rama) y entren a `https://pruebas--NOMBRE.netlify.app/admin`.

**Preparación**: Integraciones → configurar la caja (6.6) → Stock → carguen unidades a los productos.

**Compra online** (ventana de incógnito, sin sesión de Mercado Pago, cualquier email):

| Tarjeta | Número | CVV | Vence |
|---|---|---|---|
| Mastercard crédito | 5031 7557 3453 0604 | 123 | 11/30 |
| Visa crédito | 4509 9535 6623 3704 | 123 | 11/30 |
| Visa débito | 4410 1036 7243 6886 | 123 | 11/30 |

El **nombre del titular** decide el resultado: `APRO` aprobado, `OTHE` rechazado, `CONT` pendiente. Documento: CI `12345678`.

Checklist:

- [ ] Compra con `APRO` → la página de gracias dice "aprobado", aparece en *Pedidos web* con el contacto, y el stock bajó.
- [ ] Compra con `OTHE` → Mercado Pago rechaza el pago; la compra no figura como pagada y el stock no cambió.
- [ ] Comprar más de lo que hay → el sitio lo frena con un aviso.
- [ ] Caja con **QR en pantalla**: escanear con la app de Mercado Pago **logueada con la cuenta de prueba compradora** (usuario y contraseña en el panel de la aplicación de caja, sección *Cuentas de prueba*; no usen su cuenta real) → el panel marca pagado y baja el stock.
- [ ] Caja con **QR impreso**: mismo resultado escaneando el QR del puesto.
- [ ] Cancelar un cobro pendiente desde el panel.
- [ ] Simulación de webhook desde el panel de MP (si está disponible) → 200.
- [ ] Revisar cabeceras de seguridad en securityheaders.com con la URL de la rama.

### Paso 10 · Salir a producción

- [ ] Credenciales de **producción** de MP activadas y cargadas en el contexto *Production*.
- [ ] Webhooks de MP de producción apuntando al dominio, con sus claves en `MP_WEBHOOK_SECRETS`.
- [ ] Precios revisados (ver §4.1) y stock real cargado.
- [ ] Deploy de `main` → `/admin` → **Configurar caja** de producción → imprimir el QR del puesto.
- [ ] Conectar Mercado Libre, cargar `ML_SELLER_USER_ID`, vincular publicaciones, deploy.
- [ ] **Una compra real chica** con tarjeta propia → verificar → **devolverla** desde el panel de Mercado Pago → el stock vuelve solo.
- [ ] Mirar *Integraciones* en `/admin`: credenciales cargadas, Mercado Libre conectado y "Última sincronización" de hace menos de media hora.

---

## 3. Cómo está protegido

| Riesgo | Control | Dónde |
|---|---|---|
| Robo de credenciales desde el navegador | Los tokens solo existen en las funciones (variables de entorno). El navegador nunca habla con las APIs de MP/ML con credenciales. Netlify frena el deploy si un secreto aparece en lo publicado | `src/integrations/*`, `src/config/env.ts` |
| Configuración incompleta | Validación estricta de variables: si algo falta o está mal, la función no arranca (falla cerrada) | `src/config/env.ts` |
| XSS | CSP sin scripts ni estilos inline (aunque se colara HTML, no ejecuta), todo dato que viene del servidor o del usuario se inserta con `textContent`, entradas saneadas y validadas | `netlify.toml`, `public/js/tienda.js`, `public/admin/admin.js`, `src/lib/validation.ts` |
| CSRF | Token firmado de doble envío + verificación de `Origin`/`Sec-Fetch-Site` + cookies `SameSite=Strict` | `src/lib/csrf.ts` |
| Inyección SQL | Solo consultas parametrizadas; ningún SQL armado con texto del usuario | `src/lib/db.ts`, `src/services/*` |
| Inyección NoSQL / contaminación de prototipos | El JSON entrante descarta `__proto__`, `constructor` y `prototype`; esquemas zod estrictos (campos extra = error) | `src/lib/http.ts`, `src/lib/validation.ts` |
| Precios alterados | El servidor calcula todo con su catálogo; al confirmar, compara el monto con lo que cobró MP | `src/services/orders.ts` |
| Webhook falso de MP | Firma HMAC-SHA256 con ventana de tiempo, comparación en tiempo constante, y además se consulta la orden a la API con el token propio | `src/integrations/mercadopago/webhook-signature.ts`, `netlify/functions/webhook-mercadopago.ts` |
| Notificación falsa de ML | Solo IPs publicadas por ML + se consulta la orden a la API + se verifica que el vendedor sea su cuenta | `src/integrations/mercadolibre/notifications.ts` |
| Avisos repetidos / reintentos | Claves de idempotencia en MP y movimientos de stock únicos: nada se descuenta dos veces | `src/services/inventory.ts` |
| Fuerza bruta al panel | scrypt + 5 intentos cada 15 min por IP + límite de Netlify | `netlify/functions/admin-session.ts` |
| Robo de sesión | Cookie `__Host-` HttpOnly, Secure, SameSite=Strict, firmada, vence a las 8 h | `src/lib/session.ts` |
| Conexión de ML secuestrada | OAuth con `state` + PKCE S256 + cookie del flujo cifrada; solo acepta la cuenta configurada | `netlify/functions/admin-ml-oauth.ts` |
| Robo de la base | Tokens de ML y contacto de compradores cifrados con AES-256-GCM (con datos asociados, para que no se puedan copiar de una fila a otra); claves rotables | `src/lib/crypto.ts` |
| Datos en tránsito | HTTPS + HSTS en el sitio; TLS `verify-full` a la base; HTTPS a MP/ML sin seguir redirecciones | `netlify.toml`, `src/lib/db.ts` |
| Fugas por logs | Los logs tapan tokens, secretos, cookies, firmas y datos personales | `src/lib/logger.ts` |
| Redirección a sitios falsos | Solo se redirige a `checkout_url` de dominios de Mercado Pago; los links a ML se validan | `src/integrations/mercadopago/orders.ts`, `public/js/tienda.js` |
| Clickjacking | `frame-ancestors 'none'` y `X-Frame-Options: DENY` | `netlify.toml` |
| Abuso de la API | Límites por IP en compra, estado y login | `src/lib/rate-limit.ts` |
| Datos personales (Ley 18.331) | Se guarda lo mínimo; el contacto del comprador se borra solo a los 180 días | `src/services/sync.ts` |

---

## 4. Operación del día a día

### 4.1 Precios y catálogo

El catálogo inicial (`db/seed.sql`) trae precios de la planilla de feria **para revisar**: salsas a $210, Box a $990 y la Mermelada sin venta online hasta tener precio. Para cambiarlos, en Neon → *SQL Editor* (base de producción):

```sql
update products set price_cents = 25000, updated_at = now() where sku = 'ZYM-200';   -- $250,00
update products set price_cents = 30000, sell_online = true, updated_at = now() where sku = 'MPI-200';
```

Códigos: `ZYM-200` Zanahoria & Morrón · `SWJ-200` Sweet Jalapeño · `VDH-200` Verde de Huerta · `MPI-200` Mermelada Picante · `BOX-3` Box. Después toquen **Sincronizar ahora** en `/admin` → Integraciones para que la web muestre el precio nuevo al instante (si no, tarda hasta 30 min). El cobro siempre usa el precio de la base, nunca el que muestra la página.

Para pausar la compra online (vacaciones, falta de producción): `ONLINE_CHECKOUT_ENABLED=false` y deploy.

### 4.2 Rotación de claves

| Qué | Cuándo | Cómo |
|---|---|---|
| Clave secreta de webhook MP | Una vez al año o si se filtró | Regenerarla en la app → `MP_WEBHOOK_SECRETS=nueva,vieja` → deploy → al día siguiente dejar solo la nueva. Los avisos rechazados en el medio MP los reintenta |
| Access Token de MP | Si se filtró | Renovarlo en *Credenciales* de la app → actualizar la variable → deploy |
| Secret Key de ML | Si se filtró | DevCenter → *Programar renovación* (las dos valen hasta la fecha elegida, máx. 7 días) → actualizar `ML_CLIENT_SECRET` → deploy → expirar la vieja |
| `ENCRYPTION_KEYS` | Una vez al año | Agregar `k2` (`k1:...,k2:...`) y `ENCRYPTION_ACTIVE_KEY=k2` → deploy. Lo nuevo se cifra con `k2`, lo viejo sigue leyéndose con `k1`. Los tokens de ML se re-cifran solos en el próximo refresco; a los 180 días ya no queda nada con `k1` y se puede sacar |
| `SESSION_SECRET` / `CSRF_SECRET` | Si se filtró | Cambiar y deploy (cierra la sesión del panel) |
| Contraseña del panel | Cuando quieran | `npm run hash-password` → `ADMIN_PASSWORD_HASH` → deploy |

### 4.3 Qué mirar en los logs

*Netlify → Logs → Functions*. Son líneas JSON, sin secretos. Las que importan:

- Nivel `security`: `mp.webhook_rejected` (firma inválida), `mp.amount_mismatch` / `mp.underpaid` (monto que no cierra: no se marcó pagado), `ml.webhook_ip_rejected`, `ml.seller_mismatch`, `ml.oauth_wrong_account`, `admin.login_failed`.
- `ml.token_invalid`: ML revocó la conexión → *Conectar Mercado Libre* de nuevo.
- `maintenance.errors`: algo del mantenimiento falló; se reintenta solo en la próxima corrida.
- `stock.negative`: se vendió algo sin stock (dos compras simultáneas de la última unidad); hay que resolverlo a mano.

El mantenimiento corre **cada 30 minutos**: renueva el token de ML, reintenta avisos fallidos, concilia ventas de ML y órdenes de MP por si se perdió algún aviso, empuja stock a ML y borra datos viejos. *Integraciones → Sincronizar ahora* lo corre en el momento.

### 4.4 Costos y límites de los planes gratis

- **Netlify Free: 300 créditos/mes, con tope duro.** Cada deploy de producción gasta 15; el tráfico gasta poco (≈20 créditos por GB transferido; la home pesa ≈1 MB). Si se agotan, Netlify **pausa el sitio** ("Site not available") hasta el mes siguiente: no hay tienda ni webhooks. Prueben siempre en la rama `pruebas` (no consume) y junten cambios antes de publicar. Cuando haya ventas reales seguidas, el plan Personal (USD 9/mes, 1.000 créditos y recarga) evita el corte.
- **Neon Free: 100 CU-hora/mes; la base se apaga a los 5 min sin uso.** Por eso el mantenimiento corre cada 30 min (no cada 5) y el catálogo de la web se sirve desde la caché de Netlify (no despierta la base en cada visita). Con su volumen estimamos 30–60 CU-hora/mes. Si se agota, la base se suspende hasta el mes siguiente: revisen *Usage* en Neon la primera semana. El plan Launch cuesta USD 0,106 por CU-hora, sin mínimo.

---

## 5. Limitaciones y pendientes (dicho en limpio)

1. **No está probado contra las APIs reales.** Hay tests de todos los flujos con Postgres real y las respuestas de MP/ML simuladas según su documentación, pero la primera prueba real es el Paso 9. Si algo responde distinto, el log dice qué.
2. **Point en Uruguay**: no confirmado (6.7).
3. **Firma de los avisos de QR**: la documentación de MP no es consistente sobre si van firmados (6.5).
4. **Sin reserva de stock**: si dos personas compran la última unidad al mismo tiempo, las dos pueden pagar. Es raro con su volumen; se resuelve devolviendo una.
5. **Facturación electrónica (CFE/DGI)**: fuera de alcance. Mercado Pago no la emite por ustedes.
6. **Ley 18.331 de datos personales**: la web guarda nombre, teléfono y dirección de compradores. Tienen que inscribir la base ante la URCDP y publicar un aviso de privacidad (qué datos, para qué, que se borran a los 180 días y cómo pedir acceso o borrado). No soy abogado: confírmenlo con su contador o asesor.
7. **Rotulado**: el producto se llama "Zanahoria & Morrón" pero en la lista de ingredientes el morrón va antes (hay más morrón). No es un tema técnico; vale la pena revisarlo con quien les asesora el rotulado.
8. **Precio del Box** ($990) mayor que las tres salsas sueltas ($630): revisen si es correcto (4.1).
9. **Escaneo de secretos de Netlify**: en planes pagos, la "detección inteligente" podría marcar las claves **falsas** de `tests/`. Si un deploy falla por eso, agreguen la variable `SECRETS_SCAN_OMIT_PATHS=tests/`.

---

## 6. Fuentes

- Mercado Pago: [crear aplicación Checkout Pro (Orders)](https://www.mercadopago.com.uy/developers/es/docs/checkout-pro-orders/create-application.md) · [salir a producción](https://www.mercadopago.com.uy/developers/es/docs/checkout-pro-orders/go-to-production.md) · [compra de prueba con tarjetas](https://www.mercadopago.com.uy/developers/es/docs/checkout-pro-orders/integration-test/test-purchase-with-card) · [crear aplicación Código QR](https://www.mercadopago.com.uy/developers/pt/docs/qr-code/create-application.md) · [sucursal y caja](https://www.mercadopago.com.uy/developers/es/docs/qr-code/create-store-and-pos.md) · [notificaciones QR](https://www.mercadopago.com.uy/developers/pt/docs/qr-code/notifications.md) · [compra de prueba QR](https://www.mercadopago.com.ar/developers/es/docs/qr-code/test-integration/test-purchase)
- Mercado Libre: [registrar la aplicación](https://developers.mercadolibre.com.uy/en_us/register-your-application) · [autenticación y autorización](https://developers.mercadolibre.com.ar/autenticacion-y-autorizacion) · [notificaciones](https://developers.mercadolibre.com.ar/en_us/products-receive-notifications)
- Netlify: [variables de entorno](https://docs.netlify.com/build/environment-variables/overview/) · [variables en funciones](https://docs.netlify.com/build/functions/environment-variables.md) · [secretos](https://docs.netlify.com/build/environment-variables/secrets-controller/) · [caché](https://docs.netlify.com/build/caching/caching-overview.md) · [planes por créditos](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/) · [proyectos pausados](https://docs.netlify.com/manage/accounts-and-billing/billing/resume-paused-projects/)
- Neon: [precios y límites](https://neon.com/pricing) · [apagado automático](https://neon.com/docs/introduction/scale-to-zero.md)
- Point en Uruguay: [LatamFintech](https://www.latamfintech.co/articles/mercado-pago-lanza-cuatro-nuevos-productos-en-uruguay-rendimientos-tarjeta-prepago-pos-para-comercios-y-beneficios-para-usuarios)
