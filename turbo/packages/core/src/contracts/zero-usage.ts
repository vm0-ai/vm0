import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const memberUsageSchema = z.object({
  userId: z.string(),
  email: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  creditsCharged: z.number(),
  creditCap: z.number().nullable(),
});

const usageMembersResponseSchema = z.object({
  period: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .nullable(),
  members: z.array(memberUsageSchema),
});

/**
 * Zero contract for GET /api/zero/usage/members
 */
export const zeroUsageMembersContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/usage/members",
    headers: authHeadersSchema,
    responses: {
      200: usageMembersResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get per-member usage for current billing period",
  },
});

export type ZeroUsageMembersContract = typeof zeroUsageMembersContract;

// Inferred types from Zod schemas
export type MemberUsage = z.infer<typeof memberUsageSchema>;
export type UsageMembersResponse = z.infer<typeof usageMembersResponseSchema>;
