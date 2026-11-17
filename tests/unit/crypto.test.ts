import { describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../src/config/env.js';
import {
  decrypt,
  encrypt,
  hashPassword,
  needsReencrypt,
  pkceChallenge,
  pkcePair,
  randomRef,
  safeEqual,
  verifyPassword,
} from '../../src/lib/crypto.js';

describe('AES-256-GCM', () => {
  it('cifra y descifra con el mismo AAD', () => {
    const c = encrypt('refresh-token-secreto', 'oauth:mercadolibre:refresh:1');
    expect(c).toMatch(/^v1\.k1\./);
    expect(c).not.toContain('refresh-token-secreto');
    expect(decrypt(c, 'oauth:mercadolibre:refresh:1')).toBe('refresh-token-secreto');
  });

  it('dos cifrados del mismo texto son distintos (IV aleatorio)', () => {
    expect(encrypt('x', 'a')).not.toBe(encrypt('x', 'a'));
  });

  it('falla si cambia el AAD (dato copiado a otro contexto)', () => {
    const c = encrypt('dato', 'order:W-1:customer');
    expect(() => decrypt(c, 'order:W-2:customer')).toThrow();
  });

  it('falla si se altera el texto cifrado', () => {
    const c = encrypt('dato', 'aad');
    const parts = c.split('.');
    const ct = Buffer.from(parts[4]!, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 1;
    parts[4] = ct.toString('base64url');
    expect(() => decrypt(parts.join('.'), 'aad')).toThrow();
  });

  it('rotación: descifra con una clave vieja y avisa que conviene re-cifrar', () => {
    process.env.ENCRYPTION_ACTIVE_KEY = 'k0';
    resetEnvCache();
    const viejo = encrypt('valor', 'aad');
    process.env.ENCRYPTION_ACTIVE_KEY = 'k1';
    resetEnvCache();
    expect(decrypt(viejo, 'aad')).toBe('valor');
    expect(needsReencrypt(viejo)).toBe(true);
    expect(needsReencrypt(encrypt('valor', 'aad'))).toBe(false);
  });
});

describe('utilidades', () => {
  it('safeEqual compara en tiempo constante', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('randomRef: 128 bits en base32 Crockford', () => {
    const r = randomRef('W');
    expect(r).toMatch(/^W-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(randomRef('W')).not.toBe(r);
  });

  it('PKCE S256 coincide con el vector del RFC 7636', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const { verifier, challenge } = pkcePair();
    expect(verifier).toHaveLength(43);
    expect(challenge).toBe(pkceChallenge(verifier));
  });

  it('scrypt: verifica la contraseña correcta y rechaza la incorrecta', async () => {
    const h = await hashPassword('una frase larga de prueba');
    expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('una frase larga de prueba', h)).toBe(true);
    expect(await verifyPassword('otra', h)).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$1$1$a$b')).toBe(false); // parámetros débiles: rechazado
  });
});
