/**
 * Tarea programada cada 30 minutos (UTC): mantiene vivo el token de Mercado Libre,
 * reintenta notificaciones, concilia órdenes y empuja el stock pendiente.
 * Cada 30 y no cada 5: así la base (Neon, plan gratis) puede apagarse entre corridas
 * y no se agota el cómputo mensual. Los webhooks son el camino principal; esto es respaldo.
 */
import type { Config } from '@netlify/functions';
import { db } from '../../src/lib/db.js';
import { log } from '../../src/lib/logger.js';
import { runMaintenance } from '../../src/services/sync.js';

export default async (): Promise<Response> => {
  try {
    const report = await runMaintenance(Date.now() + 25_000);
    await db()`
      insert into app_state (key, value, updated_at)
      values ('last_maintenance', ${db().json({ at: new Date().toISOString(), errors: report.errors.length })}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    log.info('maintenance.done', {
      tokenRefreshed: report.tokenRefreshed,
      mlEventsRetried: report.mlEventsRetried,
      mlOrdersReconciled: report.mlOrdersReconciled,
      mpOrdersPolled: report.mpOrdersPolled,
      pushed: report.outbox.pushed,
      errors: report.errors.length,
    });
  } catch (err) {
    log.error('maintenance.failed', { err });
  }
  return new Response(null, { status: 204 });
};

export const config: Config = { schedule: '*/30 * * * *' };
