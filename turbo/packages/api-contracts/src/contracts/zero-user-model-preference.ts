import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { supportedRunModelSchema } from "./model-providers";

const c = initContract();

export const userModelPreferenceResponseSchema = z.object({
  selectedModel: supportedRunModelSchema.nullable(),
  updatedAt: z.string().nullable(),
});

export type UserModelPreferenceResponse = z.infer<
  typeof userModelPreferenceResponseSchema
>;

export const updateUserModelPreferenceRequestSchema = z.object({
  selectedModel: supportedRunModelSchema.nullable(),
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
