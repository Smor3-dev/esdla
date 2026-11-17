/**
 * Logs estructurados (JSON, una línea) con redacción automática de secretos.
 * Netlify los muestra en Logs → Functions. Nunca se loguean tokens, claves,
 * cookies, firmas ni datos personales.
 */
const SENSITIVE = /(token|secret|password|passwd|authorization|cookie|signature|api[-_]?key|client[-_]?secret|code_verifier|customer|phone|email|address)/i;
const MAX_STRING = 300;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[profundidad]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[redactado]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

type Level = 'info' | 'warn' | 'error' | 'security';

function write(level: Level, event: string, data?: Record<string, unknown>) {
  if (process.env.LOG_LEVEL === 'silent') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...(redact(data ?? {}) as object) });
  if (level === 'error' || level === 'security') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, data?: Record<string, unknown>) => write('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => write('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => write('error', event, data),
  /** Eventos de seguridad: firmas inválidas, montos que no coinciden, IPs no permitidas, etc. */
  security: (event: string, data?: Record<string, unknown>) => write('security', event, data),
};
