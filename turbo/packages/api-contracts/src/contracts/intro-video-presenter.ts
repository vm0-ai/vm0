import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { builtInGenerationAcceptedResponseSchema } from "./built-in-generation";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const introVideoPresenterAvatarIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const introVideoVoiceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const introVideoVoiceSchema = z.object({
  id: introVideoVoiceIdSchema,
  name: z.string().trim().min(1),
  sampleUrl: z.url().optional(),
  language: z.string().trim().min(1).optional(),
  gender: z.enum(["female", "male"]).optional(),
});

export const introVideoVoicesQuerySchema = z.object({
  token: z.string().trim().min(1).max(2_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  language: z.string().trim().min(1).max(100).optional(),
  gender: z.enum(["female", "male"]).optional(),
});

export const introVideoVoicesResponseSchema = z.object({
  voices: z.array(introVideoVoiceSchema),
  hasMore: z.boolean(),
  nextToken: z.string().nullable(),
});

export const introVideoVoiceGenerateRequestSchema = z.object({
  voiceId: introVideoVoiceIdSchema,
  text: z.string().trim().min(1).max(5_000),
});

/**
 * Internal narration audio used only while composing Intro Video.
 * Provider request identifiers and temporary provider URLs stay private.
 */
export const introVideoVoiceGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.enum(["audio/mpeg", "audio/wav"]),
  size: z.number(),
  url: z.string(),
  durationSeconds: z.number(),
  creditsCharged: z.number(),
  voiceId: introVideoVoiceIdSchema,
});

export const introVideoPresenterGenerateRequestSchema = z.object({
  avatarId: introVideoPresenterAvatarIdSchema,
  audioUrl: z.url(),
  videoName: z.string().trim().min(1).optional(),
});

/**
 * Internal transparent presenter take used only while composing Intro Video.
 * Provider job identifiers and temporary provider URLs deliberately stay out
 * of this result.
 */
export const introVideoPresenterGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.literal("video/webm"),
  size: z.number(),
  url: z.string(),
  durationSeconds: z.number(),
  creditsCharged: z.number(),
  avatarId: introVideoPresenterAvatarIdSchema,
});

export type IntroVideoPresenterGenerateRequest = z.infer<
  typeof introVideoPresenterGenerateRequestSchema
>;
export type IntroVideoPresenterGenerateResponse = z.infer<
  typeof introVideoPresenterGenerateResponseSchema
>;
export type IntroVideoVoice = z.infer<typeof introVideoVoiceSchema>;
export type IntroVideoVoicesQuery = z.infer<typeof introVideoVoicesQuerySchema>;
export type IntroVideoVoicesResponse = z.infer<
  typeof introVideoVoicesResponseSchema
>;
export type IntroVideoVoiceGenerateRequest = z.infer<
  typeof introVideoVoiceGenerateRequestSchema
>;
export type IntroVideoVoiceGenerateResponse = z.infer<
  typeof introVideoVoiceGenerateResponseSchema
>;

export const introVideoPresenterContract = c.router({
  voices: {
    method: "GET",
    path: "/api/intro-video/voices",
    headers: authHeadersSchema,
    query: introVideoVoicesQuerySchema,
    responses: {
      200: introVideoVoicesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List public HeyGen voices supported by Intro Video",
  },
  voiceGenerate: {
    method: "POST",
    path: "/api/intro-video/voice/generate",
    headers: authHeadersSchema,
    body: introVideoVoiceGenerateRequestSchema,
    responses: {
      200: introVideoVoiceGenerateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Generate internal HeyGen narration audio for Intro Video",
  },
  generate: {
    method: "POST",
    path: "/api/intro-video/presenter/generate",
    headers: authHeadersSchema,
    body: introVideoPresenterGenerateRequestSchema,
    responses: {
      200: introVideoPresenterGenerateResponseSchema,
      202: builtInGenerationAcceptedResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      504: apiErrorSchema,
    },
    summary: "Generate an internal HeyGen presenter take for Intro Video",
  },
});

export type IntroVideoPresenterContract = typeof introVideoPresenterContract;
