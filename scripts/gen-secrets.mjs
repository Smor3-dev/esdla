#!/usr/bin/env node
// Genera los secretos propios de la app (no son de Mercado Pago ni de Mercado Libre).
// Uso: npm run gen:secrets   → copiá la salida a las variables de entorno de Netlify.
import { randomBytes } from 'node:crypto';

const b64 = (n) => randomBytes(n).toString('base64');
const b64url = (n) => randomBytes(n).toString('base64url');

console.log(`# Pegar en Netlify → Project configuration → Environment variables (marcar "Contains secret values")
ENCRYPTION_KEYS=k1:${b64(32)}
ENCRYPTION_ACTIVE_KEY=k1
SESSION_SECRET=${b64url(48)}
CSRF_SECRET=${b64url(48)}
`);
