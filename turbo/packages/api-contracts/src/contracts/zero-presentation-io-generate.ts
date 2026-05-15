import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroPresentationIoGenerateRequestSchema = z
  .object({
    prompt: z.unknown().optional(),
    style: z.unknown().optional(),
    slideCount: z.unknown().optional(),
    imageCount: z.unknown().optional(),
    imageModel: z.unknown().optional(),
    theme: z.unknown().optional(),
    audience: z.unknown().optional(),
    title: z.unknown().optional(),
  })
  .passthrough();

export const zeroPresentationIoUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

export const zeroPresentationIoGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  creditsCharged: z.number(),
  model: z.string(),
  style: z.string(),
  theme: z.string(),
  slideCount: z.number(),
  imageCount: z.number(),
  imageModel: z.string(),
  imageUrls: z.array(z.string()),
  imageCreditsCharged: z.number(),
  textCreditsCharged: z.number(),
  title: z.string(),
  responseId: z.string().optional(),
  usage: zeroPresentationIoUsageSchema,
});

export type ZeroPresentationIoGenerateRequest = z.infer<
  typeof zeroPresentationIoGenerateRequestSchema
>;
export type ZeroPresentationIoGenerateResponse = z.infer<
  typeof zeroPresentationIoGenerateResponseSchema
>;

export const zeroPresentationIoGenerateContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/presentation-io/generate",
    headers: authHeadersSchema,
    body: zeroPresentationIoGenerateRequestSchema,
    responses: {
      200: zeroPresentationIoGenerateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Generate and persist an HTML presentation file",
  },
});

export type ZeroPresentationIoGenerateContract =
  typeof zeroPresentationIoGenerateContract;
