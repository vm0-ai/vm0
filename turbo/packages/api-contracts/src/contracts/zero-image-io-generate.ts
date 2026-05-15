import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroImageIoGenerateRequestSchema = z
  .object({
    prompt: z.unknown().optional(),
    model: z.unknown().optional(),
    size: z.unknown().optional(),
    quality: z.unknown().optional(),
    background: z.unknown().optional(),
    outputFormat: z.unknown().optional(),
    outputCompression: z.unknown().optional(),
    moderation: z.unknown().optional(),
    seed: z.unknown().optional(),
    safetyTolerance: z.unknown().optional(),
    enhancePrompt: z.unknown().optional(),
  })
  .passthrough();

export const zeroImageIoUsageSchema = z.object({
  textInputTokens: z.number(),
  imageInputTokens: z.number(),
  imageOutputTokens: z.number(),
  totalTokens: z.number(),
});

export const zeroImageIoGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  creditsCharged: z.number(),
  model: z.string(),
  provider: z.string(),
  imageSize: z.string(),
  quality: z.string(),
  background: z.string(),
  outputFormat: z.string(),
  outputCompression: z.number().optional(),
  moderation: z.string().optional(),
  safetyTolerance: z.string().optional(),
  revisedPrompt: z.string().optional(),
  usage: zeroImageIoUsageSchema.optional(),
  billingCategory: z.string().optional(),
  billingQuantity: z.number().optional(),
  sourceUrl: z.string().optional(),
  seed: z.number().optional(),
});

export type ZeroImageIoGenerateRequest = z.infer<
  typeof zeroImageIoGenerateRequestSchema
>;
export type ZeroImageIoGenerateResponse = z.infer<
  typeof zeroImageIoGenerateResponseSchema
>;

export const zeroImageIoGenerateContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/image-io/generate",
    headers: authHeadersSchema,
    body: zeroImageIoGenerateRequestSchema,
    responses: {
      200: zeroImageIoGenerateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Generate and persist an image file",
  },
});

export type ZeroImageIoGenerateContract = typeof zeroImageIoGenerateContract;
