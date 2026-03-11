import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Onboarding status response schema
 */
export const onboardingStatusResponseSchema = z.object({
  needsOnboarding: z.boolean(),
  hasScope: z.boolean(),
  hasModelProvider: z.boolean(),
  hasDefaultAgent: z.boolean(),
  defaultAgentName: z.string().nullable(),
  defaultAgentComposeId: z.string().nullable(),
  defaultAgentMetadata: z
    .object({
      displayName: z.string().optional(),
      sound: z.string().optional(),
    })
    .nullable(),
});

export type OnboardingStatusResponse = z.infer<
  typeof onboardingStatusResponseSchema
>;

/**
 * Onboarding status contract for GET /api/onboarding/status
 */
export const onboardingStatusContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/onboarding/status",
    headers: authHeadersSchema,
    responses: {
      200: onboardingStatusResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Get onboarding status for current user",
  },
});

export type OnboardingStatusContract = typeof onboardingStatusContract;
