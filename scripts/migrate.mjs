#!/usr/bin/env node
// Crea/actualiza las tablas y carga el catálogo inicial.
// Uso: DATABASE_URL="postgres://..." npm run db:migrate
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL');
  process.exit(1);
}
const u = new URL(url);
u.searchParams.delete('sslmode');
u.searchParams.delete('channel_binding');
const mode = process.env.DATABASE_SSL ?? 'verify-full';
const sql = postgres(u.toString(), { ssl: mode === 'disable' ? false : mode, max: 1, prepare: false, onnotice: () => {} });
try {
  for (const file of ['db/schema.sql', 'db/seed.sql']) {
    await sql.unsafe(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    console.log(`✓ ${file}`);
  }
} finally {
  await sql.end();
}
