/**
 * Primitivas criptográficas (solo módulos nativos de Node, sin dependencias).
 *  - AES-256-GCM con AAD y rotación de claves para datos en reposo.
 *  - HMAC-SHA256 y comparación en tiempo constante.
 *  - scrypt para la contraseña del panel admin.
 *  - PKCE (S256) para el OAuth de Mercado Libre.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { env } from '../config/env.js';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });

export const b64url = (buf: Buffer) => buf.toString('base64url');
export const fromB64url = (s: string) => Buffer.from(s, 'base64url');

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Identificador público no adivinable (128 bits) en base32 Crockford: 26 caracteres. */
export function randomRef(prefix: 'W' | 'P'): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return `${prefix}-${out}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(secret: string | Buffer, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function hmacB64url(secret: string | Buffer, message: string): string {
  return createHmac('sha256', secret).update(message).digest('base64url');
}

/** Comparación en tiempo constante. Distinto largo → false sin cortocircuito por contenido. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// AES-256-GCM. Formato: v1.<keyId>.<iv>.<tag>.<ciphertext>  (base64url)
// El AAD ata el dato a su contexto (ej. "oauth:mercadolibre:refresh"): un valor
// cifrado copiado a otra columna no descifra.
// ---------------------------------------------------------------------------
export function encrypt(plaintext: string, aad: string): string {
  const { ENCRYPTION_ACTIVE_KEY, encryptionKeys } = env();
  const key = encryptionKeys.get(ENCRYPTION_ACTIVE_KEY);
  if (!key) throw new Error('Clave de cifrado activa no disponible');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', ENCRYPTION_ACTIVE_KEY, b64url(iv), b64url(tag), b64url(ct)].join('.');
}

export function decrypt(token: string, aad: string): string {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Formato cifrado inválido');
  const [, keyId, ivS, tagS, ctS] = parts as [string, string, string, string, string];
  const key = env().encryptionKeys.get(keyId);
  if (!key) throw new Error('Clave de cifrado desconocida (¿se borró una clave vieja?)');
  const iv = fromB64url(ivS);
  const tag = fromB64url(tagS);
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Formato cifrado inválido');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(fromB64url(ctS)), decipher.final()]).toString('utf8');
}

/** true si el valor fue cifrado con una clave que no es la activa (para re-cifrar al rotar). */
export function needsReencrypt(token: string): boolean {
  return token.split('.')[1] !== env().ENCRYPTION_ACTIVE_KEY;
}

// ---------------------------------------------------------------------------
// Contraseña del admin: scrypt$N$r$p$salt$hash
// ---------------------------------------------------------------------------
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64url(salt), b64url(key)].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N < 2 ** 14 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = fromB64url(parts[4] ?? '');
  const expected = fromB64url(parts[5] ?? '');
  if (salt.length < 16 || expected.length !== 32) return false;
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636, método S256)
// ---------------------------------------------------------------------------
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32); // 43 caracteres base64url
  return { verifier, challenge: pkceChallenge(verifier) };
}
