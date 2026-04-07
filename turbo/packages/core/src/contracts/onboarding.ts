import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Onboarding status response schema
 */
export const onboardingStatusResponseSchema = z.object({
  needsOnboarding: z.boolean(),
  isAdmin: z.boolean(),
  hasOrg: z.boolean(),
  hasDefaultAgent: z.boolean(),
  defaultAgentId: z.string().nullable(),
  defaultAgentMetadata: z
    .object({
      displayName: z.string().optional(),
      description: z.string().optional(),
      sound: z.string().optional(),
    })
    .nullable(),
  defaultAgentSkills: z.array(z.string()),
});

export type OnboardingStatusResponse = z.infer<
  typeof onboardingStatusResponseSchema
>;

/**
 * Onboarding status contract for GET /api/zero/onboarding/status
 */
export const onboardingStatusContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/zero/onboarding/status",
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
    path: "/api/zero/onboarding/complete",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: z.object({ ok: z.boolean() }),
      401: apiErrorSchema,
    },
    summary: "Mark member onboarding as complete",
  },
});

export const onboardingSetupContract = c.router({
  setup: {
    method: "POST",
    path: "/api/zero/onboarding/setup",
    headers: authHeadersSchema,
    body: z.object({
      displayName: z.string(),
      workspaceName: z.string().optional(),
      sound: z.string().optional(),
      avatarUrl: z.string().optional(),
      selectedConnectors: z.array(z.string()).optional(),
    }),
    responses: {
      200: z.object({ agentId: z.string() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: z.object({ agentId: z.string() }),
      422: apiErrorSchema,
    },
    summary: "Complete admin onboarding in a single request",
  },
});

export type OnboardingStatusContract = typeof onboardingStatusContract;
export type OnboardingCompleteContract = typeof onboardingCompleteContract;
export type OnboardingSetupContract = typeof onboardingSetupContract;
