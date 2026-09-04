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

export const introVideoPresenterContract = c.router({
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
