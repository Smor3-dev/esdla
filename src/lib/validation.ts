/**
 * Esquemas de validación estrictos (zod). Todo lo que entra desde el navegador
 * o desde un webhook pasa por acá: se rechazan claves desconocidas, tipos
 * incorrectos, largos excesivos y caracteres de control.
 */
import { z } from 'zod';

/** Normaliza texto libre: NFC, sin caracteres de control ni < >, espacios colapsados. */
export function sanitizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') // control, formato (zero-width, bidi), separadores
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const cleanText = (min: number, max: number, pattern: RegExp) =>
  z
    .string()
    .max(max * 2)
    .transform(sanitizeText)
    .pipe(z.string().min(min).max(max).regex(pattern));

export const skuSchema = z.string().regex(/^[A-Z0-9-]{2,32}$/);

/** Celulares (09X XXX XXX) y fijos (2XXX XXXX / 4XXX XXXX) de Uruguay → +598XXXXXXXX. */
export const uyPhoneSchema = z
  .string()
  .max(30)
  .transform((raw, ctx) => {
    let digits = raw.replace(/[\s().-]/g, '');
    if (digits.startsWith('+598')) digits = digits.slice(4);
    else if (digits.startsWith('00598')) digits = digits.slice(5);
    else if (digits.startsWith('598') && digits.length === 11) digits = digits.slice(3);
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (!/^(9\d{7}|[24]\d{7})$/.test(digits)) {
      ctx.addIssue({ code: 'custom', message: 'Teléfono uruguayo inválido' });
      return z.NEVER;
    }
    return `+598${digits}`;
  });

const itemsSchema = z
  .array(z.strictObject({ sku: skuSchema, quantity: z.number().int().min(1).max(20) }))
  .min(1)
  .max(10)
  .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, 'SKU repetido');

export const checkoutSchema = z
  .strictObject({
    items: itemsSchema,
    customer: z.strictObject({
      name: cleanText(2, 80, /^[\p{L}\p{M}' .-]+$/u),
      phone: uyPhoneSchema,
      delivery: z.enum(['retiro', 'envio']),
      address: cleanText(5, 160, /^[\p{L}\p{M}\p{N} ,.#°º/()'-]+$/u).optional(),
      notes: cleanText(0, 300, /^[^<>]*$/).optional(),
    }),
  })
  .superRefine((v, ctx) => {
    if (v.customer.delivery === 'envio' && !v.customer.address) {
      ctx.addIssue({ code: 'custom', path: ['customer', 'address'], message: 'Falta la dirección' });
    }
  });
export type CheckoutInput = z.output<typeof checkoutSchema>;

export const posChargeSchema = z.strictObject({
  items: itemsSchema,
  method: z.enum(['qr_static', 'qr_dynamic', 'point']),
});
export type PosChargeInput = z.output<typeof posChargeSchema>;

export const loginSchema = z.strictObject({ password: z.string().min(1).max(200) });

export const stockAdjustSchema = z.strictObject({ stock: z.number().int().min(0).max(100000) });

export const mlMappingSchema = z.strictObject({
  mlItemId: z.string().regex(/^MLU\d{6,15}$/),
  mlVariationId: z.number().int().positive().nullable().optional(),
});

export const posSetupSchema = z.strictObject({
  storeName: cleanText(2, 60, /^[\p{L}\p{M}\p{N} .&'-]+$/u),
  streetName: cleanText(2, 80, /^[\p{L}\p{M}\p{N} .'-]+$/u),
  streetNumber: z.string().regex(/^\d{1,6}$/),
  cityName: cleanText(2, 60, /^[\p{L}\p{M} .'-]+$/u),
  stateName: cleanText(2, 60, /^[\p{L}\p{M} .'-]+$/u),
  latitude: z.number().min(-35.2).max(-30),   // Uruguay
  longitude: z.number().min(-58.6).max(-53),
  reference: cleanText(0, 80, /^[^<>]*$/).optional(),
});

/** Referencia pública de una orden (external_reference en Mercado Pago). */
export const publicRefSchema = z.string().regex(/^[WP]-[0-9A-HJKMNP-TV-Z]{26}$/);
export const uuidSchema = z.uuid();
export const mpOrderIdSchema = z.string().regex(/^ORD[A-Z0-9]{10,60}$/i);
