import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testStripeWorkflowEventFixtureActionSchema = z.enum([
  "corrupt-latest-snapshot",
  "hold-latest-claim",
  "expire-latest-retry-window",
  "make-latest-due",
  "fail-next-ingress-for-automation",
  "fail-next-queue-admission-for-automation",
  "clear-forced-failures",
]);
export type TestStripeWorkflowEventFixtureAction = z.infer<
  typeof testStripeWorkflowEventFixtureActionSchema
>;

export const testStripeWorkflowEventFixtureContract = c.router({
  apply: {
    method: "POST",
    path: "/api/test/stripe-workflow-event-fixture",
    body: z
      .object({
        automation_id: z.uuid(),
        action: testStripeWorkflowEventFixtureActionSchema,
      })
      .strict(),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      404: z.string(),
    },
    summary: "Inject an unconstructible Stripe workflow delivery state",
  },
});
