import { z } from "zod";

import { initContract } from "./base";
import { stripeInvoicePaidEventConfigSchema } from "./zero-workflows";

const c = initContract();

export const testStripeInvoicePaidReadinessActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("seed-connection"),
      org_id: z.string(),
      user_id: z.string(),
      auth_method: z.enum(["api-token", "cli", "oauth"]),
      storage_compatible: z.boolean().optional(),
      external_id: z.string().nullable().optional(),
      needs_reconnect: z.boolean().optional(),
      livemode: z.string().nullable().optional(),
    }),
    z.object({
      action: z.literal("update-connection"),
      connector_id: z.uuid(),
      external_id: z.string().nullable().optional(),
      needs_reconnect: z.boolean().optional(),
      livemode: z.string().nullable().optional(),
    }),
    z.object({
      action: z.literal("delete-connection"),
      connector_id: z.uuid(),
    }),
    z.object({
      action: z.literal("resolve-binding"),
      org_id: z.string(),
      user_id: z.string(),
    }),
    z.object({
      action: z.literal("validate-binding"),
      org_id: z.string(),
      user_id: z.string(),
      event_config: stripeInvoicePaidEventConfigSchema,
    }),
  ]);
export type TestStripeInvoicePaidReadinessActionBody = z.infer<
  typeof testStripeInvoicePaidReadinessActionBodySchema
>;

const readinessResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    binding: z.object({
      connectorId: z.uuid(),
      stripeAccountId: z.string().min(1),
      mode: z.literal("live"),
    }),
  }),
  z.object({
    kind: z.literal("bad_request"),
    message: z.string().min(1),
  }),
]);

export const testStripeInvoicePaidReadinessActionResponseSchema = z.object({
  ok: z.literal(true),
  connector_id: z.uuid().optional(),
  readiness: readinessResultSchema.optional(),
});
export type TestStripeInvoicePaidReadinessActionResponse = z.infer<
  typeof testStripeInvoicePaidReadinessActionResponseSchema
>;

export const testStripeInvoicePaidReadinessContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/stripe-invoice-paid-readiness/action",
    body: testStripeInvoicePaidReadinessActionBodySchema,
    responses: {
      200: testStripeInvoicePaidReadinessActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Exercise Stripe invoice-paid readiness in API tests",
  },
});
