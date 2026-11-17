/** Registro de acciones sensibles del panel (logins, ajustes de stock, conexiones). */
import { db } from './db.js';
import { log } from './logger.js';

export async function audit(actor: string, action: string, detail: Record<string, string | number | boolean | null> = {}): Promise<void> {
  try {
    await db()`insert into audit_log (actor, action, detail) values (${actor}, ${action}, ${db().json(detail)})`;
  } catch (err) {
    log.error('audit.failed', { action, err });
  }
}
