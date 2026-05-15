import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { ablyTokenRequestSchema } from "./realtime";

const c = initContract();

export const zeroBuiltInGenerationTypeSchema = z.enum([
  "image",
  "video",
  "presentation",
]);

export const zeroBuiltInGenerationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);

export const zeroBuiltInGenerationRealtimeSubscriptionSchema = z.object({
  channelName: z.string(),
  eventName: z.string(),
  tokenRequest: ablyTokenRequestSchema,
});

export const zeroBuiltInGenerationAcceptedResponseSchema = z.object({
  generationId: z.string().uuid(),
  type: zeroBuiltInGenerationTypeSchema,
  status: z.literal("queued"),
  realtime: zeroBuiltInGenerationRealtimeSubscriptionSchema,
});

export const zeroBuiltInGenerationErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
});

export const zeroBuiltInGenerationResponseSchema = z.object({
  generationId: z.string().uuid(),
  type: zeroBuiltInGenerationTypeSchema,
  status: zeroBuiltInGenerationStatusSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  error: zeroBuiltInGenerationErrorSchema.optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export type ZeroBuiltInGenerationType = z.infer<
  typeof zeroBuiltInGenerationTypeSchema
>;
export type ZeroBuiltInGenerationStatus = z.infer<
  typeof zeroBuiltInGenerationStatusSchema
>;
export type ZeroBuiltInGenerationRealtimeSubscription = z.infer<
  typeof zeroBuiltInGenerationRealtimeSubscriptionSchema
>;
export type ZeroBuiltInGenerationAcceptedResponse = z.infer<
  typeof zeroBuiltInGenerationAcceptedResponseSchema
>;
export type ZeroBuiltInGenerationResponse = z.infer<
  typeof zeroBuiltInGenerationResponseSchema
>;

export const zeroBuiltInGenerationContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/built-in-generations/:generationId",
    headers: authHeadersSchema,
    pathParams: z.object({
      generationId: z.string().uuid(),
    }),
    responses: {
      200: zeroBuiltInGenerationResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get a built-in generation job",
  },
});

export type ZeroBuiltInGenerationContract =
  typeof zeroBuiltInGenerationContract;
