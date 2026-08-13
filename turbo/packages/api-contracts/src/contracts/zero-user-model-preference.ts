import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { supportedRunModelSchema } from "./model-providers";
import { VIDEO_MODEL_IDS } from "./video-models";
import { chatThreadServiceTierSchema } from "./chat-threads";

const c = initContract();

/**
 * Member default for built-in video generation. Independent of the run model:
 * it carries no provider routing, no service tier, and no org policy row.
 */
const videoModelPreferenceSchema = z.enum(VIDEO_MODEL_IDS);

export const userModelPreferenceResponseSchema = z.object({
  selectedModel: supportedRunModelSchema.nullable(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  /**
   * Optional so a new bundle can still parse a response from an API that
   * predates the field; the two deploy independently.
   */
  selectedVideoModel: videoModelPreferenceSchema.nullable().optional(),
  updatedAt: z.string().nullable(),
});

export type UserModelPreferenceResponse = z.infer<
  typeof userModelPreferenceResponseSchema
>;

export const updateUserModelPreferenceRequestSchema = z.object({
  selectedModel: supportedRunModelSchema.nullable(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  /**
   * Optional so an older bundle that only knows the run model keeps its stored
   * video default instead of clearing it. Null clears it explicitly.
   */
  selectedVideoModel: videoModelPreferenceSchema.nullable().optional(),
});

export type UpdateUserModelPreferenceRequest = z.infer<
  typeof updateUserModelPreferenceRequestSchema
>;

export const zeroUserModelPreferenceContract = c.router({
  get: {
    method: "GET",
    path: "/api/okou/user-model-preference",
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
    path: "/api/okou/user-model-preference",
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
