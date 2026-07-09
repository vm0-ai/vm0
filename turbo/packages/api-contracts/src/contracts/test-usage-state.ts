import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testUsageStateErrorSchema = z.object({
  error: z.string(),
});

export const testUsageStateActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed-usage-pricing"),
    kind: z.string().min(1).optional(),
    provider: z.string().min(1),
    category: z.string().min(1),
    unit_price: z.number().int().nonnegative(),
    unit_size: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("delete-usage-pricing"),
    kind: z.string().min(1).optional(),
    provider: z.string().min(1),
    category: z.string().min(1),
  }),
  z.object({
    action: z.literal("set-credit-balance"),
    org_id: z.string().min(1),
    credits: z.number().int().nonnegative(),
  }),
]);

export const testUsageStateActionResponseSchema = z.object({
  ok: z.literal(true),
});

export const testUsageStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/usage-state/action",
    body: testUsageStateActionBodySchema,
    responses: {
      200: testUsageStateActionResponseSchema,
      400: testUsageStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate usage API test support state",
  },
});

export type TestUsageStateContract = typeof testUsageStateContract;
export type TestUsageStateActionBody = z.infer<
  typeof testUsageStateActionBodySchema
>;
export type TestUsageStateActionResponse = z.infer<
  typeof testUsageStateActionResponseSchema
>;
