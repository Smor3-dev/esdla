/**
 * Caché del catálogo público en la CDN de Netlify.
 *
 * GET /api/products se guarda en la CDN (caché "durable", compartida entre nodos) para
 * que las visitas no despierten la base de datos: en el plan gratis de Neon la base se
 * apaga a los 5 minutos sin uso y el cómputo mensual es limitado. Cuando cambia el stock
 * o un vínculo con Mercado Libre, se invalida la etiqueta y la próxima visita ve el dato nuevo.
 */
import { purgeCache } from '@netlify/functions';
import { log } from './logger.js';

export const CATALOG_CACHE_TAG = 'esdla-catalogo';

/** Cabeceras de caché del catálogo: el navegador siempre revalida; la CDN guarda 30 min. */
export const catalogCacheHeaders: Record<string, string> = {
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=1800, stale-while-revalidate=1800',
  'Netlify-Cache-Tag': CATALOG_CACHE_TAG,
};

/** Invalida el catálogo cacheado. Nunca interrumpe el flujo que la llama. */
export async function purgeCatalogCache(): Promise<void> {
  // Netlify inyecta este token en las funciones desplegadas; fuera de Netlify no hay CDN que purgar.
  if (!process.env.NETLIFY_PURGE_API_TOKEN) return;
  try {
    await purgeCache({ tags: [CATALOG_CACHE_TAG] });
  } catch (err) {
    log.warn('cdn.purge_failed', { err });
  }
}
