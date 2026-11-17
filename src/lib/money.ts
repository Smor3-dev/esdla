/** Dinero siempre en enteros (centésimos) para evitar errores de punto flotante. */

export function centsToAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Monto inválido');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** "210", "210.5" o "210.50" → 21050. Rechaza cualquier otro formato. */
export function amountToCents(amount: string | number): number {
  const s = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error('Monto inválido');
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

export function formatUyu(cents: number): string {
  return `$ ${new Intl.NumberFormat('es-UY', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(cents / 100)}`;
}
