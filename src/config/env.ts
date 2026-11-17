/**
 * Configuración validada. Todas las credenciales salen de variables de entorno
 * (Netlify → Project configuration → Environment variables).
 * Nada de esto se importa desde el frontend: vive solo en las funciones serverless.
 */
import { z } from 'zod';

const ML_NOTIFICATION_IPS_DEFAULT = [
  // Lista publicada por Mercado Libre para notificaciones (revisar si cambia).
  '54.88.218.97', '18.215.140.160', '18.213.114.129', '18.206.34.84',
  '35.236.253.169', '35.245.91.34', '35.245.20.104', '35.186.182.146',
].join(',');

const csv = (value: string) =>
  value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);

const flag = (fallback: 'true' | 'false') =>
  z.enum(['true', 'false']).default(fallback).transform((v) => v === 'true');

const noSpaces = /^\S+$/;

const schema = z.object({
  SITE_URL: z
    .url()
    .refine(
      (u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(u),
      'SITE_URL tiene que ser https:// (http solo para localhost)',
    )
    .transform((u) => u.replace(/\/+$/, '')),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'DATABASE_URL debe ser una URL postgres://'),
  // verify-full = TLS verificando certificado y hostname (recomendado). require = TLS sin verificar (solo si el proveedor usa una CA propia).
  DATABASE_SSL: z.enum(['verify-full', 'require', 'disable']).default('verify-full'),

  // Cifrado en reposo: "k1:BASE64_32_BYTES,k2:BASE64_32_BYTES". La activa cifra; todas descifran.
  ENCRYPTION_KEYS: z.string().min(10),
  ENCRYPTION_ACTIVE_KEY: z.string().regex(/^[a-z0-9]{1,16}$/),
  SESSION_SECRET: z.string().min(32).regex(noSpaces),
  CSRF_SECRET: z.string().min(32).regex(noSpaces),
  ADMIN_PASSWORD_HASH: z.string().startsWith('scrypt$'),

  // Mercado Pago
  MP_ACCESS_TOKEN: z.string().min(20).regex(noSpaces).optional(), // app "Checkout Pro" (Orders API)
  MP_POS_ACCESS_TOKEN: z.string().min(20).regex(noSpaces).optional(), // app "Código QR" (si es otra); si falta se usa MP_ACCESS_TOKEN
  MP_WEBHOOK_SECRETS: z.string().optional(), // varias separadas por coma (rotación sin cortes)
  MP_REQUIRE_SIGNATURE: flag('true'),
  MP_STORE_EXTERNAL_ID: z.string().regex(/^[A-Za-z0-9]{1,60}$/).default('ESDLA001'),
  MP_POS_EXTERNAL_ID: z.string().regex(/^[A-Za-z0-9]{1,40}$/).default('ESDLAPOS001'),
  MP_POINT_TERMINAL_ID: z.string().regex(/^[A-Za-z0-9_]{5,80}$/).optional(),
  ONLINE_CHECKOUT_ENABLED: flag('true'),

  // Mercado Libre
  ML_CLIENT_ID: z.string().regex(/^\d{5,25}$/).optional(),
  ML_CLIENT_SECRET: z.string().min(10).regex(noSpaces).optional(),
  ML_REDIRECT_URI: z.url().startsWith('https://').optional(),
  ML_AUTH_BASE: z.url().startsWith('https://auth.mercadoli').default('https://auth.mercadolibre.com.uy'),
  ML_SELLER_USER_ID: z.string().regex(/^\d{3,20}$/).optional(),
  ML_WEBHOOK_ALLOWED_IPS: z.string().default(ML_NOTIFICATION_IPS_DEFAULT),
});

export type Env = z.infer<typeof schema> & {
  encryptionKeys: Map<string, Buffer>;
  mpWebhookSecrets: string[];
  mlAllowedIps: string[] | null; // null = filtro de IP desactivado ("off")
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

let cached: Env | undefined;

function parseKeys(raw: string, active: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const entry of csv(raw)) {
    const sep = entry.indexOf(':');
    if (sep < 1) throw new ConfigError('ENCRYPTION_KEYS mal formada (usar id:base64)');
    const id = entry.slice(0, sep);
    const key = Buffer.from(entry.slice(sep + 1), 'base64');
    if (!/^[a-z0-9]{1,16}$/.test(id)) throw new ConfigError(`Id de clave inválido: ${id}`);
    if (key.length !== 32) throw new ConfigError(`La clave ${id} no tiene 32 bytes`);
    keys.set(id, key);
  }
  if (!keys.has(active)) throw new ConfigError('ENCRYPTION_ACTIVE_KEY no está en ENCRYPTION_KEYS');
  return keys;
}

/** Lee y valida el entorno una sola vez por instancia. Nunca loguea valores. */
export function env(): Env {
  if (cached) return cached;
  // Una variable cargada vacía cuenta como no cargada ("dejar vacío" = usar el valor por defecto).
  const present = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const vars = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new ConfigError(`Variables de entorno inválidas o faltantes: ${vars}`);
  }
  const data = parsed.data;
  const secrets = data.MP_WEBHOOK_SECRETS ? csv(data.MP_WEBHOOK_SECRETS) : [];
  if (secrets.some((s) => s.length < 16)) throw new ConfigError('MP_WEBHOOK_SECRETS contiene un valor demasiado corto');
  const ips = data.ML_WEBHOOK_ALLOWED_IPS.trim().toLowerCase() === 'off' ? null : csv(data.ML_WEBHOOK_ALLOWED_IPS);
  cached = {
    ...data,
    encryptionKeys: parseKeys(data.ENCRYPTION_KEYS, data.ENCRYPTION_ACTIVE_KEY),
    mpWebhookSecrets: secrets,
    mlAllowedIps: ips,
  };
  return cached;
}

/** Solo para tests. */
export function resetEnvCache(): void {
  cached = undefined;
}

export type MpApp = 'online' | 'pos';

/** Mercado Pago pide una aplicación por solución: Checkout Pro (online) y Código QR (caja). */
export function requireMp(app: MpApp = 'online'): { accessToken: string } {
  const e = env();
  const token = app === 'pos' ? (e.MP_POS_ACCESS_TOKEN ?? e.MP_ACCESS_TOKEN) : e.MP_ACCESS_TOKEN;
  if (!token) throw new ConfigError('Falta MP_ACCESS_TOKEN');
  return { accessToken: token };
}

/** true si la caja usa una aplicación (y token) distinta a la de la web. */
export function mpUsesSeparatePosApp(): boolean {
  const e = env();
  return Boolean(e.MP_POS_ACCESS_TOKEN && e.MP_POS_ACCESS_TOKEN !== e.MP_ACCESS_TOKEN);
}

export function requireMl(): { clientId: string; clientSecret: string; redirectUri: string } {
  const e = env();
  if (!e.ML_CLIENT_ID || !e.ML_CLIENT_SECRET || !e.ML_REDIRECT_URI) {
    throw new ConfigError('Faltan ML_CLIENT_ID, ML_CLIENT_SECRET o ML_REDIRECT_URI');
  }
  return { clientId: e.ML_CLIENT_ID, clientSecret: e.ML_CLIENT_SECRET, redirectUri: e.ML_REDIRECT_URI };
}
