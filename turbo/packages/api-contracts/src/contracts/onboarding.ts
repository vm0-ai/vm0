import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Onboarding status response schema
 */
export const onboardingStatusResponseSchema = z.object({
  needsOnboarding: z.boolean(),
  onboardingComplete: z.boolean(),
  isAdmin: z.boolean(),
  hasOrg: z.boolean(),
  hasDefaultAgent: z.boolean(),
  defaultAgentId: z.string().nullable(),
  defaultAgentMetadata: z
    .object({
      displayName: z.string().optional(),
      description: z.string().optional(),
      sound: z.string().optional(),
      avatarUrl: z.string().optional(),
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

export const onboardingCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/onboarding/complete",
    headers: authHeadersSchema,
    body: z
      .object({
        // Semantic IANA validation happens after core completion so an invalid
        // optional fallback cannot roll back the onboarding transition.
        timezone: z.string().optional(),
      })
      .strict(),
    responses: {
      200: z.object({
        onboardingComplete: z.literal(true),
        needsOnboarding: z.literal(false),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Mark onboarding complete for the current org",
  },
});

export type OnboardingStatusContract = typeof onboardingStatusContract;
export type OnboardingCompleteContract = typeof onboardingCompleteContract;
