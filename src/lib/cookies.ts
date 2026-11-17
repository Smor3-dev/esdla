/** Lectura y escritura de cookies con atributos seguros por defecto. */

export function readCookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  const header = req.headers.get('cookie');
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_\-]+$/.test(name) || value.length > 4096) continue;
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

interface CookieOptions {
  maxAge: number;
  sameSite: 'Strict' | 'Lax';
  httpOnly?: boolean;
}

/**
 * Prefijo __Host-: el navegador exige Secure, Path=/ y sin Domain, así ningún
 * subdominio puede pisar la cookie. Funciona también en http://localhost.
 */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  if (!name.startsWith('__Host-')) throw new Error('Usar prefijo __Host- para cookies de la app');
  if (!/^[A-Za-z0-9_\-.]*$/.test(value)) throw new Error('Valor de cookie inválido');
  const attrs = [`${name}=${value}`, 'Path=/', 'Secure', `SameSite=${opts.sameSite}`, `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`];
  if (opts.httpOnly !== false) attrs.push('HttpOnly');
  return attrs.join('; ');
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}
