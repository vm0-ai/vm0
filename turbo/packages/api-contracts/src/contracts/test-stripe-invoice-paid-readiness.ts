import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testStripeInvoicePaidFixtureStateSchema = z.enum([
  "storage-incompatible",
  "needs-reconnect",
  "missing-external-id",
  "blank-external-id",
  "missing-livemode",
  "malformed-livemode",
]);
export type TestStripeInvoicePaidFixtureState = z.infer<
  typeof testStripeInvoicePaidFixtureStateSchema
>;

export const testStripeInvoicePaidFixtureContract = c.router({
  apply: {
    method: "POST",
    path: "/api/test/stripe-invoice-paid-fixture",
    body: z
      .object({
        connector_id: z.uuid(),
        state: testStripeInvoicePaidFixtureStateSchema,
      })
      .strict(),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Inject an unconstructible Stripe connector state for API tests",
  },
});
