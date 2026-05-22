import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { zeroBuiltInGenerationAcceptedResponseSchema } from "./zero-built-in-generation";

const c = initContract();

export const zeroVideoIoGenerateRequestSchema = z
  .object({
    prompt: z.unknown().optional(),
    model: z.unknown().optional(),
    aspectRatio: z.unknown().optional(),
    duration: z.unknown().optional(),
    resolution: z.unknown().optional(),
    generateAudio: z.unknown().optional(),
    negativePrompt: z.unknown().optional(),
    seed: z.unknown().optional(),
    autoFix: z.unknown().optional(),
    safetyTolerance: z.unknown().optional(),
    imageUrls: z.unknown().optional(),
    videoUrls: z.unknown().optional(),
    audioUrls: z.unknown().optional(),
    referenceImageUrls: z.unknown().optional(),
    referenceVideoUrls: z.unknown().optional(),
    referenceAudioUrls: z.unknown().optional(),
    firstFrameImageUrl: z.unknown().optional(),
    lastFrameImageUrl: z.unknown().optional(),
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
