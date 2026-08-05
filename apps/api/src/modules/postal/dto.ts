import { z } from 'zod';

/**
 * Postal lookup query.
 *
 * Both bounds matter more than they look. `code` reaches a URL path on a third
 * party's API, so it is restricted to the characters postal codes actually use
 * — letters, digits, spaces and hyphens — rather than trusted to
 * `encodeURIComponent` alone. `country` is two letters because every provider
 * is keyed by ISO alpha-2, and a longer value can only be a mistake or a probe.
 */
export const PostalLookupSchema = z.object({
  shop: z.string().min(3).max(255),
  country: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
  code: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, 'Not a postal code'),
});

export type PostalLookupInput = z.infer<typeof PostalLookupSchema>;
