import { describe, expect, it } from 'vitest';
import { issueCsrf, verifyCsrf, verifyOrigin } from '../../src/lib/csrf.js';
import { HttpError, safeJsonParse } from '../../src/lib/http.js';
import { createSessionCookie, readSession } from '../../src/lib/session.js';

const cookieValue = (setCookie: string) => setCookie.split(';')[0]!;

describe('CSRF (signed double-submit cookie)', () => {
  it('acepta token + cookie emparejados', () => {
    const { token, setCookie } = issueCsrf();
    expect(setCookie).toMatch(/^__Host-esdla_csrf=.+; Path=\/; Secure; SameSite=Strict; Max-Age=7200; HttpOnly$/);
    const req = new Request('https://esdla.test/api/checkout', { method: 'POST', headers: { cookie: cookieValue(setCookie), 'x-csrf-token': token } });
    expect(() => verifyCsrf(req)).not.toThrow();
  });

  it('rechaza sin cookie, sin header o con token de otra cookie', () => {
    const a = issueCsrf();
    const b = issueCsrf();
    const mk = (headers: Record<string, string>) => new Request('https://esdla.test/x', { method: 'POST', headers });
    expect(() => verifyCsrf(mk({ 'x-csrf-token': a.token }))).toThrow(HttpError);
    expect(() => verifyCsrf(mk({ cookie: cookieValue(a.setCookie) }))).toThrow(HttpError);
    expect(() => verifyCsrf(mk({ cookie: cookieValue(a.setCookie), 'x-csrf-token': b.token }))).toThrow(HttpError);
  });

  it('verifica el origen', () => {
    const ok = new Request('https://esdla.test/x', { method: 'POST', headers: { origin: 'https://esdla.test' } });
    const sameSite = new Request('https://esdla.test/x', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    const malo = new Request('https://esdla.test/x', { method: 'POST', headers: { origin: 'https://atacante.example' } });
    const sinNada = new Request('https://esdla.test/x', { method: 'POST' });
    expect(() => verifyOrigin(ok)).not.toThrow();
    expect(() => verifyOrigin(sameSite)).not.toThrow();
    expect(() => verifyOrigin(malo)).toThrow(HttpError);
    expect(() => verifyOrigin(sinNada)).toThrow(HttpError);
  });
});

describe('sesión admin', () => {
  it('cookie firmada, HttpOnly y con vencimiento', () => {
    const c = createSessionCookie();
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    const req = new Request('https://esdla.test/', { headers: { cookie: cookieValue(c) } });
    expect(readSession(req)?.sub).toBe('admin');
    expect(readSession(req, Date.now() + 9 * 3600 * 1000)).toBeNull(); // vencida
  });

  it('rechaza una cookie alterada', () => {
    const value = cookieValue(createSessionCookie());
    const [name, raw] = value.split('=') as [string, string];
    const [body, sig] = raw.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.exp += 999999;
    const forged = `${name}=${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(readSession(new Request('https://esdla.test/', { headers: { cookie: forged } }))).toBeNull();
  });
});

describe('JSON seguro', () => {
  it('descarta claves de prototype pollution', () => {
    const v = safeJsonParse('{"a":1,"__proto__":{"admin":true},"b":{"constructor":{"x":1}}}') as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['a', 'b']);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect((v.b as Record<string, unknown>).constructor).toBe(Object); // la clave no se copió
  });

  it('JSON inválido → 400', () => {
    expect(() => safeJsonParse('{nope')).toThrow(HttpError);
  });
});
