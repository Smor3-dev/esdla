-- =====================================================================
-- El Secreto de la Abuela · Esquema de base de datos (PostgreSQL 15+)
-- Idempotente: se puede correr más de una vez sin romper nada.
-- Ejecutar con:  npm run db:migrate   (usa DATABASE_URL)
-- =====================================================================

-- gen_random_uuid() es nativo desde PostgreSQL 13: no hace falta pgcrypto.

do $$ begin
  create type order_channel as enum ('web', 'pos', 'mercadolibre');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum
    ('pending', 'action_required', 'paid', 'canceled', 'expired', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Catálogo: fuente de verdad del stock para web, caja (POS) y Mercado Libre
-- ---------------------------------------------------------------------
create table if not exists products (
  sku              text primary key check (sku ~ '^[A-Z0-9-]{2,32}$'),
  name             text not null check (char_length(name) between 1 and 120),
  price_cents      integer not null check (price_cents >= 0),       -- precio en centésimos de UYU
  stock            integer not null default 0,                      -- puede quedar < 0 si dos canales venden la última unidad a la vez (se alerta en logs)
  is_bundle        boolean not null default false,                  -- ej: Box ESDLA = 1 de cada salsa
  active           boolean not null default true,
  sell_online      boolean not null default true,
  ml_item_id       text unique check (ml_item_id ~ '^MLU[0-9]{6,15}$'),
  ml_variation_id  bigint check (ml_variation_id > 0),
  ml_permalink     text check (ml_permalink ~ '^https://'),
  updated_at       timestamptz not null default now()
);

create table if not exists bundle_components (
  bundle_sku     text not null references products(sku) on delete cascade,
  component_sku  text not null references products(sku),
  quantity       integer not null check (quantity between 1 and 50),
  primary key (bundle_sku, component_sku),
  check (bundle_sku <> component_sku)
);

-- ---------------------------------------------------------------------
-- Órdenes de los tres canales
-- ---------------------------------------------------------------------
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  public_ref         text not null unique check (public_ref ~ '^[A-Za-z0-9_-]{6,64}$'), -- = external_reference en Mercado Pago
  channel            order_channel not null,
  status             order_status not null default 'pending',
  total_cents        integer not null check (total_cents >= 0),
  provider_order_id  text unique,                                    -- id de la order de MP (ORD...) o de Mercado Libre
  pos_method         text check (pos_method in ('qr_static', 'qr_dynamic', 'point')),
  customer_enc       text,                                           -- contacto del comprador, cifrado con AES-256-GCM
  stock_applied      boolean not null default false,
  stock_restored     boolean not null default false,
  paid_at            timestamptz,
  mp_checked_at      timestamptz,                                    -- última consulta a MP pedida desde /gracias
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists orders_channel_status_idx on orders (channel, status, created_at desc);

create table if not exists order_items (
  order_id          uuid not null references orders(id) on delete cascade,
  sku               text not null references products(sku),
  quantity          integer not null check (quantity between 1 and 100),
  unit_price_cents  integer not null check (unit_price_cents >= 0),
  primary key (order_id, sku)
);

-- Cada movimiento de stock es único por (canal, referencia, sku, motivo):
-- si un webhook llega dos veces, el segundo no descuenta de nuevo.
create table if not exists stock_movements (
  id          bigserial primary key,
  sku         text not null references products(sku),
  delta       integer not null check (delta <> 0),
  reason      text not null check (reason in ('sale', 'restock', 'adjustment')),
  source      text not null check (source in ('web', 'pos', 'mercadolibre', 'admin')),
  source_ref  text not null,
  created_at  timestamptz not null default now(),
  unique (source, source_ref, sku, reason)
);

-- ---------------------------------------------------------------------
-- Tokens OAuth de Mercado Libre (cifrados; nunca en texto plano)
-- ---------------------------------------------------------------------
create table if not exists oauth_tokens (
  provider           text primary key check (provider in ('mercadolibre')),
  account_id         text not null,
  access_token_enc   text not null,
  refresh_token_enc  text not null,
  scope              text,
  expires_at         timestamptz not null,
  status             text not null default 'active' check (status in ('active', 'reauth_required')),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Webhooks recibidos (deduplicación, reintentos y auditoría)
-- ---------------------------------------------------------------------
create table if not exists webhook_events (
  provider      text not null check (provider in ('mercadopago', 'mercadolibre')),
  event_key     text not null,
  resource      text not null,
  status        text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  attempts      integer not null default 0,
  last_error    text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  primary key (provider, event_key)
);
create index if not exists webhook_events_retry_idx
  on webhook_events (status, received_at) where status in ('received', 'failed');

-- Cola de sincronización de stock hacia Mercado Libre (patrón outbox).
-- Una fila por SKU: si hay varias ventas seguidas se manda un solo PUT con el valor final.
create table if not exists ml_stock_outbox (
  sku              text primary key references products(sku) on delete cascade,
  requested_at     timestamptz not null default now(),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text
);

create table if not exists rate_limits (
  bucket        text primary key,
  window_start  timestamptz not null,
  count         integer not null
);

create table if not exists app_state (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists audit_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  actor   text not null,
  action  text not null,
  detail  jsonb not null default '{}'::jsonb
);
