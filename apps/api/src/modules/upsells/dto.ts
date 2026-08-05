import { z } from 'zod';

/**
 * Order bump input.
 *
 * The price is a decimal string for the same reason every other amount in this
 * app is: it is added to an order total the server resolved from Shopify, and a
 * float loses paise on the way.
 */
const money = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Use a number such as 49 or 49.50');

export const CreateOrderBumpSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).nullish(),
  price: money,
  isEnabled: z.boolean().default(true),
  position: z.number().int().min(0).max(100).default(0),
  defaultChecked: z.boolean().default(false),
});

export const UpdateOrderBumpSchema = CreateOrderBumpSchema.partial();

export const OrderBumpParamSchema = z.object({ bumpId: z.string().cuid() });

export type CreateOrderBumpInput = z.infer<typeof CreateOrderBumpSchema>;
export type UpdateOrderBumpInput = z.infer<typeof UpdateOrderBumpSchema>;
