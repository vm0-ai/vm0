import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testBillingStatusStateErrorSchema = z.object({
  error: z.string(),
});

export const testBillingStatusStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  expires_record_ids: z.array(z.string()),
});

const subscriptionSeedSchema = z.object({
  tier: z.string(),
  status: z.string(),
  current_period_end: z.string(),
  cancel_at_period_end: z.boolean().optional(),
  stripe_customer_id: z.string().optional(),
  stripe_subscription_id: z.string().optional(),
  pending_subscription_schedule_id: z.string().optional(),
  pending_subscription_target_tier: z.string().optional(),
  pending_subscription_change_at: z.string().optional(),
});

const expiresRecordSeedSchema = z.object({
  source: z.string(),
  amount: z.number(),
  remaining: z.number().optional(),
  expires_at: z.string(),
  stripe_invoice_id: z.string().optional(),
});

const concurrencyEntitlementSeedSchema = z.object({
  slots: z.number(),
  starts_at: z.string(),
  expires_at: z.string(),
  subscription_status: z.string().optional(),
  cancel_at_period_end: z.boolean().optional(),
  stripe_subscription_id: z.string().optional(),
  stripe_invoice_id: z.string().optional(),
  stripe_invoice_line_id: z.string().optional(),
  stripe_price_id: z.string().optional(),
});

export const testBillingStatusStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-org"),
      org_id: z.string().optional(),
      user_id: z.string().optional(),
      credits: z.number().optional(),
      onboarding_payment_pending: z.boolean().optional(),
      tier: z.string().optional(),
      stripe_customer_id: z.string().nullable().optional(),
      stripe_subscription_id: z.string().nullable().optional(),
      subscription_status: z.string().nullable().optional(),
      current_period_end: z.string().nullable().optional(),
      cancel_at_period_end: z.boolean().optional(),
      pending_subscription_schedule_id: z.string().nullable().optional(),
      pending_subscription_target_tier: z.string().nullable().optional(),
      pending_subscription_change_at: z.string().nullable().optional(),
      subscription: subscriptionSeedSchema.optional(),
      expires_records: z.array(expiresRecordSeedSchema).optional(),
      concurrency_entitlements: z
        .array(concurrencyEntitlementSeedSchema)
        .optional(),
      extra_granted_credits: z.number().optional(),
    }),
    z.object({
      action: z.literal("delete-org"),
      fixture: testBillingStatusStateFixtureSchema,
    }),
  ],
);

export const testBillingStatusStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testBillingStatusStateFixtureSchema.optional(),
});

export const testBillingStatusStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/billing-status-state/action",
    body: testBillingStatusStateActionBodySchema,
    responses: {
      200: testBillingStatusStateActionResponseSchema,
      400: testBillingStatusStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate billing status API test support state",
  },
});

export type TestBillingStatusStateContract =
  typeof testBillingStatusStateContract;
export type TestBillingStatusStateFixture = z.infer<
  typeof testBillingStatusStateFixtureSchema
>;
export type TestBillingStatusStateActionBody = z.infer<
  typeof testBillingStatusStateActionBodySchema
>;
export type TestBillingStatusStateActionResponse = z.infer<
  typeof testBillingStatusStateActionResponseSchema
>;
