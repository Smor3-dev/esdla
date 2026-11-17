/**
 * Conexión a PostgreSQL con postgres.js. Todas las consultas usan plantillas
 * etiquetadas (sql`...${valor}`): los valores viajan como parámetros, nunca se
 * concatenan al SQL, lo que elimina la inyección SQL por construcción.
 * TLS con verificación de certificado en producción (DATABASE_SSL=verify-full).
 */
import postgres from 'postgres';
import { env } from '../config/env.js';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Cualquier ejecutor de consultas: la conexión o una transacción. */
export type Db = Sql | Tx;

let client: Sql | undefined;

export function db(): Sql {
  if (!client) {
    const e = env();
    // sslmode / channel_binding son opciones de libpq: postgres.js las mandaría al servidor
    // como parámetros desconocidos. TLS se controla con DATABASE_SSL.
    const url = new URL(e.DATABASE_URL);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('channel_binding');
    client = postgres(url.toString(), {
      ssl: e.DATABASE_SSL === 'disable' ? false : e.DATABASE_SSL, // 'verify-full' valida certificado y hostname
      max: 1, // una conexión por instancia serverless; usar el pooler del proveedor
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false, // compatible con poolers en modo transacción (PgBouncer)
      onnotice: () => {},
    });
  }
  return client;
}

/** Solo para tests y scripts. */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = undefined;
  }
}
