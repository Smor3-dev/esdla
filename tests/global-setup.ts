/**
 * Levanta un PostgreSQL real en memoria (PGlite, Postgres compilado a WASM) detrás
 * de un socket TCP, para que el código use el mismo driver (postgres.js) que en producción.
 */
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export const TEST_DB_PORT = 54329;

export default async function setup() {
  const pg = await PGlite.create();
  await pg.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await pg.exec(await readFile(new URL('../db/seed.sql', import.meta.url), 'utf8'));
  const server = new PGLiteSocketServer({ db: pg, port: TEST_DB_PORT, host: '127.0.0.1' });
  await server.start();
  return async () => {
    await server.stop();
    await pg.close();
  };
}
