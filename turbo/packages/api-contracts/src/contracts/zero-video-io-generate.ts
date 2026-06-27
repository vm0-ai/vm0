import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { zeroBuiltInGenerationAcceptedResponseSchema } from "./zero-built-in-generation";

const c = initContract();
const stringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);

export const zeroVideoIoGenerateRequestSchema = z
  .object({
    prompt: z.string().optional(),
    model: z.string().optional(),
    aspectRatio: z.string().optional(),
    duration: z.string().optional(),
    resolution: z.string().optional(),
    generateAudio: z.boolean().optional(),
    negativePrompt: z.string().optional(),
    seed: z.number().optional(),
    autoFix: z.boolean().optional(),
    safetyTolerance: z.string().optional(),
    imageUrls: stringOrStringArraySchema.optional(),
    videoUrls: stringOrStringArraySchema.optional(),
    audioUrls: stringOrStringArraySchema.optional(),
    referenceImageUrls: stringOrStringArraySchema.optional(),
    referenceVideoUrls: stringOrStringArraySchema.optional(),
    referenceAudioUrls: stringOrStringArraySchema.optional(),
    firstFrameImageUrl: z.string().optional(),
    lastFrameImageUrl: z.string().optional(),
  })
  .passthrough();

export const zeroVideoIoGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  durationSeconds: z.number(),
  creditsCharged: z.number(),
  model: z.string(),
  aspectRatio: z.string(),
  duration: z.string(),
  resolution: z.string(),
  generateAudio: z.boolean(),
  sourceUrl: z.string(),
  requestId: z.string().optional(),
});

export type ZeroVideoIoGenerateRequest = z.infer<
  typeof zeroVideoIoGenerateRequestSchema
>;
export type ZeroVideoIoGenerateResponse = z.infer<
  typeof zeroVideoIoGenerateResponseSchema
>;

export const zeroVideoIoGenerateContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/video-io/generate",
    headers: authHeadersSchema,
    body: zeroVideoIoGenerateRequestSchema,
    responses: {
      200: zeroVideoIoGenerateResponseSchema,
      202: zeroBuiltInGenerationAcceptedResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      504: apiErrorSchema,
    },
    summary: "Generate and persist a video file",
  },
});

export type ZeroVideoIoGenerateContract = typeof zeroVideoIoGenerateContract;
