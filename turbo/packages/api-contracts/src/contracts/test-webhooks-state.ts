import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testWebhooksStateErrorSchema = z.object({
  error: z.string(),
});

const orgCleanupRowsSchema = z.object({
  cache: z.array(z.object({ org_id: z.string() })),
  metadata: z.array(
    z.object({
      stripe_customer_id: z.string().nullable(),
      stripe_subscription_id: z.string().nullable(),
    }),
  ),
  members: z.array(z.object({ user_id: z.string() })),
});

const concurrencyEntitlementRowSchema = z.object({
  stripe_invoice_line_id: z.string(),
  stripe_subscription_id: z.string(),
  slots: z.number(),
  starts_at: z.string(),
  expires_at: z.string(),
});

const concurrencySubscriptionRowSchema = z.object({
  stripe_subscription_id: z.string(),
  slots: z.number(),
  subscription_status: z.string(),
  current_period_end: z.string().nullable(),
  cancel_at_period_end: z.boolean(),
});

const billingStateSchema = z.object({
  stripe_subscription_id: z.string().nullable(),
  concurrency_entitlements: z.array(concurrencyEntitlementRowSchema),
  concurrency_subscriptions: z.array(concurrencySubscriptionRowSchema),
});

export const testWebhooksStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("expire-atom-grants"),
      org_id: z.string(),
      expired_at: z.string(),
    }),
    z.object({
      action: z.literal("read-org-cleanup"),
      org_id: z.string(),
    }),
    z.object({
      action: z.literal("seed-org-member"),
      org_id: z.string(),
      user_id: z.string(),
      role: z.string(),
      cached_at: z.string(),
    }),
    z.object({
      action: z.literal("read-billing-state"),
      org_id: z.string(),
      stripe_subscription_id: z.string().optional(),
    }),
  ],
);

export const testWebhooksStateActionResponseSchema = z.object({
  ok: z.literal(true),
  org_cleanup: orgCleanupRowsSchema.optional(),
  billing_state: billingStateSchema.optional(),
});

export const testWebhooksStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/webhooks-state/action",
    body: testWebhooksStateActionBodySchema,
    responses: {
      200: testWebhooksStateActionResponseSchema,
      400: testWebhooksStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read webhook API test support state",
  },
});

export type TestWebhooksStateContract = typeof testWebhooksStateContract;
export type TestWebhooksStateActionBody = z.infer<
  typeof testWebhooksStateActionBodySchema
>;
export type TestWebhooksStateActionResponse = z.infer<
  typeof testWebhooksStateActionResponseSchema
>;
export type TestWebhooksStateOrgCleanupRows = z.infer<
  typeof orgCleanupRowsSchema
>;
export type TestWebhooksStateBillingState = z.infer<typeof billingStateSchema>;
