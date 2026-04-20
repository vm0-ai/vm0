import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const audioInputQuotaResponseSchema = z.object({
  allowed: z.boolean(),
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive().nullable(),
});
export type AudioInputQuotaResponse = z.infer<
  typeof audioInputQuotaResponseSchema
>;

/**
 * Zero contract for GET /api/zero/voice-io/quota
 *
 * Returns the current audio input quota state for the authenticated org/user.
 * Used by the platform to drive mic-button gating without firing a doomed STT
 * request when a free-tier user has exhausted their quota.
 */
export const zeroVoiceIoQuotaContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/voice-io/quota",
    headers: authHeadersSchema,
    responses: {
      200: audioInputQuotaResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get audio input quota for current org/user",
  },
});

export type ZeroVoiceIoQuotaContract = typeof zeroVoiceIoQuotaContract;
