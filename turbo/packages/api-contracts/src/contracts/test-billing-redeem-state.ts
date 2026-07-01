import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testBillingRedeemStateErrorSchema = z.object({
  error: z.string(),
});

export const testBillingRedeemStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
});

export const testBillingRedeemStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-org"),
      stripe_customer_id: z.string().nullable().optional(),
    }),
    z.object({
      action: z.literal("delete-org"),
      fixture: testBillingRedeemStateFixtureSchema,
    }),
    z.object({
      action: z.literal("seed-org-promo-redemption"),
      org_id: z.string(),
      campaign_key: z.string(),
      stripe_session_id: z.string(),
    }),
    z.object({
      action: z.literal("read-org-promo-redemption"),
      org_id: z.string(),
      campaign_key: z.string(),
    }),
    z.object({
      action: z.literal("seed-credit-expires-record"),
      org_id: z.string(),
      source: z.string(),
      stripe_invoice_id: z.string(),
      amount: z.number(),
      expires_at: z.string(),
    }),
  ],
);

export const testBillingRedeemStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testBillingRedeemStateFixtureSchema.optional(),
  promo_redemption: z
    .object({
      stripe_session_id: z.string(),
    })
    .optional(),
});

export const testBillingRedeemStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/billing-redeem-state/action",
    body: testBillingRedeemStateActionBodySchema,
    responses: {
      200: testBillingRedeemStateActionResponseSchema,
      400: testBillingRedeemStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate billing redeem API test support state",
  },
});

export type TestBillingRedeemStateContract =
  typeof testBillingRedeemStateContract;
export type TestBillingRedeemStateFixture = z.infer<
  typeof testBillingRedeemStateFixtureSchema
>;
export type TestBillingRedeemStateActionBody = z.infer<
  typeof testBillingRedeemStateActionBodySchema
>;
export type TestBillingRedeemStateActionResponse = z.infer<
  typeof testBillingRedeemStateActionResponseSchema
>;
