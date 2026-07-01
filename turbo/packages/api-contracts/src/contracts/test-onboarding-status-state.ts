import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testOnboardingStatusStateErrorSchema = z.object({
  error: z.string(),
});

export const testOnboardingStatusStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  compose_id: z.string().nullable(),
});

const defaultAgentSeedSchema = z.object({
  display_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  sound: z.string().nullable().optional(),
});

export const testOnboardingStatusStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-org"),
      default_agent: defaultAgentSeedSchema.optional(),
      onboarding_payment_pending: z.boolean().optional(),
      tier: z.string().optional(),
    }),
    z.object({
      action: z.literal("delete-org"),
      fixture: testOnboardingStatusStateFixtureSchema,
    }),
  ],
);

export const testOnboardingStatusStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testOnboardingStatusStateFixtureSchema.optional(),
});

export const testOnboardingStatusStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/onboarding-status-state/action",
    body: testOnboardingStatusStateActionBodySchema,
    responses: {
      200: testOnboardingStatusStateActionResponseSchema,
      400: testOnboardingStatusStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate onboarding status API test support state",
  },
});

export type TestOnboardingStatusStateContract =
  typeof testOnboardingStatusStateContract;
export type TestOnboardingStatusStateFixture = z.infer<
  typeof testOnboardingStatusStateFixtureSchema
>;
export type TestOnboardingStatusStateActionBody = z.infer<
  typeof testOnboardingStatusStateActionBodySchema
>;
export type TestOnboardingStatusStateActionResponse = z.infer<
  typeof testOnboardingStatusStateActionResponseSchema
>;
