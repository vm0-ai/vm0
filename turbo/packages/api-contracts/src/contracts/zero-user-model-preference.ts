import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { supportedRunModelSchema } from "./model-providers";
import { chatThreadServiceTierSchema } from "./chat-threads";

const c = initContract();

// PR #26028 rollout compatibility: old web/app clients omit serviceTier in
// requests, while new clients can still receive responses from an old API that
// omits it. Keep the field optional for the ~2-day client-skew window; remove
// after #26028 has been live in production for two days. Follow-up: #26042.
const rolloutCompatibleServiceTierSchema = chatThreadServiceTierSchema
  .nullable()
  .optional();

export const userModelPreferenceResponseSchema = z.object({
  selectedModel: supportedRunModelSchema.nullable(),
  serviceTier: rolloutCompatibleServiceTierSchema,
  updatedAt: z.string().nullable(),
});

export type UserModelPreferenceResponse = z.infer<
  typeof userModelPreferenceResponseSchema
>;

export const updateUserModelPreferenceRequestSchema = z.object({
  selectedModel: supportedRunModelSchema.nullable(),
  serviceTier: rolloutCompatibleServiceTierSchema,
});

export type UpdateUserModelPreferenceRequest = z.infer<
  typeof updateUserModelPreferenceRequestSchema
>;

export const zeroUserModelPreferenceContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/user-model-preference",
    headers: authHeadersSchema,
    responses: {
      200: userModelPreferenceResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user's model-first preference",
  },
  update: {
    method: "PUT",
    path: "/api/zero/user-model-preference",
    headers: authHeadersSchema,
    body: updateUserModelPreferenceRequestSchema,
    responses: {
      200: userModelPreferenceResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update current user's model-first preference",
  },
});

export type ZeroUserModelPreferenceContract =
  typeof zeroUserModelPreferenceContract;
