-- =====================================================================
-- Catálogo inicial. REVISAR precios y stock antes de salir a producción.
-- Precios en centésimos de UYU (21000 = $210,00), tomados de la planilla de feria.
-- La Mermelada queda sin venta online hasta cargar su precio.
-- =====================================================================
insert into products (sku, name, price_cents, stock, is_bundle, sell_online) values
  ('ZYM-200', 'Salsa de Zanahoria & Morrón 200 ml', 21000, 0, false, true),
  ('SWJ-200', 'Salsa Sweet Jalapeño 200 ml',        21000, 0, false, true),
  ('VDH-200', 'Salsa Verde de Huerta 200 ml',       21000, 0, false, true),
  ('MPI-200', 'Mermelada Picante 200 ml',               0, 0, false, false),
  ('BOX-3',   'Box ESDLA (una salsa de cada sabor)', 99000, 0, true,  true)
on conflict (sku) do nothing;

insert into bundle_components (bundle_sku, component_sku, quantity) values
  ('BOX-3', 'ZYM-200', 1),
  ('BOX-3', 'SWJ-200', 1),
  ('BOX-3', 'VDH-200', 1)
on conflict do nothing;
